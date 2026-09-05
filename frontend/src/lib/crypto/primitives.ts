/**
 * Low-level cryptographic primitives.
 *
 * Everything here is a pure function over `Uint8Array` with no browser or React
 * dependency, so the whole protocol stack above it runs identically in the browser
 * and in Node under Vitest. That is deliberate: a ratchet bug that only reproduces
 * in a browser is a bug you cannot write a test for.
 */
import { x25519 } from '@noble/curves/ed25519.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256, sha512 } from '@noble/hashes/sha2.js';

export const KEY_LEN = 32;
export const IV_LEN = 12;

/** 32 zero bytes. Used as the HKDF salt wherever the specs call for one. */
export const ZERO_SALT = new Uint8Array(32);

export type PublicKey = Uint8Array;
export type PrivateKey = Uint8Array;

export type KeyPair = {
  privateKey: PrivateKey;
  publicKey: PublicKey;
};

// --- encoding -------------------------------------------------------------

export const toBase64 = (bytes: Uint8Array): string => {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 1) {
    binary += String.fromCharCode(bytes[index]);
  }
  return btoa(binary);
};

export const fromBase64 = (base64: string): Uint8Array => {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
};

export const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);
export const fromUtf8 = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

export const concat = (...parts: Uint8Array[]): Uint8Array => {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
};

/**
 * Comparison whose running time depends only on length, never on content.
 * Used for MAC and fingerprint checks, where an early return leaks the position
 * of the first differing byte and turns a forgery into a search problem.
 */
export const constantTimeEqual = (left: Uint8Array, right: Uint8Array): boolean => {
  if (left.length !== right.length) {
    return false;
  }
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index] ^ right[index];
  }
  return difference === 0;
};

export const randomBytes = (length: number): Uint8Array =>
  crypto.getRandomValues(new Uint8Array(length));

/**
 * Copy into a standalone ArrayBuffer.
 *
 * Blob and fetch want an ArrayBuffer, and a Uint8Array view may be a window onto a
 * larger buffer, so handing over `.buffer` directly can leak neighbouring bytes.
 */
export const toArrayBuffer = (bytes: Uint8Array): ArrayBuffer =>
  bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;

/** Best-effort wipe of key material once it is no longer needed. */
export const wipe = (bytes: Uint8Array): void => {
  bytes.fill(0);
};

// --- hashing and derivation -----------------------------------------------

export const sha256Hash = (data: Uint8Array): Uint8Array => sha256(data);
export const sha512Hash = (data: Uint8Array): Uint8Array => sha512(data);

export const hmacSha256 = (key: Uint8Array, data: Uint8Array): Uint8Array => hmac(sha256, key, data);

export const hkdfSha256 = (
  ikm: Uint8Array,
  salt: Uint8Array,
  info: Uint8Array,
  length: number,
): Uint8Array => hkdf(sha256, ikm, salt, info, length);

// --- X25519 ---------------------------------------------------------------

export const generateKeyPair = (): KeyPair => {
  const privateKey = x25519.utils.randomSecretKey();
  return { privateKey, publicKey: x25519.getPublicKey(privateKey) };
};

export const publicKeyFromPrivate = (privateKey: PrivateKey): PublicKey =>
  x25519.getPublicKey(privateKey);

/**
 * X25519 Diffie-Hellman.
 *
 * An all-zero output means the peer supplied a small-order point, which would
 * force a known shared secret. RFC 7748 §6.1 says to reject it, so we throw
 * rather than ratchet forward on an attacker-chosen value.
 */
export const dh = (privateKey: PrivateKey, publicKey: PublicKey): Uint8Array => {
  if (publicKey.length !== KEY_LEN) {
    throw new Error(`Invalid public key length: ${publicKey.length}`);
  }
  const shared = x25519.getSharedSecret(privateKey, publicKey);
  if (constantTimeEqual(shared, new Uint8Array(KEY_LEN))) {
    throw new Error('Invalid public key: small-order point produced an all-zero shared secret.');
  }
  return shared;
};

// --- AEAD -----------------------------------------------------------------

const importAesKey = (key: Uint8Array): Promise<CryptoKey> => {
  if (key.length !== KEY_LEN) {
    throw new Error(`AES-256-GCM requires a 32-byte key, got ${key.length}`);
  }
  return crypto.subtle.importKey('raw', key as BufferSource, 'AES-GCM', false, [
    'encrypt',
    'decrypt',
  ]);
};

export const aeadSeal = async (
  key: Uint8Array,
  iv: Uint8Array,
  plaintext: Uint8Array,
  associatedData: Uint8Array,
): Promise<Uint8Array> => {
  const aesKey = await importAesKey(key);
  const sealed = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv as BufferSource, additionalData: associatedData as BufferSource },
    aesKey,
    plaintext as BufferSource,
  );
  return new Uint8Array(sealed);
};

/** Throws when the key, IV, ciphertext or associated data has been tampered with. */
export const aeadOpen = async (
  key: Uint8Array,
  iv: Uint8Array,
  ciphertext: Uint8Array,
  associatedData: Uint8Array,
): Promise<Uint8Array> => {
  const aesKey = await importAesKey(key);
  const opened = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: iv as BufferSource, additionalData: associatedData as BufferSource },
    aesKey,
    ciphertext as BufferSource,
  );
  return new Uint8Array(opened);
};
