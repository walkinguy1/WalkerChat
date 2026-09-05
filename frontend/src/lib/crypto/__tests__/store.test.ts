import 'fake-indexeddb/auto';

import { beforeEach, describe, expect, it } from 'vitest';

import { ratchetDecrypt, ratchetEncrypt } from '../doubleRatchet';
import { fromUtf8, generateKeyPair, utf8 } from '../primitives';
import { CryptoStore, deleteDatabase, sessionKey } from '../store';
import {
  createIdentityKeyPair,
  createOneTimePreKeys,
  createSignedPreKey,
} from '../x3dh';
import { Client, connectedPair } from './harness';

// PBKDF2 at the production 600k iterations would dominate the suite runtime. The code
// path is identical; only the cost differs.
const TEST_ITERATIONS = 100;

let databaseCounter = 0;
let databaseName = '';

const unlock = (password = 'correct horse battery staple'): Promise<CryptoStore> =>
  CryptoStore.unlock(password, { databaseName, iterations: TEST_ITERATIONS });

beforeEach(async () => {
  databaseCounter += 1;
  databaseName = 'walkerchat-test-' + databaseCounter;
  await deleteDatabase(databaseName);
});

describe('vault unlocking', () => {
  it('creates a vault on first unlock and reopens it with the same password', async () => {
    const first = await unlock();
    const identity = createIdentityKeyPair();
    await first.saveIdentity(identity);
    first.close();

    const second = await unlock();
    expect((await second.loadIdentity())?.privateKey).toEqual(identity.privateKey);
    second.close();
  });

  it('rejects the wrong password', async () => {
    const store = await unlock('right password');
    store.close();

    await expect(unlock('wrong password')).rejects.toThrow(/Incorrect password/);
  });

  it('refuses to operate once locked', async () => {
    const store = await unlock();
    await store.saveIdentity(createIdentityKeyPair());
    store.lock();

    await expect(store.loadIdentity()).rejects.toThrow(/locked/);
  });

  it('returns null for an identity that was never saved', async () => {
    const store = await unlock();
    expect(await store.loadIdentity()).toBeNull();
    store.close();
  });
});

describe('key material at rest', () => {
  it('does not store the private identity key in the clear', async () => {
    const store = await unlock();
    const identity = createIdentityKeyPair();
    await store.saveIdentity(identity);
    store.close();

    // Read the raw record, bypassing the store, and confirm the private key is absent.
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const open = indexedDB.open(databaseName);
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    const record = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const get = db.transaction('identity', 'readonly').objectStore('identity').get('self');
      get.onsuccess = () => resolve(get.result);
      get.onerror = () => reject(get.error);
    });
    db.close();

    const raw = JSON.stringify(record, (_key, value) =>
      value instanceof Uint8Array ? Array.from(value) : value,
    );
    expect(raw).not.toContain(Array.from(identity.privateKey).join(','));
    expect(raw).toContain(Array.from(identity.publicKey).join(','));
  });
});

describe('signed prekeys', () => {
  it('round-trips a signed prekey with its signature', async () => {
    const store = await unlock();
    const identity = createIdentityKeyPair();
    const signedPreKey = createSignedPreKey(identity, 'spk-1');
    await store.saveSignedPreKey(signedPreKey);

    const loaded = await store.loadSignedPreKey('spk-1');
    expect(loaded?.keyPair.privateKey).toEqual(signedPreKey.keyPair.privateKey);
    expect(loaded?.signature).toEqual(signedPreKey.signature);
    expect(loaded?.createdAt).toBe(signedPreKey.createdAt);
    store.close();
  });

  it('keeps rotated prekeys so in-flight messages still decrypt', async () => {
    const store = await unlock();
    const identity = createIdentityKeyPair();
    for (const keyId of ['spk-1', 'spk-2', 'spk-3']) {
      await store.saveSignedPreKey(createSignedPreKey(identity, keyId));
    }

    expect((await store.listSignedPreKeyIds()).sort()).toEqual(['spk-1', 'spk-2', 'spk-3']);
    expect(await store.loadSignedPreKey('spk-1')).not.toBeNull();
    store.close();
  });

  it('prunes down to the newest N by creation time', async () => {
    const store = await unlock();
    const identity = createIdentityKeyPair();

    for (let index = 1; index <= 4; index += 1) {
      const signedPreKey = createSignedPreKey(identity, 'spk-' + index);
      // Force a deterministic ordering rather than relying on clock resolution.
      await store.saveSignedPreKey({ ...signedPreKey, createdAt: index * 1000 });
    }

    expect(await store.pruneSignedPreKeys(2)).toBe(2);
    expect((await store.listSignedPreKeyIds()).sort()).toEqual(['spk-3', 'spk-4']);
    store.close();
  });

  it('prunes nothing when under the limit', async () => {
    const store = await unlock();
    await store.saveSignedPreKey(createSignedPreKey(createIdentityKeyPair(), 'spk-1'));
    expect(await store.pruneSignedPreKeys(5)).toBe(0);
    store.close();
  });
});

