/**
 * Session management: the layer the app actually talks to.
 *
 * Everything below this file is pure protocol; everything above it is UI. This is where
 * the two meet -- deciding when to run X3DH, loading and persisting ratchet state, and
 * consuming one-time prekeys.
 *
 * The single most important rule here: **ratchet state is persisted before a plaintext
 * is handed back**. If we returned the plaintext and then failed to save, the next
 * message would be decrypted against stale state and the session would desynchronise
 * permanently.
 */
import {
  initReceiver,
  initSender,
  ratchetDecrypt,
  ratchetEncrypt,
} from './doubleRatchet';
import type { RatchetState } from './doubleRatchet';
import { fromBase64, fromUtf8, toBase64, utf8 } from './primitives';
import { MESSAGE_TYPE_PREKEY, decodeMessage } from './serialization';
import type { CryptoStore } from './store';
import {
  createIdentityKeyPair,
  createOneTimePreKeys,
  createSignedPreKey,
  initiateX3DH,
  respondX3DH,
} from './x3dh';
import type { IdentityKeyPair, OneTimePreKey, PreKeyBundle, SignedPreKey } from './x3dh';

/** How many one-time prekeys to publish at a time. */
export const ONE_TIME_PREKEY_BATCH = 50;

/** Signed prekeys older than this are rotated. */
export const SIGNED_PREKEY_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** How many rotated signed prekeys to keep, so in-flight messages still decrypt. */
const SIGNED_PREKEY_HISTORY = 3;

/** The wire shape of a prekey bundle, as the API returns it (base64 fields). */
export type EncodedPreKeyBundle = {
  user_id: string;
  identity_key: string;
  identity_key_changed_at: string | null;
  signed_prekey_id: string;
  signed_prekey: string;
  signed_prekey_signature: string;
  one_time_prekey_id: string | null;
  one_time_prekey: string | null;
};

export type PublishablePreKeys = {
  identityKey: string;
  signedPreKey: { keyId: string; publicKey: string; signature: string };
  oneTimePreKeys: { keyId: string; publicKey: string }[];
};

const decodeBundle = (bundle: EncodedPreKeyBundle): PreKeyBundle => ({
  identityKey: fromBase64(bundle.identity_key),
  signedPreKeyId: bundle.signed_prekey_id,
  signedPreKey: fromBase64(bundle.signed_prekey),
  signedPreKeySignature: fromBase64(bundle.signed_prekey_signature),
  oneTimePreKeyId: bundle.one_time_prekey_id,
  oneTimePreKey: bundle.one_time_prekey ? fromBase64(bundle.one_time_prekey) : null,
});

const encodeOneTimePreKeys = (preKeys: OneTimePreKey[]) =>
  preKeys.map((preKey) => ({
    keyId: preKey.keyId,
    publicKey: toBase64(preKey.keyPair.publicKey),
  }));

/** Raised when a message cannot be authenticated. Never rendered as text. */
export class DecryptionFailure extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'DecryptionFailure';
  }
}

export type IdentityBootstrap = {
  identity: IdentityKeyPair;
  signedPreKey: SignedPreKey;
  /** Present when there is new material for the server; null when nothing changed. */
  publish: PublishablePreKeys | null;
};

/**
 * Load this device's identity, creating and publishing it on first run.
 *
 * Rotation of the signed prekey happens here too, because it is the one place that
 * reliably runs on every sign-in.
 */
export const bootstrapIdentity = async (store: CryptoStore): Promise<IdentityBootstrap> => {
  const existingIdentity = await store.loadIdentity();

  if (!existingIdentity) {
    const identity = createIdentityKeyPair();
    const signedPreKey = createSignedPreKey(identity, crypto.randomUUID());
    const oneTimePreKeys = createOneTimePreKeys(ONE_TIME_PREKEY_BATCH, () => crypto.randomUUID());

    await store.saveIdentity(identity);
    await store.saveSignedPreKey(signedPreKey);
    await store.saveOneTimePreKeys(oneTimePreKeys);

    return {
      identity,
      signedPreKey,
      publish: {
        identityKey: toBase64(identity.publicKey),
        signedPreKey: {
          keyId: signedPreKey.keyId,
          publicKey: toBase64(signedPreKey.keyPair.publicKey),
          signature: toBase64(signedPreKey.signature),
        },
        oneTimePreKeys: encodeOneTimePreKeys(oneTimePreKeys),
      },
    };
  }

  const signedPreKeyIds = await store.listSignedPreKeyIds();
  const candidates = await Promise.all(
    signedPreKeyIds.map((keyId) => store.loadSignedPreKey(keyId)),
  );
  const newest = candidates
    .filter((candidate): candidate is SignedPreKey => candidate !== null)
    .sort((left, right) => right.createdAt - left.createdAt)[0];

  const isStale = !newest || Date.now() - newest.createdAt > SIGNED_PREKEY_MAX_AGE_MS;
  if (!isStale) {
    return { identity: existingIdentity, signedPreKey: newest, publish: null };
  }

  const rotated = createSignedPreKey(existingIdentity, crypto.randomUUID());
  await store.saveSignedPreKey(rotated);
  // Keep a few generations: a message sent against the previous prekey may still be
  // in flight, and its private half is the only thing that can complete that handshake.
  await store.pruneSignedPreKeys(SIGNED_PREKEY_HISTORY);

  return {
    identity: existingIdentity,
    signedPreKey: rotated,
    publish: {
      identityKey: toBase64(existingIdentity.publicKey),
      signedPreKey: {
        keyId: rotated.keyId,
        publicKey: toBase64(rotated.keyPair.publicKey),
        signature: toBase64(rotated.signature),
      },
      oneTimePreKeys: [],
    },
  };
};

