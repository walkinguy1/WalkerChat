/**
 * X3DH key agreement over Curve25519, per Signal's "The X3DH Key Agreement Protocol".
 *
 * The whole point of X3DH over a plain DH is that the initiator can establish a shared
 * secret against a bundle the recipient published *while offline*, and that the secret
 * mixes in ephemeral and one-time key material so compromising the long-term identity
 * key later does not retroactively decrypt anything.
 */
import {
  KEY_LEN,
  ZERO_SALT,
  concat,
  dh,
  generateKeyPair,
  hkdfSha256,
  utf8,
  wipe,
} from './primitives';
import type { KeyPair, PrivateKey, PublicKey } from './primitives';
import { xeddsaSign, xeddsaVerify } from './xeddsa';

/**
 * Domain separation string. Per the spec this identifies the protocol and curve, and
 * it must match on both sides or the two parties derive different secrets.
 */
const X3DH_INFO = utf8('WalkerChatX3DHCurve25519');

/** The spec's F: 32 bytes of 0xFF, prepended to prevent cross-protocol collisions. */
const F = new Uint8Array(32).fill(0xff);

export type IdentityKeyPair = KeyPair;

export type SignedPreKey = {
  keyId: string;
  keyPair: KeyPair;
  /** XEdDSA signature over the public key, made with the identity key. */
  signature: Uint8Array;
  createdAt: number;
};

export type OneTimePreKey = {
  keyId: string;
  keyPair: KeyPair;
};

/** What the server publishes for a user, and what an initiator fetches. */
export type PreKeyBundle = {
  identityKey: PublicKey;
  signedPreKeyId: string;
  signedPreKey: PublicKey;
  signedPreKeySignature: Uint8Array;
  oneTimePreKeyId: string | null;
  oneTimePreKey: PublicKey | null;
};

export type X3DHResult = {
  /** The 32-byte shared secret SK, used to seed the Double Ratchet root key. */
  sharedSecret: Uint8Array;
  /** AD = Encode(IK_A) || Encode(IK_B), bound into every subsequent message. */
  associatedData: Uint8Array;
};

export type InitiatorResult = X3DHResult & {
  ephemeralKey: KeyPair;
  usedOneTimePreKeyId: string | null;
  signedPreKeyId: string;
};

export const createIdentityKeyPair = (): IdentityKeyPair => generateKeyPair();

export const createSignedPreKey = (identity: IdentityKeyPair, keyId: string): SignedPreKey => {
  const keyPair = generateKeyPair();
  return {
    keyId,
    keyPair,
    signature: xeddsaSign(identity.privateKey, keyPair.publicKey),
    createdAt: Date.now(),
  };
};

export const createOneTimePreKeys = (count: number, nextKeyId: () => string): OneTimePreKey[] =>
  Array.from({ length: count }, () => ({ keyId: nextKeyId(), keyPair: generateKeyPair() }));

const assertKeyLength = (key: Uint8Array, label: string): void => {
  if (key.length !== KEY_LEN) {
    throw new Error(label + ' must be ' + KEY_LEN + ' bytes, got ' + key.length);
  }
};

/**
 * SK = HKDF(F || DH1 || DH2 || DH3 [|| DH4]).
 *
 * The DH outputs are wiped afterwards; they are as sensitive as the secret itself and
 * there is no reason to leave them reachable.
 */
const deriveSharedSecret = (dhOutputs: Uint8Array[]): Uint8Array => {
  const ikm = concat(F, ...dhOutputs);
  const sharedSecret = hkdfSha256(ikm, ZERO_SALT, X3DH_INFO, 32);
  dhOutputs.forEach(wipe);
  wipe(ikm);
  return sharedSecret;
};

const associatedDataFor = (initiatorIdentity: PublicKey, responderIdentity: PublicKey): Uint8Array =>
  concat(initiatorIdentity, responderIdentity);

/**
 * Initiator side. Verifies the signed prekey *before* doing any DH -- an unsigned or
 * badly signed bundle is exactly what a MITM server would serve, and there is no
 * fallback path for it.
 */
export const initiateX3DH = (
  identity: IdentityKeyPair,
  bundle: PreKeyBundle,
): InitiatorResult => {
  assertKeyLength(bundle.identityKey, 'Peer identity key');
  assertKeyLength(bundle.signedPreKey, 'Peer signed prekey');

  if (!xeddsaVerify(bundle.identityKey, bundle.signedPreKey, bundle.signedPreKeySignature)) {
    throw new Error('Prekey bundle rejected: signed prekey signature is not valid.');
  }

  const ephemeralKey = generateKeyPair();

  const dhOutputs = [
    dh(identity.privateKey, bundle.signedPreKey),
    dh(ephemeralKey.privateKey, bundle.identityKey),
    dh(ephemeralKey.privateKey, bundle.signedPreKey),
  ];

  if (bundle.oneTimePreKey) {
    assertKeyLength(bundle.oneTimePreKey, 'Peer one-time prekey');
    dhOutputs.push(dh(ephemeralKey.privateKey, bundle.oneTimePreKey));
  }

  return {
    sharedSecret: deriveSharedSecret(dhOutputs),
    associatedData: associatedDataFor(identity.publicKey, bundle.identityKey),
    ephemeralKey,
    usedOneTimePreKeyId: bundle.oneTimePreKeyId,
    signedPreKeyId: bundle.signedPreKeyId,
  };
};

/**
 * Responder side. Mirrors the initiator's DH order with the roles swapped, which is
 * what makes both sides land on the same SK.
 */
export const respondX3DH = (
  identity: IdentityKeyPair,
  signedPreKeyPrivate: PrivateKey,
  oneTimePreKeyPrivate: PrivateKey | null,
  initiatorIdentityKey: PublicKey,
  initiatorEphemeralKey: PublicKey,
): X3DHResult => {
  assertKeyLength(initiatorIdentityKey, 'Initiator identity key');
  assertKeyLength(initiatorEphemeralKey, 'Initiator ephemeral key');

  const dhOutputs = [
    dh(signedPreKeyPrivate, initiatorIdentityKey),
    dh(identity.privateKey, initiatorEphemeralKey),
    dh(signedPreKeyPrivate, initiatorEphemeralKey),
  ];

  if (oneTimePreKeyPrivate) {
    dhOutputs.push(dh(oneTimePreKeyPrivate, initiatorEphemeralKey));
  }

  return {
    sharedSecret: deriveSharedSecret(dhOutputs),
    associatedData: associatedDataFor(initiatorIdentityKey, identity.publicKey),
  };
};