describe('one-time prekeys', () => {
  it('stores a batch and counts it', async () => {
    const store = await unlock();
    let counter = 0;
    await store.saveOneTimePreKeys(
      createOneTimePreKeys(20, () => {
        counter += 1;
        return 'opk-' + counter;
      }),
    );

    expect(await store.countOneTimePreKeys()).toBe(20);
    store.close();
  });

  it('consumes a prekey exactly once', async () => {
    const store = await unlock();
    const preKeys = createOneTimePreKeys(3, (() => {
      let counter = 0;
      return () => {
        counter += 1;
        return 'opk-' + counter;
      };
    })());
    await store.saveOneTimePreKeys(preKeys);

    const taken = await store.takeOneTimePreKey('opk-2');
    expect(taken?.keyPair.privateKey).toEqual(preKeys[1].keyPair.privateKey);

    // A one-time prekey reused is no longer one-time.
    expect(await store.takeOneTimePreKey('opk-2')).toBeNull();
    expect(await store.countOneTimePreKeys()).toBe(2);
    store.close();
  });

  it('returns null for an unknown prekey id', async () => {
    const store = await unlock();
    expect(await store.takeOneTimePreKey('never-existed')).toBeNull();
    store.close();
  });
});

describe('ratchet sessions', () => {
  it('round-trips session state and keeps the ratchet usable', async () => {
    const store = await unlock();
    const { alice, bob } = await connectedPair();
    const message = await alice.send('survives persistence');

    await store.saveSession('alice', alice.identity.publicKey, bob.state!);
    const revived = await store.loadSession('alice', alice.identity.publicKey);
    expect(revived).not.toBeNull();

    // The real assertion: a reloaded session can still decrypt.
    const { plaintext } = await ratchetDecrypt(revived!, message);
    expect(fromUtf8(plaintext)).toBe('survives persistence');
    store.close();
  });

  it('preserves skipped message keys across a reload', async () => {
    const store = await unlock();
    const { alice, bob } = await connectedPair();

    const first = await alice.send('one');
    const second = await alice.send('two');
    await bob.receive(second);

    // Bob now holds a skipped key for `first`. It has to survive the round trip.
    await store.saveSession('alice', alice.identity.publicKey, bob.state!);
    const revived = await store.loadSession('alice', alice.identity.publicKey);

    expect(revived!.skipped.length).toBeGreaterThan(0);
    const { plaintext } = await ratchetDecrypt(revived!, first);
    expect(fromUtf8(plaintext)).toBe('one');
    store.close();
  });

  it('continues sending correctly after a reload', async () => {
    const store = await unlock();
    const { alice, bob } = await connectedPair();

    await store.saveSession('bob', bob.identity.publicKey, alice.state!);
    const revived = await store.loadSession('bob', bob.identity.publicKey);

    const { message } = await ratchetEncrypt(revived!, utf8('sent after reload'));
    expect(await bob.receive(message)).toBe('sent after reload');
    store.close();
  });

  it('keys sessions by peer identity, so a re-registered peer gets a fresh session', async () => {
    const store = await unlock();
    const { alice, bob } = await connectedPair();
    await store.saveSession('bob', bob.identity.publicKey, alice.state!);

    // Bob reinstalls and publishes a new identity key.
    const reinstalled = generateKeyPair().publicKey;
    expect(await store.loadSession('bob', reinstalled)).toBeNull();
    expect(await store.loadSession('bob', bob.identity.publicKey)).not.toBeNull();
    store.close();
  });

  it('deletes a session', async () => {
    const store = await unlock();
    const { alice, bob } = await connectedPair();
    await store.saveSession('bob', bob.identity.publicKey, alice.state!);
    await store.deleteSession('bob', bob.identity.publicKey);

    expect(await store.loadSession('bob', bob.identity.publicKey)).toBeNull();
    store.close();
  });

  it('builds distinct storage keys per peer identity', () => {
    const first = generateKeyPair().publicKey;
    const second = generateKeyPair().publicKey;
    expect(sessionKey('bob', first)).not.toBe(sessionKey('bob', second));
    expect(sessionKey('bob', first)).toBe(sessionKey('bob', first));
  });
});

