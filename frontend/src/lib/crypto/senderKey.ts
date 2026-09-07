/**
 * Sender Keys, for group messaging.
 *
 * A pairwise ratchet per recipient would mean encrypting each group message N times.
 * Sender Keys instead give every member their own hash chain per group: a message is
 * encrypted once under the sender's chain and delivered to everyone.
 *
 * The trade-off is deliberate and worth stating. Because every member holds every other
 * member's chain key, a group has **no post-compromise security**: a chain key that
 * leaks stays useful until the sender rotates. It keeps forward secrecy (the chain only
 * moves forward and old message keys are deleted), and rotation on membership change is
 * what bounds the damage.
 *
 * Each message is also **signed**. Without that, any member who holds another member's
 * chain key -- which is all of them -- could forge messages in that member's name. The
 * signing private key never leaves its owner, so the chain key alone cannot impersonate.
 */
import {
  IV_LEN,
  KEY_LEN,
  ZERO_SALT,
  aeadOpen,
  aeadSeal,
  concat,
  generateKeyPair,
  hkdfSha256,
  hmacSha256,
  randomBytes,
  utf8,
} from './primitives';
import { SIGNATURE_LEN, xeddsaSign, xeddsaVerify } from './xeddsa';

const MESSAGE_KEY_INFO = utf8('WalkerChatSenderKeyMessageKeys');

const MESSAGE_KEY_SEED = new Uint8Array([0x01]);
const CHAIN_KEY_SEED = new Uint8Array([0x02]);

/** Matches the pairwise ratchet's bound, for the same reason: sender-controlled index. */
export const MAX_SENDER_KEY_SKIP = 1000;

/** Global cap on retained skipped keys, oldest evicted first. */
export const MAX_SKIPPED_SENDER_KEYS = 2000;

export type SkippedSenderKey = {
  iteration: number;
  messageKey: Uint8Array;
};

export type SenderKeyState = {
  /** Which group this chain belongs to. */
  distributionId: string;
  /** Who owns the chain. */
  senderId: string;
  chainKey: Uint8Array;
  iteration: number;
  /** Verifies messages on this chain. */
  signingPublicKey: Uint8Array;
  /** Present only for our own chain. */
  signingPrivateKey: Uint8Array | null;
  skipped: SkippedSenderKey[];
};

/** What a member sends to every other member so they can read the sender's messages. */
export type SenderKeyDistribution = {
  distributionId: string;
  senderId: string;
  iteration: number;
  chainKey: Uint8Array;
  signingPublicKey: Uint8Array;
};

const kdfChainKey = (chainKey: Uint8Array) => ({
  messageKey: hmacSha256(chainKey, MESSAGE_KEY_SEED),
  nextChainKey: hmacSha256(chainKey, CHAIN_KEY_SEED),
});

/** Derived, not random: each message key is used once, so the nonce cannot repeat. */
const deriveMessageKeys = (messageKey: Uint8Array) => {
  const derived = hkdfSha256(messageKey, ZERO_SALT, MESSAGE_KEY_INFO, KEY_LEN + IV_LEN);
  return { key: derived.slice(0, KEY_LEN), iv: derived.slice(KEY_LEN, KEY_LEN + IV_LEN) };
};

/** Start a fresh chain for ourselves in a group. */
export const createSenderKey = (distributionId: string, senderId: string): SenderKeyState => {
  const signing = generateKeyPair();
  return {
    distributionId,
    senderId,
    chainKey: randomBytes(KEY_LEN),
    iteration: 0,
    signingPublicKey: signing.publicKey,
    signingPrivateKey: signing.privateKey,
    skipped: [],
  };
};

/**
 * What to hand to another member.
 *
 * This carries the *current* chain key, not the original one, so a member added later
 * cannot read messages sent before they joined.
 */
export const buildDistribution = (state: SenderKeyState): SenderKeyDistribution => ({
  distributionId: state.distributionId,
  senderId: state.senderId,
  iteration: state.iteration,
  chainKey: state.chainKey,
  signingPublicKey: state.signingPublicKey,
});

/** Turn a received distribution into a receive-only chain. */
export const acceptDistribution = (distribution: SenderKeyDistribution): SenderKeyState => {
  if (distribution.chainKey.length !== KEY_LEN) {
    throw new Error('Sender key distribution has a malformed chain key.');
  }
  if (distribution.signingPublicKey.length !== KEY_LEN) {
    throw new Error('Sender key distribution has a malformed signing key.');
  }

  return {
    distributionId: distribution.distributionId,
    senderId: distribution.senderId,
    chainKey: distribution.chainKey,
    iteration: distribution.iteration,
    signingPublicKey: distribution.signingPublicKey,
    signingPrivateKey: null,
    skipped: [],
  };
};

