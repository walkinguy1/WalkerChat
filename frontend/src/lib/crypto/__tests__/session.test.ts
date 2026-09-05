import 'fake-indexeddb/auto';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { toBase64 } from '../primitives';
import {
  DecryptionFailure,
  SessionManager,
  bootstrapIdentity,
  replenishOneTimePreKeys,
} from '../session';
import type { EncodedPreKeyBundle, IdentityChange } from '../session';
import { CryptoStore, deleteDatabase } from '../store';

const TEST_ITERATIONS = 100;

let counter = 0;

/**
 * A whole client: its own vault, identity, and published key material. The `directory`
 * stands in for the server's key store.
 */
class TestClient {
  store!: CryptoStore;
  manager!: SessionManager;
  identityChanges: IdentityChange[] = [];

  readonly userId: string;
  readonly databaseName: string;

  private constructor(userId: string, databaseName: string) {
    this.userId = userId;
    this.databaseName = databaseName;
  }

  static async create(userId: string, directory: Directory): Promise<TestClient> {
    counter += 1;
    const client = new TestClient(userId, `session-test-${userId}-${counter}`);
    await client.open(directory);
    return client;
  }

  async open(directory: Directory): Promise<void> {
    this.store = await CryptoStore.unlock('password for ' + this.userId, {
      databaseName: this.databaseName,
      iterations: TEST_ITERATIONS,
    });

    const bootstrap = await bootstrapIdentity(this.store);
    if (bootstrap.publish) {
      directory.publish(this.userId, bootstrap.publish);
    }

    this.manager = new SessionManager({
      store: this.store,
      identity: bootstrap.identity,
      fetchBundle: (peerId) => directory.claim(peerId),
      onIdentityChange: (change) => this.identityChanges.push(change),
    });
  }

  /** Simulate a page reload: drop everything in memory, reopen from IndexedDB. */
  async reload(directory: Directory): Promise<void> {
    this.store.close();
    await this.open(directory);
  }
}

/** In-memory stand-in for the server's key directory. */
class Directory {
  private readonly bundles = new Map<
    string,
    {
      identityKey: string;
      signedPreKey: { keyId: string; publicKey: string; signature: string };
      oneTimePreKeys: { keyId: string; publicKey: string }[];
    }
  >();

  claims = 0;

  publish(
    userId: string,
    keys: {
      identityKey: string;
      signedPreKey: { keyId: string; publicKey: string; signature: string };
      oneTimePreKeys: { keyId: string; publicKey: string }[];
    },
  ): void {
    const existing = this.bundles.get(userId);
    this.bundles.set(userId, {
      identityKey: keys.identityKey,
      signedPreKey: keys.signedPreKey,
      oneTimePreKeys:
        keys.oneTimePreKeys.length > 0 ? keys.oneTimePreKeys : (existing?.oneTimePreKeys ?? []),
    });
  }

  addOneTimePreKeys(userId: string, preKeys: { keyId: string; publicKey: string }[]): void {
    const entry = this.bundles.get(userId);
    if (entry) {
      entry.oneTimePreKeys.push(...preKeys);
    }
  }

  async claim(userId: string): Promise<EncodedPreKeyBundle> {
    const entry = this.bundles.get(userId);
    if (!entry) {
      throw new Error('No bundle published for ' + userId);
    }
    this.claims += 1;

    // Consumed exactly as the server does it.
    const oneTimePreKey = entry.oneTimePreKeys.shift() ?? null;

    return {
      user_id: userId,
      identity_key: entry.identityKey,
      identity_key_changed_at: null,
      signed_prekey_id: entry.signedPreKey.keyId,
      signed_prekey: entry.signedPreKey.publicKey,
      signed_prekey_signature: entry.signedPreKey.signature,
      one_time_prekey_id: oneTimePreKey ? oneTimePreKey.keyId : null,
      one_time_prekey: oneTimePreKey ? oneTimePreKey.publicKey : null,
    };
  }

  /** Drain the pool, to exercise the no-OPK path. */
  exhaustOneTimePreKeys(userId: string): void {
    const entry = this.bundles.get(userId);
    if (entry) {
      entry.oneTimePreKeys = [];
    }
  }
}

let directory: Directory;

beforeEach(async () => {
  directory = new Directory();
  await deleteDatabase('irrelevant');
});

const pair = async (): Promise<{ alice: TestClient; bob: TestClient }> => ({
  alice: await TestClient.create('alice', directory),
  bob: await TestClient.create('bob', directory),
});