describe('peer identity tracking', () => {
  it('reports no change the first time a peer is seen', async () => {
    const store = await unlock();
    const bob = new Client('bob');

    const result = await store.rememberPeerIdentity('bob', bob.identity.publicKey);
    expect(result.changed).toBe(false);
    expect(result.previous).toBeNull();
    store.close();
  });

  it('reports no change when the same key is seen again', async () => {
    const store = await unlock();
    const bob = new Client('bob');
    await store.rememberPeerIdentity('bob', bob.identity.publicKey);

    expect((await store.rememberPeerIdentity('bob', bob.identity.publicKey)).changed).toBe(false);
    store.close();
  });

  it('flags a changed identity key', async () => {
    const store = await unlock();
    const bob = new Client('bob');
    await store.rememberPeerIdentity('bob', bob.identity.publicKey);

    // This is the server-swaps-the-key case the UI has to surface.
    const result = await store.rememberPeerIdentity('bob', generateKeyPair().publicKey);
    expect(result.changed).toBe(true);
    expect(result.previous?.identityKey).toEqual(bob.identity.publicKey);
    store.close();
  });

  it('resets trust when the identity key changes', async () => {
    const store = await unlock();
    const bob = new Client('bob');
    await store.rememberPeerIdentity('bob', bob.identity.publicKey);
    await store.setPeerTrusted('bob', true);
    expect((await store.loadPeerIdentity('bob'))?.trusted).toBe(true);

    await store.rememberPeerIdentity('bob', generateKeyPair().publicKey);
    // The old verification was of a different key and cannot carry over.
    expect((await store.loadPeerIdentity('bob'))?.trusted).toBe(false);
    store.close();
  });

  it('keeps trust when the key is unchanged', async () => {
    const store = await unlock();
    const bob = new Client('bob');
    await store.rememberPeerIdentity('bob', bob.identity.publicKey);
    await store.setPeerTrusted('bob', true);
    await store.rememberPeerIdentity('bob', bob.identity.publicKey);

    expect((await store.loadPeerIdentity('bob'))?.trusted).toBe(true);
    store.close();
  });

  it('preserves firstSeen across sightings', async () => {
    const store = await unlock();
    const bob = new Client('bob');
    await store.rememberPeerIdentity('bob', bob.identity.publicKey);
    const first = await store.loadPeerIdentity('bob');

    await store.rememberPeerIdentity('bob', bob.identity.publicKey);
    expect((await store.loadPeerIdentity('bob'))?.firstSeen).toBe(first?.firstSeen);
    store.close();
  });

  it('refuses to set trust for an unknown peer', async () => {
    const store = await unlock();
    await expect(store.setPeerTrusted('stranger', true)).rejects.toThrow(/unknown peer/);
    store.close();
  });
});

describe('clearing the vault', () => {
  it('wipes every store and locks', async () => {
    const store = await unlock();
    const identity = createIdentityKeyPair();
    await store.saveIdentity(identity);
    await store.saveSignedPreKey(createSignedPreKey(identity, 'spk-1'));
    await store.saveOneTimePreKeys(createOneTimePreKeys(5, (() => {
      let counter = 0;
      return () => {
        counter += 1;
        return 'opk-' + counter;
      };
    })()));

    await store.clear();

    const reopened = await unlock();
    expect(await reopened.loadIdentity()).toBeNull();
    expect(await reopened.countOneTimePreKeys()).toBe(0);
    expect(await reopened.listSignedPreKeyIds()).toEqual([]);
    reopened.close();
  });
});
