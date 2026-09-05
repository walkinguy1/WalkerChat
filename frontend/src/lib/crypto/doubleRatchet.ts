/**
 * The Double Ratchet, per Signal's "The Double Ratchet Algorithm" specification.
 *
 * Two ratchets turn one X3DH shared secret into a fresh key per message:
 *  - the symmetric-key ratchet advances a chain key on every message, so a compromised
 *    message key never reveals earlier ones (forward secrecy);
 *  - the Diffie-Hellman ratchet mixes in a new DH output whenever the direction of
 *    conversation turns, so a full state compromise heals once each side has sent
 *    again (post-compromise security).
 *
 * State is a plain serialisable object rather than a class, because it has to survive
 * a page reload in IndexedDB. A ratchet that lives only in memory silently resets on
 * refresh, which is precisely the bug in the implementation this replaces.
 */
import {
  IV_LEN,
  KEY_LEN,
  ZERO_SALT,
  aeadOpen,
  aeadSeal,
  concat,
  dh,
  generateKeyPair,
  hkdfSha256,
  hmacSha256,
  utf8,
} from './primitives';
import type { KeyPair, PublicKey } from './primitives';
import {
  HEADER_LEN,
  MESSAGE_TYPE_NORMAL,
  MESSAGE_TYPE_PREKEY,
  decodeMessage,
  encodeHeader,
  encodeMessage,
} from './serialization';
import type { MessageHeader, PreKeyMessageFields, RatchetMessage } from './serialization';

const RATCHET_INFO = utf8('WalkerChatRatchet');
const MESSAGE_KEY_INFO = utf8('WalkerChatMessageKeys');

/** Constants distinguishing the two HMAC outputs of the symmetric ratchet. */
const MESSAGE_KEY_SEED = new Uint8Array([0x01]);
const CHAIN_KEY_SEED = new Uint8Array([0x02]);

/**
 * How far ahead we will derive keys to catch up with a chain. Bounded because each
 * skipped key is stored, and an unbounded count is a memory-exhaustion vector: a
 * sender can simply claim n = 2^32 - 1.
 */
export const MAX_SKIP = 1000;

/** Global ceiling on retained skipped keys, oldest evicted first. */
export const MAX_SKIPPED_KEYS = 2000;

export type SkippedKey = {
  /** Ratchet public key of the chain the key belongs to. */
  dh: Uint8Array;
  n: number;
  messageKey: Uint8Array;
};

export type RatchetState = {
  /** Root key. */
  rk: Uint8Array;
  /** Our current ratchet key pair. */
  dhs: KeyPair;
  /** Their current ratchet public key, unknown until we receive. */
  dhr: PublicKey | null;
  /** Sending chain key. */
  cks: Uint8Array | null;
  /** Receiving chain key. */
  ckr: Uint8Array | null;
  /** Messages sent in the current sending chain. */
  ns: number;
  /** Messages received in the current receiving chain. */
  nr: number;
  /** Messages sent in the previous sending chain. */
  pn: number;
  /** Message keys derived but not yet used, for out-of-order delivery. */
  skipped: SkippedKey[];
  /** AD from X3DH, bound into every message. */
  associatedData: Uint8Array;
  /** Set on the initiator until the responder replies, so retries stay decryptable. */
  pendingPreKey: PreKeyMessageFields | null;
};

/**
 * KDF_RK: HKDF with the root key as salt and the DH output as input material.
 * Returns the next root key and a fresh chain key.
 */
const kdfRootKey = (rootKey: Uint8Array, dhOutput: Uint8Array): [Uint8Array, Uint8Array] => {
  const derived = hkdfSha256(dhOutput, rootKey, RATCHET_INFO, 64);
  return [derived.slice(0, 32), derived.slice(32, 64)];
};

/** KDF_CK: two domain-separated HMACs off the chain key. */
const kdfChainKey = (chainKey: Uint8Array): { messageKey: Uint8Array; nextChainKey: Uint8Array } => ({
  messageKey: hmacSha256(chainKey, MESSAGE_KEY_SEED),
  nextChainKey: hmacSha256(chainKey, CHAIN_KEY_SEED),
});