/** Generate and store a fresh batch of one-time prekeys for publication. */
export const replenishOneTimePreKeys = async (
  store: CryptoStore,
  count: number = ONE_TIME_PREKEY_BATCH,
): Promise<{ keyId: string; publicKey: string }[]> => {
  const preKeys = createOneTimePreKeys(count, () => crypto.randomUUID());
  await store.saveOneTimePreKeys(preKeys);
  return encodeOneTimePreKeys(preKeys);
};

export type BundleFetcher = (peerId: string) => Promise<EncodedPreKeyBundle>;

/**
 * Ratchet state plus the peer identity it belongs to.
 *
 * The identity key is what the session is filed under, so carrying it alongside the
 * state keeps every save addressed to the right session even after a DH ratchet step
 * replaces most of the other fields.
 */
export type StoredSession = RatchetState & { peerIdentityKey: Uint8Array };

export type IdentityChange = {
  peerId: string;
  previousIdentityKey: Uint8Array;
  newIdentityKey: Uint8Array;
};

export class SessionManager {
  private readonly store: CryptoStore;
  private readonly identity: IdentityKeyPair;
  private readonly fetchBundle: BundleFetcher;
  private readonly onIdentityChange: (change: IdentityChange) => void;

  /**
   * Serialises operations per peer. Two concurrent sends against one ratchet would
   * both read the same state and one would overwrite the other's advance.
   */
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(options: {
    store: CryptoStore;
    identity: IdentityKeyPair;
    fetchBundle: BundleFetcher;
    onIdentityChange?: (change: IdentityChange) => void;
  }) {
    this.store = options.store;
    this.identity = options.identity;
    this.fetchBundle = options.fetchBundle;
    this.onIdentityChange = options.onIdentityChange ?? (() => {});
  }

  get identityKey(): Uint8Array {
    return this.identity.publicKey;
  }

  /** Run `task` with exclusive access to one peer's ratchet state. */
  private enqueue<T>(peerId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(peerId) ?? Promise.resolve();
    const next = previous.then(task, task);
    // Keep the chain alive after a failure, but do not leave an unhandled rejection.
    this.queues.set(
      peerId,
      next.catch(() => undefined),
    );
    return next;
  }

  /** Encrypt a plaintext string for a peer, establishing a session if needed. */
  encrypt(peerId: string, plaintext: string): Promise<string> {
    return this.enqueue(peerId, async () => {
      const state = await this.loadOrCreateOutbound(peerId);
      const result = await ratchetEncrypt(state, utf8(plaintext));

      const advanced: StoredSession = {
        ...result.state,
        peerIdentityKey: state.peerIdentityKey,
      };
      await this.store.saveSession(peerId, state.peerIdentityKey, advanced);
      return toBase64(result.message);
    });
  }

  /**
   * Decrypt a message from a peer.
   *
   * Throws `DecryptionFailure` for anything that does not authenticate. There is
   * deliberately no fallback that returns the raw bytes as text -- that fallback was
   * the single worst flaw in the implementation this replaces, because it let anyone
   * who could write a message row inject unauthenticated messages.
   */
  decrypt(peerId: string, ciphertextBase64: string): Promise<string> {
    return this.enqueue(peerId, async () => {
      let encoded: Uint8Array;
      try {
        encoded = fromBase64(ciphertextBase64);
      } catch (error) {
        throw new DecryptionFailure('Message is not valid base64.', { cause: error });
      }

      let message;
      try {
        message = decodeMessage(encoded);
      } catch (error) {
        throw new DecryptionFailure('Message is not a valid encrypted envelope.', {
          cause: error,
        });
      }

      if (message.type === MESSAGE_TYPE_PREKEY) {
        return this.decryptPreKeyMessage(peerId, message.prekey, encoded);
      }

      const peer = await this.store.loadPeerIdentity(peerId);
      if (!peer) {
        throw new DecryptionFailure('No session with this sender.');
      }

      const state = await this.store.loadSession(peerId, peer.identityKey);
      if (!state) {
        throw new DecryptionFailure('No session with this sender.');
      }

      return this.advance(
        peerId,
        { ...state, peerIdentityKey: peer.identityKey },
        encoded,
      );
    });
  }