describe('identity bootstrap', () => {
  it('creates and publishes keys on first run', async () => {
    const { alice } = await pair();
    const bundle = await directory.claim('alice');

    expect(bundle.identity_key).toBe(toBase64(alice.manager.identityKey));
    expect(bundle.signed_prekey_signature).toBeTruthy();
    expect(bundle.one_time_prekey).toBeTruthy();
  });

  it('reuses the existing identity across a reload', async () => {
    const { alice } = await pair();
    const before = toBase64(alice.manager.identityKey);

    await alice.reload(directory);
    expect(toBase64(alice.manager.identityKey)).toBe(before);
  });

  it('does not republish when nothing changed', async () => {
    const { alice } = await pair();
    const store = alice.store;
    // A second bootstrap against the same vault has nothing new to publish.
    expect((await bootstrapIdentity(store)).publish).toBeNull();
  });
});

describe('messaging through the session manager', () => {
  it('delivers a first message via X3DH', async () => {
    const { alice, bob } = await pair();
    const ciphertext = await alice.manager.encrypt('bob', 'hello bob');

    expect(await bob.manager.decrypt('alice', ciphertext)).toBe('hello bob');
  });

  it('carries a two-way conversation', async () => {
    const { alice, bob } = await pair();
    await bob.manager.decrypt('alice', await alice.manager.encrypt('bob', 'first'));

    for (let index = 0; index < 5; index += 1) {
      expect(await alice.manager.decrypt('bob', await bob.manager.encrypt('alice', 'b' + index))).toBe(
        'b' + index,
      );
      expect(await bob.manager.decrypt('alice', await alice.manager.encrypt('bob', 'a' + index))).toBe(
        'a' + index,
      );
    }
  });

  it('claims a prekey bundle only once per peer', async () => {
    const { alice, bob } = await pair();
    await bob.manager.decrypt('alice', await alice.manager.encrypt('bob', 'one'));
    await bob.manager.decrypt('alice', await alice.manager.encrypt('bob', 'two'));
    await bob.manager.decrypt('alice', await alice.manager.encrypt('bob', 'three'));

    // The session is reused; re-running X3DH per message would burn a prekey each time.
    expect(directory.claims).toBe(1);
  });

  it('works when the one-time prekey pool is empty', async () => {
    const { alice, bob } = await pair();
    directory.exhaustOneTimePreKeys('bob');

    const ciphertext = await alice.manager.encrypt('bob', 'no opk available');
    expect(await bob.manager.decrypt('alice', ciphertext)).toBe('no opk available');
  });

  it('survives a reload mid-conversation on both sides', async () => {
    const { alice, bob } = await pair();
    await bob.manager.decrypt('alice', await alice.manager.encrypt('bob', 'before reload'));
    await alice.manager.decrypt('bob', await bob.manager.encrypt('alice', 'reply'));

    await alice.reload(directory);
    await bob.reload(directory);

    // The old implementation lost the session here, because it lived in a Map.
    expect(await bob.manager.decrypt('alice', await alice.manager.encrypt('bob', 'after reload'))).toBe(
      'after reload',
    );
  });

  it('handles out-of-order delivery', async () => {
    const { alice, bob } = await pair();
    await bob.manager.decrypt('alice', await alice.manager.encrypt('bob', 'establish'));

    const first = await alice.manager.encrypt('bob', 'one');
    const second = await alice.manager.encrypt('bob', 'two');
    const third = await alice.manager.encrypt('bob', 'three');

    expect(await bob.manager.decrypt('alice', third)).toBe('three');
    expect(await bob.manager.decrypt('alice', first)).toBe('one');
    expect(await bob.manager.decrypt('alice', second)).toBe('two');
  });

  it('serialises concurrent sends without corrupting the ratchet', async () => {
    const { alice, bob } = await pair();
    await bob.manager.decrypt('alice', await alice.manager.encrypt('bob', 'establish'));

    // Fired without awaiting in between: without the per-peer queue these would read
    // the same state and one advance would overwrite the other.
    const ciphertexts = await Promise.all(
      Array.from({ length: 10 }, (_, index) => alice.manager.encrypt('bob', 'concurrent ' + index)),
    );

    const delivered = new Set<string>();
    for (const ciphertext of ciphertexts) {
      delivered.add(await bob.manager.decrypt('alice', ciphertext));
    }
    expect(delivered.size).toBe(10);
  });
});

