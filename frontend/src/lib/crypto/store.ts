/**
 * Encrypted persistence for identity keys, prekeys and ratchet sessions.
 *
 * Two things this fixes about the implementation it replaces:
 *
 *  1. Private keys no longer sit in `localStorage` as extractable PKCS#8. Everything
 *     sensitive is sealed under a key derived from the account password, so a stolen
 *     database file is not a stolen identity.
 *  2. Ratchet state survives a reload. The old session cache was an in-memory `Map`,
 *     which meant every refresh silently reset the session.
 *
 * Ratchet state is sealed too, not just the identity key: it holds the root key and
 * chain keys, which are exactly as sensitive as the identity key for reading the
 * current conversation.
 *
 * A note on IndexedDB: a transaction commits as soon as the microtask queue drains
 * without new requests, so awaiting a WebCrypto promise inside one closes it. Every
 * method here does its crypto *before* opening a transaction, and treats the
 * transaction as a short synchronous burst.
 */
import { IV_LEN, fromBase64, randomBytes, toBase64, utf8, wipe } from './primitives';
import { aeadOpen, aeadSeal } from './primitives';
import type { RatchetState } from './doubleRatchet';
import type { IdentityKeyPair, OneTimePreKey, SignedPreKey } from './x3dh';

const DB_NAME = 'walkerchat-crypto';
const DB_VERSION = 1;

const STORE_META = 'meta';
const STORE_IDENTITY = 'identity';
const STORE_SIGNED_PREKEYS = 'signedPreKeys';
const STORE_ONE_TIME_PREKEYS = 'oneTimePreKeys';
const STORE_SESSIONS = 'sessions';
const STORE_PEERS = 'peers';

const ALL_STORES = [
  STORE_META,
  STORE_IDENTITY,
  STORE_SIGNED_PREKEYS,
  STORE_ONE_TIME_PREKEYS,
  STORE_SESSIONS,
  STORE_PEERS,
];

/**
 * OWASP's current floor for PBKDF2-SHA256. Overridable only so tests do not pay it on
 * every case; production callers should leave it alone.
 */
export const DEFAULT_PBKDF2_ITERATIONS = 600_000;

const VERIFIER_PLAINTEXT = utf8('walkerchat-vault-v1');

type SealedBlob = { iv: Uint8Array; ciphertext: Uint8Array };

// --- IndexedDB promise glue ------------------------------------------------

const request = <T>(source: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    source.onsuccess = () => resolve(source.result);
    source.onerror = () => reject(source.error);
  });

const transactionDone = (tx: IDBTransaction): Promise<void> =>
  new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });

export const openDatabase = (name: string = DB_NAME): Promise<IDBDatabase> =>
  new Promise((resolve, reject) => {
    const open = indexedDB.open(name, DB_VERSION);
    open.onupgradeneeded = () => {
      const db = open.result;
      if (!db.objectStoreNames.contains(STORE_META)) {
        db.createObjectStore(STORE_META, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORE_IDENTITY)) {
        db.createObjectStore(STORE_IDENTITY, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORE_SIGNED_PREKEYS)) {
        db.createObjectStore(STORE_SIGNED_PREKEYS, { keyPath: 'keyId' });
      }
      if (!db.objectStoreNames.contains(STORE_ONE_TIME_PREKEYS)) {
        db.createObjectStore(STORE_ONE_TIME_PREKEYS, { keyPath: 'keyId' });
      }
      if (!db.objectStoreNames.contains(STORE_SESSIONS)) {
        db.createObjectStore(STORE_SESSIONS, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORE_PEERS)) {
        db.createObjectStore(STORE_PEERS, { keyPath: 'peerId' });
      }
    };
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });

export const deleteDatabase = (name: string = DB_NAME): Promise<void> =>
  new Promise((resolve, reject) => {
    const drop = indexedDB.deleteDatabase(name);
    drop.onsuccess = () => resolve();
    drop.onerror = () => reject(drop.error);
    drop.onblocked = () => resolve();
  });

// --- ratchet state codec ---------------------------------------------------

/**
 * Ratchet state contains `Uint8Array`s nested in objects and arrays. We encode to JSON
 * with tagged byte arrays rather than relying on structured clone, because the value is
 * sealed as bytes anyway and an explicit codec is far easier to reason about.
 */
const encodeState = (state: RatchetState): Uint8Array =>
  utf8(
    JSON.stringify(state, (_key, value) =>
      value instanceof Uint8Array ? { $bytes: toBase64(value) } : value,
    ),
  );

