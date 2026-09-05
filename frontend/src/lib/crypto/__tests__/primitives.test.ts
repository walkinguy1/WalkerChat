import { describe, expect, it } from 'vitest';

import {
  aeadOpen,
  aeadSeal,
  concat,
  constantTimeEqual,
  dh,
  fromBase64,
  generateKeyPair,
  hkdfSha256,
  hmacSha256,
  randomBytes,
  toBase64,
  utf8,
} from '../primitives';

const hex = (value: string): Uint8Array =>
  new Uint8Array((value.match(/.{1,2}/g) ?? []).map((byte) => parseInt(byte, 16)));

/** Bytes from `start` (inclusive) to `end` (exclusive). RFC 5869 A.2 uses plain ranges. */
const range = (start: number, end: number): Uint8Array =>
  new Uint8Array(Array.from({ length: end - start }, (_, index) => start + index));

const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');

describe('HKDF-SHA256 (RFC 5869 test vectors)', () => {
  // These are the published vectors. If a refactor silently changes our HKDF
  // parameters, every derived key in the protocol changes and these fail first.
  it('matches vector A.1 (basic)', () => {
    const okm = hkdfSha256(
      hex('0b'.repeat(22)),
      hex('000102030405060708090a0b0c'),
      hex('f0f1f2f3f4f5f6f7f8f9'),
      42,
    );
    expect(toHex(okm)).toBe(
      '3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865',
    );
  });

  it('matches vector A.2 (longer inputs)', () => {
    const ikm = range(0x00, 0x50);
    const salt = range(0x60, 0xb0);
    const info = range(0xb0, 0x100);
    const okm = hkdfSha256(ikm, salt, info, 82);
    expect(toHex(okm)).toBe(
      'b11e398dc80327a1c8e7f78c596a49344f012eda2d4efad8a050cc4c19afa97c59045a99cac7827271cb41c65e590e09da3275600c2f09b8367793a9aca3db71cc30c58179ec3e87c14c01d5c1f3434f1d87',
    );
  });

  it('matches vector A.3 (zero-length salt and info)', () => {
    const okm = hkdfSha256(
      hex('0b'.repeat(22)),
      new Uint8Array(0),
      new Uint8Array(0),
      42,
    );
    expect(toHex(okm)).toBe(
      '8da4e775a563c18f715f802a063c5a31b8a11f5c5ee1879ec3454e5f3c738d2d9d201395faa4b61a96c8',
    );
  });
});

describe('HMAC-SHA256 (RFC 4231 test vectors)', () => {
  it('matches vector 1', () => {
    const mac = hmacSha256(hex('0b'.repeat(20)), utf8('Hi There'));
    expect(toHex(mac)).toBe('b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7');
  });

  it('matches vector 2', () => {
    const mac = hmacSha256(utf8('Jefe'), utf8('what do ya want for nothing?'));
    expect(toHex(mac)).toBe('5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843');
  });
});

describe('X25519 (RFC 7748 test vectors)', () => {
  it('matches the §6.1 key exchange vector', () => {
    const alicePriv = hex('77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a');
    const bobPriv = hex('5dab087e624a8a4b79e17f8b83800ee66f3bb1292618b6fd1c2f8b27ff88e0eb');
    const aliceShared = dh(alicePriv, hex('de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f'));
    const bobShared = dh(bobPriv, hex('8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a'));
    const expected = '4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742';
    expect(toHex(aliceShared)).toBe(expected);
    expect(toHex(bobShared)).toBe(expected);
  });

  it('agrees on a shared secret for freshly generated pairs', () => {
    const alice = generateKeyPair();
    const bob = generateKeyPair();
    expect(dh(alice.privateKey, bob.publicKey)).toEqual(dh(bob.privateKey, alice.publicKey));
  });

  it('rejects small-order points instead of deriving a known secret', () => {
    const alice = generateKeyPair();
    // The all-zero u-coordinate is the canonical small-order point; RFC 7748 §6.1
    // requires rejecting the resulting all-zero shared secret.
    // @noble/curves rejects this before our own all-zero guard fires, so assert the
    // rejection rather than a specific message. The guard stays as defence in depth.
    expect(() => dh(alice.privateKey, new Uint8Array(32))).toThrow();
  });

  it('rejects public keys of the wrong length', () => {
    const alice = generateKeyPair();
    expect(() => dh(alice.privateKey, new Uint8Array(31))).toThrow(/Invalid public key length/);
  });
});

describe('AES-256-GCM AEAD', () => {
  const key = () => randomBytes(32);
  const iv = () => randomBytes(12);

  it('round-trips a message', async () => {
    const k = key();
    const nonce = iv();
    const ad = utf8('associated');
    const sealed = await aeadSeal(k, nonce, utf8('hello ratchet'), ad);
    expect(new TextDecoder().decode(await aeadOpen(k, nonce, sealed, ad))).toBe('hello ratchet');
  });

  it('rejects a tampered ciphertext', async () => {
    const k = key();
    const nonce = iv();
    const ad = utf8('associated');
    const sealed = await aeadSeal(k, nonce, utf8('hello ratchet'), ad);
    sealed[0] ^= 0xff;
    await expect(aeadOpen(k, nonce, sealed, ad)).rejects.toThrow();
  });

  it('rejects mismatched associated data', async () => {
    const k = key();
    const nonce = iv();
    const sealed = await aeadSeal(k, nonce, utf8('hello ratchet'), utf8('chat-a'));
    // This is the property that stops a message being replayed into another thread.
    await expect(aeadOpen(k, nonce, sealed, utf8('chat-b'))).rejects.toThrow();
  });

  it('rejects a wrong key', async () => {
    const nonce = iv();
    const ad = utf8('associated');
    const sealed = await aeadSeal(key(), nonce, utf8('hello ratchet'), ad);
    await expect(aeadOpen(key(), nonce, sealed, ad)).rejects.toThrow();
  });

  it('refuses a key that is not 32 bytes', async () => {
    await expect(aeadSeal(randomBytes(16), iv(), utf8('x'), new Uint8Array(0))).rejects.toThrow(
      /32-byte key/,
    );
  });
});

describe('encoding helpers', () => {
  it('round-trips base64 across all byte values', () => {
    const bytes = new Uint8Array(256).map((_, index) => index);
    expect(fromBase64(toBase64(bytes))).toEqual(bytes);
  });

  it('concatenates in order', () => {
    expect(concat(new Uint8Array([1, 2]), new Uint8Array([3]), new Uint8Array([4, 5]))).toEqual(
      new Uint8Array([1, 2, 3, 4, 5]),
    );
  });

  it('compares in constant time', () => {
    expect(constantTimeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3]))).toBe(true);
    expect(constantTimeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4]))).toBe(false);
    expect(constantTimeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2, 3]))).toBe(false);
  });
});