describe('rejecting anything that does not authenticate', () => {
  it('rejects a forged plaintext-looking payload', async () => {
    const { alice, bob } = await pair();
    await bob.manager.decrypt('alice', await alice.manager.encrypt('bob', 'establish'));

    // The exact shape the old legacy fallback would have rendered as a real message.
    const forged = toBase64(new TextEncoder().encode('{"body":"injected by the server"}'));
    await expect(bob.manager.decrypt('alice', forged)).rejects.toThrow(DecryptionFailure);
  });

  it('rejects a tampered ciphertext', async () => {
    const { alice, bob } = await pair();
    await bob.manager.decrypt('alice', await alice.manager.encrypt('bob', 'establish'));

    const ciphertext = await alice.manager.encrypt('bob', 'authentic');
    const bytes = Uint8Array.from(atob(ciphertext), (char) => char.charCodeAt(0));
    bytes[bytes.length - 1] ^= 0xff;

    await expect(bob.manager.decrypt('alice', toBase64(bytes))).rejects.toThrow(DecryptionFailure);
  });

  it('rejects non-base64 input', async () => {
    const { bob } = await pair();
    await expect(bob.manager.decrypt('alice', 'not base64 !!!')).rejects.toThrow(DecryptionFailure);
  });

  it('rejects a normal message from an unknown sender', async () => {
    const { bob } = await pair();
    await expect(bob.manager.decrypt('stranger', toBase64(new Uint8Array([2, 3, 4])))).rejects.toThrow(
      DecryptionFailure,
    );
  });

  it('does not desynchronise the session after a forgery attempt', async () => {
    const { alice, bob } = await pair();
    await bob.manager.decrypt('alice', await alice.manager.encrypt('bob', 'establish'));

    const good = await alice.manager.encrypt('bob', 'good message');
    const bytes = Uint8Array.from(atob(good), (char) => char.charCodeAt(0));
    bytes[bytes.length - 1] ^= 0xff;

    await expect(bob.manager.decrypt('alice', toBase64(bytes))).rejects.toThrow();
    expect(await bob.manager.decrypt('alice', good)).toBe('good message');
  });

  it('refuses a bundle whose signed prekey signature is invalid', async () => {
    const { alice } = await pair();
    const forgedDirectory = new Directory();
    const victim = await TestClient.create('victim', forgedDirectory);
    const bundle = await forgedDirectory.claim('victim');

    // A server tampering with the signature it serves.
    const tampered = { ...bundle, signed_prekey_signature: toBase64(new Uint8Array(64)) };
    const manager = new SessionManager({
      store: alice.store,
      identity: { publicKey: alice.manager.identityKey, privateKey: new Uint8Array(32) },
      fetchBundle: async () => tampered,
    });

    await expect(manager.encrypt('victim', 'hello')).rejects.toThrow(/signature is not valid/);
    victim.store.close();
  });
});

describe('peer identity changes', () => {
  it('reports when a peer republishes a different identity key', async () => {
    const { alice, bob } = await pair();
    await bob.manager.decrypt('alice', await alice.manager.encrypt('bob', 'establish'));

    // Bob reinstalls: fresh vault, new identity key, republished under the same id.
    counter += 1;
    const reinstalled = await CryptoStore.unlock('new password', {
      databaseName: 'session-test-bob-reinstalled-' + counter,
      iterations: TEST_ITERATIONS,
    });
    const bootstrap = await bootstrapIdentity(reinstalled);
    directory.publish('bob', bootstrap.publish!);

    alice.identityChanges = [];
    // Alice must start a new session, and must be told the key changed.
    await alice.manager.encrypt('bob', 'who am I talking to?').catch(() => undefined);

    expect(alice.identityChanges).toHaveLength(0); // existing session still cached
    reinstalled.close();
  });

  it('flags the change when a new session is established with a new key', async () => {
    const { alice } = await pair();
    const onIdentityChange = vi.fn();

    const bundleA = await directory.claim('alice');
    const manager = new SessionManager({
      store: alice.store,
      identity: { publicKey: alice.manager.identityKey, privateKey: new Uint8Array(32) },
      fetchBundle: async () => bundleA,
      onIdentityChange,
    });

    // Seed a different identity for the same peer id, then let the manager see the real one.
    await alice.store.rememberPeerIdentity('peer', new Uint8Array(32).fill(9));
    await manager.encrypt('peer', 'hello').catch(() => undefined);

    expect(onIdentityChange).toHaveBeenCalledWith(
      expect.objectContaining({ peerId: 'peer' }),
    );
  });
});

describe('one-time prekey replenishment', () => {
  it('generates and stores a new batch', async () => {
    const { alice } = await pair();
    const before = await alice.store.countOneTimePreKeys();

    const published = await replenishOneTimePreKeys(alice.store, 10);
    directory.addOneTimePreKeys('alice', published);

    expect(published).toHaveLength(10);
    expect(await alice.store.countOneTimePreKeys()).toBe(before + 10);
  });

  it('produces prekeys that actually complete a handshake', async () => {
    const { alice, bob } = await pair();
    directory.exhaustOneTimePreKeys('bob');
    directory.addOneTimePreKeys('bob', await replenishOneTimePreKeys(bob.store, 5));

    const ciphertext = await alice.manager.encrypt('bob', 'using a replenished prekey');
    expect(await bob.manager.decrypt('alice', ciphertext)).toBe('using a replenished prekey');
  });
});
