import { ed25519 } from '@noble/curves/ed25519.js';
import { describe, expect, it } from 'vitest';

import { generateKeyPair, randomBytes, utf8 } from '../primitives';
import { montgomeryToEdwards, xeddsaPublicKey, xeddsaSign, xeddsaVerify } from '../xeddsa';

describe('XEdDSA', () => {
  it('verifies its own signatures', () => {
    const { privateKey, publicKey } = generateKeyPair();
    const message = utf8('signed prekey material');
    expect(xeddsaVerify(publicKey, message, xeddsaSign(privateKey, message))).toBe(true);
  });

  it('produces signatures that standard Ed25519 verification accepts', () => {
    // Cross-check against @noble's independent Ed25519 verifier. If our own sign and
    // our own verify were both wrong in the same way, this is what catches it.
    const { privateKey, publicKey } = generateKeyPair();
    const message = utf8('cross-checked against noble');
    const signature = xeddsaSign(privateKey, message);
    const edwardsPublicKey = montgomeryToEdwards(publicKey);

    expect(ed25519.verify(signature, message, edwardsPublicKey, { zip215: false })).toBe(true);
  });

  it('derives a public key from the private key that matches the converted DH key', () => {
    const { privateKey, publicKey } = generateKeyPair();
    expect(xeddsaPublicKey(privateKey)).toEqual(montgomeryToEdwards(publicKey));
  });

  it('rejects a signature over a different message', () => {
    const { privateKey, publicKey } = generateKeyPair();
    const signature = xeddsaSign(privateKey, utf8('original'));
    expect(xeddsaVerify(publicKey, utf8('tampered'), signature)).toBe(false);
  });

  it('rejects a signature from a different key', () => {
    const signer = generateKeyPair();
    const impostor = generateKeyPair();
    const message = utf8('signed prekey material');
    // This is the check that stops a malicious server swapping in its own prekey.
    expect(xeddsaVerify(impostor.publicKey, message, xeddsaSign(signer.privateKey, message))).toBe(
      false,
    );
  });

  it('rejects a bit-flipped signature', () => {
    const { privateKey, publicKey } = generateKeyPair();
    const message = utf8('signed prekey material');

    for (const index of [0, 31, 32, 63]) {
      const signature = xeddsaSign(privateKey, message);
      signature[index] ^= 0x01;
      expect(xeddsaVerify(publicKey, message, signature)).toBe(false);
    }
  });

  it('rejects signatures of the wrong length', () => {
    const { publicKey } = generateKeyPair();
    expect(xeddsaVerify(publicKey, utf8('m'), new Uint8Array(63))).toBe(false);
    expect(xeddsaVerify(publicKey, utf8('m'), new Uint8Array(65))).toBe(false);
  });

  it('is randomised: two signatures over the same message differ', () => {
    const { privateKey, publicKey } = generateKeyPair();
    const message = utf8('same message');
    const first = xeddsaSign(privateKey, message);
    const second = xeddsaSign(privateKey, message);

    expect(first).not.toEqual(second);
    expect(xeddsaVerify(publicKey, message, first)).toBe(true);
    expect(xeddsaVerify(publicKey, message, second)).toBe(true);
  });

  it('is deterministic when the nonce is pinned', () => {
    const { privateKey } = generateKeyPair();
    const message = utf8('same message');
    const randomness = randomBytes(64);
    expect(xeddsaSign(privateKey, message, randomness)).toEqual(
      xeddsaSign(privateKey, message, randomness),
    );
  });

  it('requires 64 bytes of randomness', () => {
    const { privateKey } = generateKeyPair();
    expect(() => xeddsaSign(privateKey, utf8('m'), randomBytes(32))).toThrow(/64 bytes/);
  });

  it('signs and verifies an empty message', () => {
    const { privateKey, publicKey } = generateKeyPair();
    const signature = xeddsaSign(privateKey, new Uint8Array(0));
    expect(xeddsaVerify(publicKey, new Uint8Array(0), signature)).toBe(true);
  });

  it('holds over many random keys', () => {
    for (let iteration = 0; iteration < 50; iteration += 1) {
      const { privateKey, publicKey } = generateKeyPair();
      const message = randomBytes(1 + (iteration % 64));
      expect(xeddsaVerify(publicKey, message, xeddsaSign(privateKey, message))).toBe(true);
    }
  });
});