const decodeState = (bytes: Uint8Array): RatchetState =>
  JSON.parse(new TextDecoder().decode(bytes), (_key, value) => {
    if (value && typeof value === 'object' && typeof (value as { $bytes?: string }).$bytes === 'string') {
      return fromBase64((value as { $bytes: string }).$bytes);
    }
    return value;
  }) as RatchetState;

/**
 * Sessions are keyed by peer *and* peer identity key. Keying by peer alone means that
 * when someone re-registers, the stale session keeps producing ciphertext nobody can
 * read -- which is exactly the failure in the implementation being replaced.
 */
export const sessionKey = (peerId: string, peerIdentityKey: Uint8Array): string =>
  peerId + ':' + toBase64(peerIdentityKey);

// --- the store -------------------------------------------------------------

export type PeerIdentityRecord = {
  peerId: string;
  identityKey: Uint8Array;
  trusted: boolean;
  firstSeen: number;
  lastSeen: number;
};

export class CryptoStore {
  private readonly db: IDBDatabase;
  private masterKey: Uint8Array | null;

  private constructor(db: IDBDatabase, masterKey: Uint8Array) {
    this.db = db;
    this.masterKey = masterKey;
  }

  /**
   * Derive the vault key from the account password, creating the vault on first use.
   *
   * Throws on a wrong password rather than failing later with an opaque decryption
   * error somewhere deep in the ratchet.
   */
  static async unlock(
    password: string,
    options: { databaseName?: string; iterations?: number } = {},
  ): Promise<CryptoStore> {
    const db = await openDatabase(options.databaseName);
    const iterations = options.iterations ?? DEFAULT_PBKDF2_ITERATIONS;

    const readTx = db.transaction(STORE_META, 'readonly');
    const existing = (await request(readTx.objectStore(STORE_META).get('vault'))) as
      | { id: string; salt: Uint8Array; iterations: number; verifier: SealedBlob }
      | undefined;

    if (existing) {
      const masterKey = await deriveMasterKey(password, existing.salt, existing.iterations);
      try {
        await aeadOpen(
          masterKey,
          existing.verifier.iv,
          existing.verifier.ciphertext,
          new Uint8Array(0),
        );
      } catch {
        wipe(masterKey);
        throw new Error('Incorrect password: unable to unlock the key vault.');
      }
      return new CryptoStore(db, masterKey);
    }

    const salt = randomBytes(16);
    const masterKey = await deriveMasterKey(password, salt, iterations);
    const iv = randomBytes(IV_LEN);
    const ciphertext = await aeadSeal(masterKey, iv, VERIFIER_PLAINTEXT, new Uint8Array(0));

    const writeTx = db.transaction(STORE_META, 'readwrite');
    writeTx.objectStore(STORE_META).put({ id: 'vault', salt, iterations, verifier: { iv, ciphertext } });
    await transactionDone(writeTx);

    return new CryptoStore(db, masterKey);
  }

  private key(): Uint8Array {
    if (!this.masterKey) {
      throw new Error('Key vault is locked.');
    }
    return this.masterKey;
  }

  private async seal(plaintext: Uint8Array): Promise<SealedBlob> {
    const iv = randomBytes(IV_LEN);
    return { iv, ciphertext: await aeadSeal(this.key(), iv, plaintext, new Uint8Array(0)) };
  }

  private open(blob: SealedBlob): Promise<Uint8Array> {
    return aeadOpen(this.key(), blob.iv, blob.ciphertext, new Uint8Array(0));
  }

  // --- identity ------------------------------------------------------------

  async saveIdentity(identity: IdentityKeyPair): Promise<void> {
    const wrapped = await this.seal(identity.privateKey);

    const tx = this.db.transaction(STORE_IDENTITY, 'readwrite');
    tx.objectStore(STORE_IDENTITY).put({ id: 'self', publicKey: identity.publicKey, wrapped });
    await transactionDone(tx);
  }

  async loadIdentity(): Promise<IdentityKeyPair | null> {
    const tx = this.db.transaction(STORE_IDENTITY, 'readonly');
    const record = (await request(tx.objectStore(STORE_IDENTITY).get('self'))) as
      | { publicKey: Uint8Array; wrapped: SealedBlob }
      | undefined;
    if (!record) {
      return null;
    }
    return { publicKey: record.publicKey, privateKey: await this.open(record.wrapped) };
  }

  // --- signed prekeys ------------------------------------------------------

