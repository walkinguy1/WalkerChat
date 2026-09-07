import 'fake-indexeddb/auto';

import { beforeEach, describe, expect, it } from 'vitest';

import { toBase64 } from '../primitives';
import {
  DecryptionFailure,
  SessionManager,
  bootstrapIdentity,
  replenishOneTimePreKeys,
} from '../session';
import type { IdentityChange } from '../session';
import { CryptoStore, deleteDatabase } from '../store';
import { Directory } from './directory';

const TEST_ITERATIONS = 100;

let counter = 0;

/**
 * One installation: its own vault, identity and device row.
 *
 * Two Clients sharing a `userId` model one account signed in twice, which is the whole
 * point of the multi-device work.
 */
class Client {
  store!: CryptoStore;
  manager!: SessionManager;
  deviceRowId = '';
  identityChanges: IdentityChange[] = [];

  readonly userId: string;
  readonly databaseName: string;

  private constructor(userId: string, databaseName: string) {
    this.userId = userId;
    this.databaseName = databaseName;
  }

  static async create(
    userId: string,
    directory: Directory,
    label = 'primary',
  ): Promise<Client> {
    counter += 1;
    const client = new Client(userId, `session-test-${userId}-${label}-${counter}`);
    await client.open(directory);
    return client;
  }

  async open(directory: Directory): Promise<void> {
    this.store = await CryptoStore.unlock('password for ' + this.databaseName, {
      databaseName: this.databaseName,
      iterations: TEST_ITERATIONS,
    });

    const bootstrap = await bootstrapIdentity(this.store);
    if (bootstrap.publish) {
      this.deviceRowId = directory.publish(this.userId, bootstrap.publish);
    }

    this.manager = new SessionManager({
      store: this.store,
      identity: bootstrap.identity,
      fetchBundle: (userId) => directory.claim(userId),
      onIdentityChange: (change) => this.identityChanges.push(change),
    });
  }

  /** Simulate a page reload: drop everything in memory, reopen from IndexedDB. */
  async reload(directory: Directory): Promise<void> {
    this.store.close();
    await this.open(directory);
  }

  /** Encrypt for every device the peer account has. */
  send(peer: Client, text: string): Promise<Record<string, string>> {
    return this.manager.encryptForUser(peer.userId, text);
  }

  /** Decrypt the envelope addressed to this device. */
  receive(
    sender: Client,
    envelopes: Record<string, string>,
  ): Promise<string> {
    const ciphertext = envelopes[this.deviceRowId];
    if (!ciphertext) {
      throw new Error('No envelope addressed to this device');
    }
    return this.manager.decrypt(
      { userId: sender.userId, deviceRowId: sender.deviceRowId },
      ciphertext,
    );
  }

  close(): void {
    this.store.close();
  }
}

let directory: Directory;

beforeEach(async () => {
  directory = new Directory();
  await deleteDatabase('irrelevant');
});

const pair = async (): Promise<{ alice: Client; bob: Client }> => ({
  alice: await Client.create('alice', directory),
  bob: await Client.create('bob', directory),
});

describe('identity bootstrap', () => {
  it('creates and publishes keys on first run', async () => {
    const { alice } = await pair();
    const bundles = await directory.claim('alice');

    expect(bundles.devices).toHaveLength(1);
    expect(bundles.devices[0].identity_key).toBe(toBase64(alice.manager.identityKey));
    expect(bundles.devices[0].signed_prekey_signature).toBeTruthy();
    expect(bundles.devices[0].one_time_prekey).toBeTruthy();
  });

  it('reuses the existing identity and device id across a reload', async () => {
    const { alice } = await pair();
    const beforeKey = toBase64(alice.manager.identityKey);
    const beforeDevice = alice.deviceRowId;

    await alice.reload(directory);

    expect(toBase64(alice.manager.identityKey)).toBe(beforeKey);
    // A reload must not register a second device, or every peer would see the safety
    // number change on every refresh.
    expect(directory.deviceRowIds('alice')).toHaveLength(1);
    expect(beforeDevice).toBeTruthy();
  });

  it('does not republish when nothing changed', async () => {
    const { alice } = await pair();
    expect((await bootstrapIdentity(alice.store)).publish).toBeNull();
  });
});

