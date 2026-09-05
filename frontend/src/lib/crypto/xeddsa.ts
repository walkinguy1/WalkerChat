/**
 * XEdDSA over Curve25519, per Signal's "The XEdDSA and VXEdDSA Signature Schemes" section 2.
 *
 * X3DH signs the signed prekey with the *identity key*, and the identity key is an
 * X25519 key used for Diffie-Hellman. XEdDSA is what lets one Montgomery key do both
 * jobs, so we do not have to ship a second identity key just to sign with.
 *
 * A useful property, exploited by the tests: an XEdDSA signature is a valid *standard*
 * Ed25519 signature under the converted public key, so our verifier can be checked
 * against @noble's independent implementation rather than against itself.
 */
import { ed25519 } from '@noble/curves/ed25519.js';

import { concat, randomBytes, sha512Hash } from './primitives';

const Point = ed25519.Point;
const Fp = Point.Fp;
const Fn = Point.Fn;

/** Group order q. */
const Q = Fn.ORDER;

export const SIGNATURE_LEN = 64;

const bytesToNumberLE = (bytes: Uint8Array): bigint => {
  let value = 0n;
  for (let index = bytes.length - 1; index >= 0; index -= 1) {
    value = (value << 8n) | BigInt(bytes[index]);
  }
  return value;
};

const numberToBytesLE = (value: bigint, length: number): Uint8Array => {
  const out = new Uint8Array(length);
  let remaining = value;
  for (let index = 0; index < length; index += 1) {
    out[index] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  return out;
};

/**
 * Clamp an X25519 secret exactly as RFC 7748 requires, then read it as the scalar.
 * The Montgomery ladder clamps internally, so signing has to use the same clamped
 * value or the signature would not correspond to the DH public key.
 *
 * Clamping sets bit 254, so the raw value is around 2^254 and exceeds the group
 * order q (~2^252). The base point has order q, so kB == (k mod q)B and reducing
 * here is exact, not an approximation -- it is also what keeps `a` in range for the
 * `s = r + ha (mod q)` arithmetic below.
 */
const clampScalar = (privateKey: Uint8Array): bigint => {
  if (privateKey.length !== 32) {
    throw new Error('X25519 private key must be 32 bytes, got ' + privateKey.length);
  }
  const clamped = Uint8Array.from(privateKey);
  clamped[0] &= 248;
  clamped[31] &= 127;
  clamped[31] |= 64;

  const scalar = bytesToNumberLE(clamped) % Q;
  if (scalar === 0n) {
    throw new Error('Degenerate X25519 private key: scalar reduced to zero.');
  }
  return scalar;
};

/** hash_i(X) = SHA-512((2^256 - 1 - i) || X), with the prefix encoded little-endian. */
const hashWithPrefix = (index: number, ...parts: Uint8Array[]): Uint8Array => {
  const prefix = new Uint8Array(32).fill(0xff);
  prefix[0] = 0xff - index;
  return sha512Hash(concat(prefix, ...parts));
};

const modQ = (bytes: Uint8Array): bigint => ((bytesToNumberLE(bytes) % Q) + Q) % Q;

/**
 * calculate_key_pair: derive the Ed25519 signing pair whose public key has a cleared
 * sign bit, negating the scalar when needed so it still matches.
 */
const calculateKeyPair = (privateKey: Uint8Array): { publicKey: Uint8Array; scalar: bigint } => {
  const k = clampScalar(privateKey);
  const point = Point.BASE.multiply(k);
  const encoded = point.toBytes();
  const signBit = (encoded[31] & 0x80) !== 0;

  const publicKey = Uint8Array.from(encoded);
  publicKey[31] &= 0x7f;

  return { publicKey, scalar: signBit ? Q - k : k };
};

/** The Ed25519 public key corresponding to an X25519 private key. */
export const xeddsaPublicKey = (privateKey: Uint8Array): Uint8Array =>
  calculateKeyPair(privateKey).publicKey;

/**
 * Convert a Montgomery u-coordinate to an Ed25519 public key: y = (u - 1) / (u + 1),
 * with the sign bit cleared. Throws when u + 1 is zero, which has no inverse.
 */
export const montgomeryToEdwards = (montgomeryPublicKey: Uint8Array): Uint8Array => {
  if (montgomeryPublicKey.length !== 32) {
    throw new Error('X25519 public key must be 32 bytes, got ' + montgomeryPublicKey.length);
  }
  const masked = Uint8Array.from(montgomeryPublicKey);
  masked[31] &= 0x7f;
  const u = Fp.create(bytesToNumberLE(masked));

  const denominator = Fp.add(u, Fp.ONE);
  if (Fp.is0(denominator)) {
    throw new Error('Invalid X25519 public key: u = -1 has no Edwards equivalent.');
  }
  const y = Fp.mul(Fp.sub(u, Fp.ONE), Fp.inv(denominator));

  const encoded = numberToBytesLE(y, 32);
  encoded[31] &= 0x7f;
  return encoded;
};

/**
 * Sign a message with an X25519 private key.
 *
 * `randomness` is the spec's Z: 64 bytes mixed into the nonce so that signing is not
 * purely deterministic. It is injectable only so tests can pin a known nonce.
 */
export const xeddsaSign = (
  privateKey: Uint8Array,
  message: Uint8Array,
  randomness: Uint8Array = randomBytes(64),
): Uint8Array => {
  if (randomness.length !== 64) {
    throw new Error('XEdDSA randomness must be 64 bytes, got ' + randomness.length);
  }
  const { publicKey, scalar } = calculateKeyPair(privateKey);

  const r = modQ(hashWithPrefix(1, numberToBytesLE(scalar, 32), message, randomness));
  if (r === 0n) {
    throw new Error('XEdDSA nonce reduced to zero; retry signing.');
  }
  const rBytes = Point.BASE.multiply(r).toBytes();

  const h = modQ(sha512Hash(concat(rBytes, publicKey, message)));
  const s = (r + h * scalar) % Q;

  return concat(rBytes, numberToBytesLE(s, 32));
};

/**
 * Verify an XEdDSA signature against an X25519 *public* key.
 *
 * Returns false rather than throwing: a bad signature on a prekey bundle is an
 * expected condition to handle, not an exceptional one.
 */
export const xeddsaVerify = (
  montgomeryPublicKey: Uint8Array,
  message: Uint8Array,
  signature: Uint8Array,
): boolean => {
  if (signature.length !== SIGNATURE_LEN) {
    return false;
  }
  try {
    const edwardsPublicKey = montgomeryToEdwards(montgomeryPublicKey);
    return ed25519.verify(signature, message, edwardsPublicKey, { zip215: false });
  } catch {
    return false;
  }
};