  async saveSignedPreKey(signedPreKey: SignedPreKey): Promise<void> {
    const wrapped = await this.seal(signedPreKey.keyPair.privateKey);

    const tx = this.db.transaction(STORE_SIGNED_PREKEYS, 'readwrite');
    tx.objectStore(STORE_SIGNED_PREKEYS).put({
      keyId: signedPreKey.keyId,
      publicKey: signedPreKey.keyPair.publicKey,
      signature: signedPreKey.signature,
      createdAt: signedPreKey.createdAt,
      wrapped,
    });
    await transactionDone(tx);
  }

  async loadSignedPreKey(keyId: string): Promise<SignedPreKey | null> {
    const tx = this.db.transaction(STORE_SIGNED_PREKEYS, 'readonly');
    const record = (await request(tx.objectStore(STORE_SIGNED_PREKEYS).get(keyId))) as
      | {
          keyId: string;
          publicKey: Uint8Array;
          signature: Uint8Array;
          createdAt: number;
          wrapped: SealedBlob;
        }
      | undefined;
    if (!record) {
      return null;
    }
    return {
      keyId: record.keyId,
      keyPair: { publicKey: record.publicKey, privateKey: await this.open(record.wrapped) },
      signature: record.signature,
      createdAt: record.createdAt,
    };
  }

  async listSignedPreKeyIds(): Promise<string[]> {
    const tx = this.db.transaction(STORE_SIGNED_PREKEYS, 'readonly');
    return (await request(tx.objectStore(STORE_SIGNED_PREKEYS).getAllKeys())) as string[];
  }

  /**
   * Drop rotated-out signed prekeys, keeping the newest `keep`.
   *
   * Old private keys have to outlive rotation for a while: a message sent against the
   * previous prekey is still in flight and still has to decrypt.
   */
  async pruneSignedPreKeys(keep: number): Promise<number> {
    const readTx = this.db.transaction(STORE_SIGNED_PREKEYS, 'readonly');
    const records = (await request(readTx.objectStore(STORE_SIGNED_PREKEYS).getAll())) as {
      keyId: string;
      createdAt: number;
    }[];

    const doomed = records
      .sort((left, right) => right.createdAt - left.createdAt)
      .slice(keep)
      .map((record) => record.keyId);

    if (doomed.length === 0) {
      return 0;
    }

    const tx = this.db.transaction(STORE_SIGNED_PREKEYS, 'readwrite');
    const store = tx.objectStore(STORE_SIGNED_PREKEYS);
    doomed.forEach((keyId) => store.delete(keyId));
    await transactionDone(tx);
    return doomed.length;
  }

  // --- one-time prekeys ----------------------------------------------------

  async saveOneTimePreKeys(oneTimePreKeys: OneTimePreKey[]): Promise<void> {
    // Seal everything first; the transaction below must not await anything.
    const records = await Promise.all(
      oneTimePreKeys.map(async (preKey) => ({
        keyId: preKey.keyId,
        publicKey: preKey.keyPair.publicKey,
        wrapped: await this.seal(preKey.keyPair.privateKey),
      })),
    );

    const tx = this.db.transaction(STORE_ONE_TIME_PREKEYS, 'readwrite');
    const store = tx.objectStore(STORE_ONE_TIME_PREKEYS);
    records.forEach((record) => store.put(record));
    await transactionDone(tx);
  }

  /** Fetch and delete a one-time prekey. Returns null if it was already consumed. */
  async takeOneTimePreKey(keyId: string): Promise<OneTimePreKey | null> {
    const readTx = this.db.transaction(STORE_ONE_TIME_PREKEYS, 'readonly');
    const record = (await request(readTx.objectStore(STORE_ONE_TIME_PREKEYS).get(keyId))) as
      | { keyId: string; publicKey: Uint8Array; wrapped: SealedBlob }
      | undefined;
    if (!record) {
      return null;
    }

    const privateKey = await this.open(record.wrapped);

    const deleteTx = this.db.transaction(STORE_ONE_TIME_PREKEYS, 'readwrite');
    deleteTx.objectStore(STORE_ONE_TIME_PREKEYS).delete(keyId);
    await transactionDone(deleteTx);

    return { keyId: record.keyId, keyPair: { publicKey: record.publicKey, privateKey } };
  }

  /** Drives replenishment: the server should never run the pool dry. */
  async countOneTimePreKeys(): Promise<number> {
    const tx = this.db.transaction(STORE_ONE_TIME_PREKEYS, 'readonly');
    return request(tx.objectStore(STORE_ONE_TIME_PREKEYS).count());
  }