/**
 * Expand a message key into an AEAD key and IV.
 *
 * The IV is derived rather than random. Each message key is used exactly once, so a
 * derived nonce cannot repeat under the same key -- which is the failure mode that
 * breaks AES-GCM catastrophically.
 */
const deriveMessageKeys = (messageKey: Uint8Array): { key: Uint8Array; iv: Uint8Array } => {
  const derived = hkdfSha256(messageKey, ZERO_SALT, MESSAGE_KEY_INFO, KEY_LEN + IV_LEN);
  return { key: derived.slice(0, KEY_LEN), iv: derived.slice(KEY_LEN, KEY_LEN + IV_LEN) };
};

/**
 * Initialise the initiator's state.
 *
 * Alice performs a DH ratchet step immediately against Bob's signed prekey, so her very
 * first message already uses a ratcheted key rather than SK directly.
 */
export const initSender = (
  sharedSecret: Uint8Array,
  associatedData: Uint8Array,
  responderSignedPreKey: PublicKey,
  pendingPreKey: PreKeyMessageFields,
): RatchetState => {
  const dhs = generateKeyPair();
  const [rk, cks] = kdfRootKey(sharedSecret, dh(dhs.privateKey, responderSignedPreKey));

  return {
    rk,
    dhs,
    dhr: responderSignedPreKey,
    cks,
    ckr: null,
    ns: 0,
    nr: 0,
    pn: 0,
    skipped: [],
    associatedData,
    pendingPreKey,
  };
};

/**
 * Initialise the responder's state. Bob's ratchet key *is* his signed prekey pair, and
 * he cannot send until he has received, so there is no sending chain yet.
 */
export const initReceiver = (
  sharedSecret: Uint8Array,
  associatedData: Uint8Array,
  signedPreKeyPair: KeyPair,
): RatchetState => ({
  rk: sharedSecret,
  dhs: signedPreKeyPair,
  dhr: null,
  cks: null,
  ckr: null,
  ns: 0,
  nr: 0,
  pn: 0,
  skipped: [],
  associatedData,
  pendingPreKey: null,
});

const associatedDataFor = (state: RatchetState, header: MessageHeader): Uint8Array =>
  concat(state.associatedData, encodeHeader(header));

/** Encrypt one message, advancing the sending chain. */
export const ratchetEncrypt = async (
  state: RatchetState,
  plaintext: Uint8Array,
): Promise<{ state: RatchetState; message: Uint8Array }> => {
  if (!state.cks) {
    throw new Error('Cannot send: no sending chain established yet.');
  }

  const { messageKey, nextChainKey } = kdfChainKey(state.cks);
  const header: MessageHeader = { dh: state.dhs.publicKey, pn: state.pn, n: state.ns };
  const { key, iv } = deriveMessageKeys(messageKey);

  const ciphertext = await aeadSeal(key, iv, plaintext, associatedDataFor(state, header));

  // A prekey message repeats the X3DH fields until the peer replies; until then we
  // have no proof they ever received the handshake.
  const message: RatchetMessage = state.pendingPreKey
    ? { type: MESSAGE_TYPE_PREKEY, prekey: state.pendingPreKey, header, ciphertext }
    : { type: MESSAGE_TYPE_NORMAL, header, ciphertext };

  return {
    state: { ...state, cks: nextChainKey, ns: state.ns + 1 },
    message: encodeMessage(message),
  };
};

const rememberSkipped = (skipped: SkippedKey[], entry: SkippedKey): SkippedKey[] => {
  const next = [...skipped, entry];
  // Oldest-first eviction keeps the store bounded without dropping the keys most
  // likely to still be needed.
  return next.length > MAX_SKIPPED_KEYS ? next.slice(next.length - MAX_SKIPPED_KEYS) : next;
};