  private async decryptPreKeyMessage(
    peerId: string,
    prekey: { identityKey: Uint8Array; ephemeralKey: Uint8Array; signedPreKeyId: string; oneTimePreKeyId: string | null },
    encoded: Uint8Array,
  ): Promise<string> {
    await this.rememberPeer(peerId, prekey.identityKey);

    const existing = await this.store.loadSession(peerId, prekey.identityKey);
    if (existing) {
      try {
        return await this.advance(
          peerId,
          { ...existing, peerIdentityKey: prekey.identityKey },
          encoded,
        );
      } catch {
        // Fall through: the peer may have started a genuinely new session, for example
        // after reinstalling and republishing prekeys under the same identity key.
      }
    }

    const signedPreKey = await this.store.loadSignedPreKey(prekey.signedPreKeyId);
    if (!signedPreKey) {
      throw new DecryptionFailure(
        'Handshake references a signed prekey this device no longer holds.',
      );
    }

    const oneTimePreKey = prekey.oneTimePreKeyId
      ? await this.store.takeOneTimePreKey(prekey.oneTimePreKeyId)
      : null;

    let state: StoredSession;
    try {
      const result = respondX3DH(
        this.identity,
        signedPreKey.keyPair.privateKey,
        oneTimePreKey ? oneTimePreKey.keyPair.privateKey : null,
        prekey.identityKey,
        prekey.ephemeralKey,
      );
      state = {
        ...initReceiver(result.sharedSecret, result.associatedData, signedPreKey.keyPair),
        peerIdentityKey: prekey.identityKey,
      };
    } catch (error) {
      throw new DecryptionFailure('X3DH handshake failed.', { cause: error });
    }

    return this.advance(peerId, state, encoded);
  }

  /**
   * Decrypt against `state`, then persist the advanced state before returning.
   *
   * On failure nothing is written, so a forged message cannot desynchronise a session.
   */
  private async advance(
    peerId: string,
    state: StoredSession,
    encoded: Uint8Array,
  ): Promise<string> {
    let result;
    try {
      result = await ratchetDecrypt(state, encoded);
    } catch (error) {
      throw new DecryptionFailure('Message failed authentication.', { cause: error });
    }

    const advanced: StoredSession = {
      ...result.state,
      peerIdentityKey: state.peerIdentityKey,
    };
    await this.store.saveSession(peerId, state.peerIdentityKey, advanced);

    return fromUtf8(result.plaintext);
  }

  private async loadOrCreateOutbound(peerId: string): Promise<StoredSession> {
    const known = await this.store.loadPeerIdentity(peerId);
    if (known) {
      const state = await this.store.loadSession(peerId, known.identityKey);
      if (state) {
        return { ...state, peerIdentityKey: known.identityKey };
      }
    }

    const bundle = decodeBundle(await this.fetchBundle(peerId));
    await this.rememberPeer(peerId, bundle.identityKey);

    // initiateX3DH verifies the signed prekey signature and throws if it does not
    // check out. There is no unsigned path.
    const result = initiateX3DH(this.identity, bundle);

    return {
      ...initSender(result.sharedSecret, result.associatedData, bundle.signedPreKey, {
        identityKey: this.identity.publicKey,
        ephemeralKey: result.ephemeralKey.publicKey,
        signedPreKeyId: result.signedPreKeyId,
        oneTimePreKeyId: result.usedOneTimePreKeyId,
      }),
      peerIdentityKey: bundle.identityKey,
    };
  }

  private async rememberPeer(peerId: string, identityKey: Uint8Array): Promise<void> {
    const { changed, previous } = await this.store.rememberPeerIdentity(peerId, identityKey);
    if (changed && previous) {
      // The UI turns this into a safety-number warning. Without it, a server swapping
      // identity keys is completely invisible to the user.
      this.onIdentityChange({
        peerId,
        previousIdentityKey: previous.identityKey,
        newIdentityKey: identityKey,
      });
    }
  }
}