  // --- sessions ------------------------------------------------------------

  async saveSession(peerId: string, peerIdentityKey: Uint8Array, state: RatchetState): Promise<void> {
    const encoded = encodeState(state);
    const wrapped = await this.seal(encoded);
    wipe(encoded);

    const tx = this.db.transaction(STORE_SESSIONS, 'readwrite');
    tx.objectStore(STORE_SESSIONS).put({
      id: sessionKey(peerId, peerIdentityKey),
      peerId,
      wrapped,
    });
    await transactionDone(tx);
  }

  async loadSession(peerId: string, peerIdentityKey: Uint8Array): Promise<RatchetState | null> {
    const tx = this.db.transaction(STORE_SESSIONS, 'readonly');
    const record = (await request(
      tx.objectStore(STORE_SESSIONS).get(sessionKey(peerId, peerIdentityKey)),
    )) as { wrapped: SealedBlob } | undefined;
    if (!record) {
      return null;
    }
    return decodeState(await this.open(record.wrapped));
  }

  async deleteSession(peerId: string, peerIdentityKey: Uint8Array): Promise<void> {
    const tx = this.db.transaction(STORE_SESSIONS, 'readwrite');
    tx.objectStore(STORE_SESSIONS).delete(sessionKey(peerId, peerIdentityKey));
    await transactionDone(tx);
  }

  // --- peer trust ----------------------------------------------------------

  /**
   * Record the identity key we have seen for a peer.
   *
   * Returns `changed: true` when the key differs from the one already on file. That is
   * the signal the UI needs for a "safety number changed" warning -- without it, a
   * server swapping keys is completely invisible.
   */
  async rememberPeerIdentity(
    peerId: string,
    identityKey: Uint8Array,
  ): Promise<{ changed: boolean; previous: PeerIdentityRecord | null }> {
    const readTx = this.db.transaction(STORE_PEERS, 'readonly');
    const previous = ((await request(readTx.objectStore(STORE_PEERS).get(peerId))) ??
      null) as PeerIdentityRecord | null;

    const changed =
      previous !== null && toBase64(previous.identityKey) !== toBase64(identityKey);
    const now = Date.now();

    const tx = this.db.transaction(STORE_PEERS, 'readwrite');
    tx.objectStore(STORE_PEERS).put({
      peerId,
      identityKey,
      // A changed key resets trust: the previous verification was of a different key.
      trusted: previous && !changed ? previous.trusted : false,
      firstSeen: previous ? previous.firstSeen : now,
      lastSeen: now,
    });
    await transactionDone(tx);

    return { changed, previous };
  }

  async loadPeerIdentity(peerId: string): Promise<PeerIdentityRecord | null> {
    const tx = this.db.transaction(STORE_PEERS, 'readonly');
    return ((await request(tx.objectStore(STORE_PEERS).get(peerId))) ??
      null) as PeerIdentityRecord | null;
  }

  /** Mark a peer verified after an out-of-band safety number comparison. */
  async setPeerTrusted(peerId: string, trusted: boolean): Promise<void> {
    const existing = await this.loadPeerIdentity(peerId);
    if (!existing) {
      throw new Error('Cannot set trust for an unknown peer: ' + peerId);
    }

    const tx = this.db.transaction(STORE_PEERS, 'readwrite');
    tx.objectStore(STORE_PEERS).put({ ...existing, trusted });
    await transactionDone(tx);
  }

  // --- lifecycle -----------------------------------------------------------

  /** Forget the vault key. Everything on disk stays, but becomes unreadable. */
  lock(): void {
    if (this.masterKey) {
      wipe(this.masterKey);
      this.masterKey = null;
    }
  }

  /** Wipe all key material, for sign-out on a shared machine. */
  async clear(): Promise<void> {
    const tx = this.db.transaction(ALL_STORES, 'readwrite');
    ALL_STORES.forEach((name) => tx.objectStore(name).clear());
    await transactionDone(tx);
    this.lock();
  }

  close(): void {
    this.lock();
    this.db.close();
  }
}

const deriveMasterKey = async (
  password: string,
  salt: Uint8Array,
  iterations: number,
): Promise<Uint8Array> => {
  const material = await crypto.subtle.importKey('raw', utf8(password) as BufferSource, 'PBKDF2', false, [
    'deriveBits',
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations, hash: 'SHA-256' },
    material,
    256,
  );
  return new Uint8Array(bits);
};