/** Derive and stash message keys for messages we have not seen yet in this chain. */
const skipMessageKeys = (state: RatchetState, until: number): RatchetState => {
  if (state.ckr === null) {
    if (until > state.nr) {
      throw new Error('Cannot skip messages: no receiving chain established.');
    }
    return state;
  }

  if (until - state.nr > MAX_SKIP) {
    throw new Error(
      'Refusing to skip ' + (until - state.nr) + ' messages; MAX_SKIP is ' + MAX_SKIP + '.',
    );
  }

  let chainKey = state.ckr;
  let index = state.nr;
  let skipped = state.skipped;

  while (index < until) {
    const { messageKey, nextChainKey } = kdfChainKey(chainKey);
    skipped = rememberSkipped(skipped, {
      dh: state.dhr as PublicKey,
      n: index,
      messageKey,
    });
    chainKey = nextChainKey;
    index += 1;
  }

  return { ...state, ckr: chainKey, nr: until, skipped };
};

/** Perform a DH ratchet step on receiving a new ratchet public key. */
const dhRatchet = (state: RatchetState, header: MessageHeader): RatchetState => {
  // Finish the old receiving chain first, so messages still in flight from it remain
  // decryptable after the turn.
  const caughtUp = skipMessageKeys(state, header.pn);

  const [receivingRootKey, ckr] = kdfRootKey(caughtUp.rk, dh(caughtUp.dhs.privateKey, header.dh));
  const dhs = generateKeyPair();
  const [rk, cks] = kdfRootKey(receivingRootKey, dh(dhs.privateKey, header.dh));

  return {
    ...caughtUp,
    rk,
    dhs,
    dhr: header.dh,
    cks,
    ckr,
    pn: caughtUp.ns,
    ns: 0,
    nr: 0,
  };
};

const tryDecryptSkipped = async (
  state: RatchetState,
  header: MessageHeader,
  ciphertext: Uint8Array,
): Promise<{ state: RatchetState; plaintext: Uint8Array } | null> => {
  const index = state.skipped.findIndex(
    (entry) => entry.n === header.n && entry.dh.every((byte, at) => byte === header.dh[at]),
  );
  if (index === -1) {
    return null;
  }

  const { key, iv } = deriveMessageKeys(state.skipped[index].messageKey);
  const plaintext = await aeadOpen(key, iv, ciphertext, associatedDataFor(state, header));

  // Consume the key so the same message cannot be replayed.
  const skipped = [...state.skipped.slice(0, index), ...state.skipped.slice(index + 1)];
  return { state: { ...state, skipped }, plaintext };
};

const sameKey = (left: Uint8Array | null, right: Uint8Array): boolean =>
  left !== null && left.length === right.length && left.every((byte, at) => byte === right[at]);

/**
 * Decrypt one message.
 *
 * The returned state must be persisted before the plaintext is treated as delivered:
 * if the process dies in between, replaying the message against the *old* state still
 * works, whereas a committed-but-unacknowledged advance would desynchronise the session.
 */
export const ratchetDecrypt = async (
  state: RatchetState,
  encoded: Uint8Array,
): Promise<{ state: RatchetState; plaintext: Uint8Array }> => {
  const message = decodeMessage(encoded);
  const { header, ciphertext } = message;

  const fromSkipped = await tryDecryptSkipped(state, header, ciphertext);
  if (fromSkipped) {
    return fromSkipped;
  }

  // A new ratchet key means the conversation turned; step the DH ratchet.
  const ratcheted = sameKey(state.dhr, header.dh) ? state : dhRatchet(state, header);

  const caughtUp = skipMessageKeys(ratcheted, header.n);
  if (!caughtUp.ckr) {
    throw new Error('Cannot decrypt: no receiving chain established.');
  }

  const { messageKey, nextChainKey } = kdfChainKey(caughtUp.ckr);
  const { key, iv } = deriveMessageKeys(messageKey);

  // If this throws, the caller keeps the pre-call state, so a forged message cannot
  // advance the ratchet.
  const plaintext = await aeadOpen(key, iv, ciphertext, associatedDataFor(caughtUp, header));

  return {
    state: {
      ...caughtUp,
      ckr: nextChainKey,
      nr: caughtUp.nr + 1,
      // Their reply proves the handshake landed, so stop resending the X3DH fields.
      pendingPreKey: null,
    },
    plaintext,
  };
};

export { HEADER_LEN, MESSAGE_TYPE_NORMAL, MESSAGE_TYPE_PREKEY, decodeMessage };
