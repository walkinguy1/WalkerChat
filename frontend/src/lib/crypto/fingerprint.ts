/**
 * Safety numbers, following Signal's numeric fingerprint construction.
 *
 * X3DH authenticates a conversation only as well as the identity keys can be trusted,
 * and those arrive from the server. A safety number is the out-of-band channel that
 * lets two people confirm they hold the same keys, which is the only thing that turns
 * "the server said so" into an actual guarantee.
 */
import { concat, sha512Hash, utf8 } from './primitives';

/** Deliberately slow, so grinding a key to a chosen fingerprint is expensive. */
const ITERATIONS = 5200;

const VERSION = new Uint8Array([0x00, 0x00]);

/** Each party contributes 30 digits, as six groups of five. */
const GROUPS = 6;
const DIGITS_PER_GROUP = 5;

/**
 * Iterated hash over the key and a stable identifier, truncated to 30 decimal digits.
 * The identifier binds the fingerprint to a specific account, so an identical key under
 * a different username does not produce a matching safety number.
 */
const numericFingerprint = (publicKey: Uint8Array, identifier: string): string => {
  let hash = concat(VERSION, publicKey, utf8(identifier));
  for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
    hash = sha512Hash(concat(hash, publicKey));
  }

  let digits = '';
  for (let group = 0; group < GROUPS; group += 1) {
    const offset = group * 5;
    // Read five bytes as a 40-bit big-endian integer, then take five decimal digits.
    let value = 0n;
    for (let index = 0; index < 5; index += 1) {
      value = (value << 8n) | BigInt(hash[offset + index]);
    }
    digits += (value % 100000n).toString().padStart(DIGITS_PER_GROUP, '0');
  }
  return digits;
};

export type SafetyNumberParty = {
  identityKey: Uint8Array;
  identifier: string;
};

/**
 * The 60-digit safety number for a conversation.
 *
 * The two halves are ordered by value rather than by who is asking, so both people see
 * exactly the same string and can read it to each other.
 */
export const computeSafetyNumber = (
  self: SafetyNumberParty,
  peer: SafetyNumberParty,
): string => {
  const mine = numericFingerprint(self.identityKey, self.identifier);
  const theirs = numericFingerprint(peer.identityKey, peer.identifier);
  return mine < theirs ? mine + theirs : theirs + mine;
};

/** Split into 12 groups of 5 for display, the format people actually read aloud. */
export const formatSafetyNumber = (safetyNumber: string): string =>
  (safetyNumber.match(/.{1,5}/g) ?? []).join(' ');

/** Whether a scanned or typed safety number matches the computed one. */
export const safetyNumberMatches = (expected: string, provided: string): boolean =>
  expected === provided.replace(/\s/g, '');