describe('messaging', () => {
  it('delivers a first message via X3DH', async () => {
    const { alice, bob } = await pair();
    expect(await bob.receive(alice, await alice.send(bob, 'hello bob'))).toBe('hello bob');
  });

  it('carries a two-way conversation', async () => {
    const { alice, bob } = await pair();
    await bob.receive(alice, await alice.send(bob, 'first'));

    for (let index = 0; index < 5; index += 1) {
      expect(await alice.receive(bob, await bob.send(alice, 'b' + index))).toBe('b' + index);
      expect(await bob.receive(alice, await alice.send(bob, 'a' + index))).toBe('a' + index);
    }
  });

  it('works when the one-time prekey pool is empty', async () => {
    const { alice, bob } = await pair();
    directory.exhaustOneTimePreKeys('bob');

    expect(await bob.receive(alice, await alice.send(bob, 'no opk'))).toBe('no opk');
  });

  it('survives a reload mid-conversation on both sides', async () => {
    const { alice, bob } = await pair();
    await bob.receive(alice, await alice.send(bob, 'before reload'));
    await alice.receive(bob, await bob.send(alice, 'reply'));

    await alice.reload(directory);
    await bob.reload(directory);

    // The old implementation lost the session here, because it lived in a Map.
    expect(await bob.receive(alice, await alice.send(bob, 'after reload'))).toBe('after reload');
  });

  it('handles out-of-order delivery', async () => {
    const { alice, bob } = await pair();
    await bob.receive(alice, await alice.send(bob, 'establish'));

    const first = await alice.send(bob, 'one');
    const second = await alice.send(bob, 'two');
    const third = await alice.send(bob, 'three');

    expect(await bob.receive(alice, third)).toBe('three');
    expect(await bob.receive(alice, first)).toBe('one');
    expect(await bob.receive(alice, second)).toBe('two');
  });

  it('serialises concurrent sends without corrupting the ratchet', async () => {
    const { alice, bob } = await pair();
    await bob.receive(alice, await alice.send(bob, 'establish'));

    // Fired without awaiting in between: without the per-peer queue these would read
    // the same state and one advance would overwrite the other.
    const batches = await Promise.all(
      Array.from({ length: 10 }, (_, index) => alice.send(bob, 'concurrent ' + index)),
    );

    const delivered = new Set<string>();
    for (const envelopes of batches) {
      delivered.add(await bob.receive(alice, envelopes));
    }
    expect(delivered.size).toBe(10);
  });
});

describe('multi-device delivery', () => {
  it('produces one envelope per recipient device', async () => {
    const alice = await Client.create('alice', directory);
    const bobLaptop = await Client.create('bob', directory, 'laptop');
    const bobPhone = await Client.create('bob', directory, 'phone');

    const envelopes = await alice.send(bobLaptop, 'reaches both devices');

    // A pairwise ratchet encrypts to one device's chain, so two devices genuinely need
    // two different ciphertexts.
    expect(Object.keys(envelopes)).toHaveLength(2);
    expect(envelopes[bobLaptop.deviceRowId]).not.toBe(envelopes[bobPhone.deviceRowId]);

    expect(await bobLaptop.receive(alice, envelopes)).toBe('reaches both devices');
    expect(await bobPhone.receive(alice, envelopes)).toBe('reaches both devices');

    [alice, bobLaptop, bobPhone].forEach((client) => client.close());
  });

  it('lets each of a peer device pair reply independently', async () => {
    const alice = await Client.create('alice', directory);
    const bobLaptop = await Client.create('bob', directory, 'laptop');
    const bobPhone = await Client.create('bob', directory, 'phone');

    await bobLaptop.receive(alice, await alice.send(bobLaptop, 'hello'));
    await bobPhone.receive(alice, await alice.send(bobPhone, 'hello again'));

    expect(await alice.receive(bobLaptop, await bobLaptop.send(alice, 'from the laptop'))).toBe(
      'from the laptop',
    );
    expect(await alice.receive(bobPhone, await bobPhone.send(alice, 'from the phone'))).toBe(
      'from the phone',
    );

    [alice, bobLaptop, bobPhone].forEach((client) => client.close());
  });

  it('can exclude a device, so a sender skips its own installation', async () => {
    const laptop = await Client.create('alice', directory, 'laptop');
    const phone = await Client.create('alice', directory, 'phone');

    const envelopes = await laptop.manager.encryptForUser('alice', 'note to self', {
      excludeDeviceRowId: laptop.deviceRowId,
    });

    expect(Object.keys(envelopes)).toEqual([phone.deviceRowId]);
    expect(await phone.receive(laptop, envelopes)).toBe('note to self');

    [laptop, phone].forEach((client) => client.close());
  });

  it('reaches a device added after the conversation started', async () => {
    const alice = await Client.create('alice', directory);
    const bobLaptop = await Client.create('bob', directory, 'laptop');

    await bobLaptop.receive(alice, await alice.send(bobLaptop, 'first'));

    // Bob signs in on a second device mid-conversation.
    const bobPhone = await Client.create('bob', directory, 'phone');
    const envelopes = await alice.send(bobLaptop, 'now on both');

    expect(await bobLaptop.receive(alice, envelopes)).toBe('now on both');
    expect(await bobPhone.receive(alice, envelopes)).toBe('now on both');

    [alice, bobLaptop, bobPhone].forEach((client) => client.close());
  });
});