const encodeHeader = (iteration: number): Uint8Array => {
  const header = new Uint8Array(4);
  new DataView(header.buffer).setUint32(0, iteration, false);
  return header;
};

/**
 * Encrypt one group message and advance the chain.
 *
 * `associatedData` binds the ciphertext to its context (the group and sender), so a
 * message cannot be replayed into a different group.
 */
export const senderKeyEncrypt = async (
  state: SenderKeyState,
  plaintext: Uint8Array,
  associatedData: Uint8Array,
): Promise<{ state: SenderKeyState; message: Uint8Array }> => {
  if (!state.signingPrivateKey) {
    throw new Error('Cannot send: this sender key has no signing private key.');
  }

  const { messageKey, nextChainKey } = kdfChainKey(state.chainKey);
  const { key, iv } = deriveMessageKeys(messageKey);

  const header = encodeHeader(state.iteration);
  const ciphertext = await aeadSeal(key, iv, plaintext, concat(associatedData, header));

  // Signed last, over exactly the bytes a receiver will verify.
  const signature = xeddsaSign(state.signingPrivateKey, concat(header, ciphertext));

  return {
    state: { ...state, chainKey: nextChainKey, iteration: state.iteration + 1 },
    message: concat(header, ciphertext, signature),
  };
};

const rememberSkipped = (
  skipped: SkippedSenderKey[],
  entry: SkippedSenderKey,
): SkippedSenderKey[] => {
  const next = [...skipped, entry];
  return next.length > MAX_SKIPPED_SENDER_KEYS
    ? next.slice(next.length - MAX_SKIPPED_SENDER_KEYS)
    : next;
};

/**
 * Decrypt one group message.
 *
 * Verifies the signature *before* touching the chain, so a forged message cannot make
 * us derive keys or advance state.
 */
export const senderKeyDecrypt = async (
  state: SenderKeyState,
  message: Uint8Array,
  associatedData: Uint8Array,
): Promise<{ state: SenderKeyState; plaintext: Uint8Array }> => {
  if (message.length < 4 + SIGNATURE_LEN) {
    throw new Error('Malformed sender key message.');
  }

  const header = message.subarray(0, 4);
  const ciphertext = message.subarray(4, message.length - SIGNATURE_LEN);
  const signature = message.subarray(message.length - SIGNATURE_LEN);

  if (!xeddsaVerify(state.signingPublicKey, concat(header, ciphertext), signature)) {
    // Every member holds this sender's chain key, so the signature is the only thing
    // stopping one member forging messages as another.
    throw new Error('Sender key message signature is not valid.');
  }

  const iteration = new DataView(header.buffer, header.byteOffset, 4).getUint32(0, false);
  const aad = concat(associatedData, header);

  const skippedIndex = state.skipped.findIndex((entry) => entry.iteration === iteration);
  if (skippedIndex !== -1) {
    const { key, iv } = deriveMessageKeys(state.skipped[skippedIndex].messageKey);
    const plaintext = await aeadOpen(key, iv, ciphertext, aad);

    // Consume the key, so the same message cannot be replayed.
    return {
      state: {
        ...state,
        skipped: [
          ...state.skipped.slice(0, skippedIndex),
          ...state.skipped.slice(skippedIndex + 1),
        ],
      },
      plaintext,
    };
  }

  if (iteration < state.iteration) {
    throw new Error('Sender key message is a replay of an already-consumed iteration.');
  }

  if (iteration - state.iteration > MAX_SENDER_KEY_SKIP) {
    throw new Error(
      'Refusing to skip ' +
        (iteration - state.iteration) +
        ' sender key messages; the limit is ' +
        MAX_SENDER_KEY_SKIP +
        '.',
    );
  }

  // Catch up to the claimed iteration, keeping the keys we pass so messages still in
  // flight remain readable.
  let chainKey = state.chainKey;
  let cursor = state.iteration;
  let skipped = state.skipped;

  while (cursor < iteration) {
    const step = kdfChainKey(chainKey);
    skipped = rememberSkipped(skipped, { iteration: cursor, messageKey: step.messageKey });
    chainKey = step.nextChainKey;
    cursor += 1;
  }

  const { messageKey, nextChainKey } = kdfChainKey(chainKey);
  const { key, iv } = deriveMessageKeys(messageKey);
  const plaintext = await aeadOpen(key, iv, ciphertext, aad);

  return {
    state: { ...state, chainKey: nextChainKey, iteration: iteration + 1, skipped },
    plaintext,
  };
};

/**
 * Associated data for a group message: the group and the sender.
 *
 * Binding both means a ciphertext cannot be replayed into another group, nor attributed
 * to a different member.
 */
export const groupAssociatedData = (distributionId: string, senderId: string): Uint8Array =>
  utf8(distributionId + ':' + senderId);