describe('rejecting anything that does not authenticate', () => {
  it('rejects a forged plaintext-looking payload', async () => {
    const { alice, bob } = await pair();
    await bob.receive(alice, await alice.send(bob, 'establish'));

    // The exact shape the old legacy fallback would have rendered as a real message.
    const forged = toBase64(new TextEncoder().encode('{"body":"injected by the server"}'));
    await expect(
      bob.manager.decrypt({ userId: 'alice', deviceRowId: alice.deviceRowId }, forged),
    ).rejects.toThrow(DecryptionFailure);
  });

  it('rejects a tampered ciphertext', async () => {
    const { alice, bob } = await pair();
    await bob.receive(alice, await alice.send(bob, 'establish'));

    const envelopes = await alice.send(bob, 'authentic');
    const bytes = Uint8Array.from(atob(envelopes[bob.deviceRowId]), (char) =>
      char.charCodeAt(0),
    );
    bytes[bytes.length - 1] ^= 0xff;

    await expect(
      bob.manager.decrypt(
        { userId: 'alice', deviceRowId: alice.deviceRowId },
        toBase64(bytes),
      ),
    ).rejects.toThrow(DecryptionFailure);
  });

  it('rejects a message from an unknown device', async () => {
    const { bob } = await pair();
    await expect(
      bob.manager.decrypt(
        { userId: 'stranger', deviceRowId: 'row-stranger-1' },
        toBase64(new Uint8Array([2, 3, 4])),
      ),
    ).rejects.toThrow(DecryptionFailure);
  });

  it('does not desynchronise the session after a forgery attempt', async () => {
    const { alice, bob } = await pair();
    await bob.receive(alice, await alice.send(bob, 'establish'));

    const good = await alice.send(bob, 'good message');
    const bytes = Uint8Array.from(atob(good[bob.deviceRowId]), (char) => char.charCodeAt(0));
    bytes[bytes.length - 1] ^= 0xff;

    await expect(
      bob.manager.decrypt(
        { userId: 'alice', deviceRowId: alice.deviceRowId },
        toBase64(bytes),
      ),
    ).rejects.toThrow();
    expect(await bob.receive(alice, good)).toBe('good message');
  });

  it('skips a device whose bundle has an invalid signature', async () => {
    const alice = await Client.create('alice', directory);
    const bob = await Client.create('bob', directory);

    const tampering = new Directory();
    const bootstrap = await bootstrapIdentity(bob.store);
    void bootstrap;

    const manager = new SessionManager({
      store: alice.store,
      identity: { publicKey: alice.manager.identityKey, privateKey: new Uint8Array(32) },
      fetchBundle: async () => {
        const bundles = await directory.claim('bob');
        return {
          ...bundles,
          devices: bundles.devices.map((device) => ({
            ...device,
            signed_prekey_signature: toBase64(new Uint8Array(64)),
          })),
        };
      },
    });

    // Every device fails verification, so nothing is encrypted at all.
    expect(await manager.encryptForUser('bob', 'hello')).toEqual({});
    void tampering;

    [alice, bob].forEach((client) => client.close());
  });
});

describe('one-time prekey replenishment', () => {
  it('generates and stores a new batch', async () => {
    const { alice } = await pair();
    const before = await alice.store.countOneTimePreKeys();

    const published = await replenishOneTimePreKeys(alice.store, 10);
    expect(published).toHaveLength(10);
    expect(await alice.store.countOneTimePreKeys()).toBe(before + 10);
  });

  it('produces prekeys that actually complete a handshake', async () => {
    const { alice, bob } = await pair();
    directory.exhaustOneTimePreKeys('bob');

    const bootstrap = await bootstrapIdentity(bob.store);
    directory.addOneTimePreKeys(
      'bob',
      bootstrap.deviceId,
      await replenishOneTimePreKeys(bob.store, 5),
    );

    expect(await bob.receive(alice, await alice.send(bob, 'replenished'))).toBe('replenished');
  });
});
