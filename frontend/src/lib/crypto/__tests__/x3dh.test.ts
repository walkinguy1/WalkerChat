import { describe, expect, it } from 'vitest';

import { generateKeyPair } from '../primitives';
import {
  createIdentityKeyPair,
  createOneTimePreKeys,
  createSignedPreKey,
  initiateX3DH,
  respondX3DH,
} from '../x3dh';
import { xeddsaSign } from '../xeddsa';
import { Client } from './harness';

describe('X3DH key agreement', () => {
  it('derives the same shared secret on both sides, with a one-time prekey', () => {
    const alice = createIdentityKeyPair();
    const bob = new Client('bob');
    const bundle = bob.publishBundle(true);

    const initiator = initiateX3DH(alice, bundle);
    const opk = bob.oneTimePreKeys.find((key) => key.keyId === bundle.oneTimePreKeyId);
    const responder = respondX3DH(
      bob.identity,
      bob.signedPreKey.keyPair.privateKey,
      opk ? opk.keyPair.privateKey : null,
      alice.publicKey,
      initiator.ephemeralKey.publicKey,
    );

    expect(initiator.sharedSecret).toEqual(responder.sharedSecret);
    expect(initiator.sharedSecret).toHaveLength(32);
  });

  it('derives the same shared secret without a one-time prekey', () => {
    // The OPK pool runs dry in normal operation; the handshake has to keep working.
    const alice = createIdentityKeyPair();
    const bob = new Client('bob');
    const bundle = bob.publishBundle(false);

    const initiator = initiateX3DH(alice, bundle);
    const responder = respondX3DH(
      bob.identity,
      bob.signedPreKey.keyPair.privateKey,
      null,
      alice.publicKey,
      initiator.ephemeralKey.publicKey,
    );

    expect(bundle.oneTimePreKey).toBeNull();
    expect(initiator.sharedSecret).toEqual(responder.sharedSecret);
  });

  it('binds associated data to both identity keys in initiator-then-responder order', () => {
    const alice = createIdentityKeyPair();
    const bob = new Client('bob');
    const initiator = initiateX3DH(alice, bob.publishBundle(false));

    expect(initiator.associatedData).toEqual(
      new Uint8Array([...alice.publicKey, ...bob.identity.publicKey]),
    );
  });

  it('produces a different secret for every handshake', () => {
    const alice = createIdentityKeyPair();
    const bob = new Client('bob');
    const bundle = bob.publishBundle(false);

    // Ephemeral keys are what make this true; without them the same pair would always
    // derive the same secret, which is the flaw in the implementation being replaced.
    const first = initiateX3DH(alice, bundle);
    const second = initiateX3DH(alice, bundle);
    expect(first.sharedSecret).not.toEqual(second.sharedSecret);
  });

  it('rejects a bundle whose signed prekey signature does not verify', () => {
    const alice = createIdentityKeyPair();
    const bob = new Client('bob');
    const bundle = bob.publishBundle(false);
    bundle.signedPreKeySignature[0] ^= 0xff;

    expect(() => initiateX3DH(alice, bundle)).toThrow(/signature is not valid/);
  });

  it('rejects a bundle whose signed prekey was swapped by the server', () => {
    // The MITM case: a malicious server substitutes its own prekey but cannot forge a
    // signature over it with the victim's identity key.
    const alice = createIdentityKeyPair();
    const bob = new Client('bob');
    const bundle = bob.publishBundle(false);
    bundle.signedPreKey = generateKeyPair().publicKey;

    expect(() => initiateX3DH(alice, bundle)).toThrow(/signature is not valid/);
  });

  it('rejects a bundle whose identity key was swapped by the server', () => {
    const alice = createIdentityKeyPair();
    const bob = new Client('bob');
    const attacker = createIdentityKeyPair();
    const bundle = bob.publishBundle(false);
    bundle.identityKey = attacker.publicKey;

    expect(() => initiateX3DH(alice, bundle)).toThrow(/signature is not valid/);
  });

  it('accepts a signature made over the correct key by the correct identity', () => {
    const bob = createIdentityKeyPair();
    const preKey = generateKeyPair();
    const alice = createIdentityKeyPair();

    expect(() =>
      initiateX3DH(alice, {
        identityKey: bob.publicKey,
        signedPreKeyId: 'spk-1',
        signedPreKey: preKey.publicKey,
        signedPreKeySignature: xeddsaSign(bob.privateKey, preKey.publicKey),
        oneTimePreKeyId: null,
        oneTimePreKey: null,
      }),
    ).not.toThrow();
  });

  it('rejects malformed key lengths', () => {
    const alice = createIdentityKeyPair();
    const bob = new Client('bob');
    const bundle = bob.publishBundle(false);

    expect(() => initiateX3DH(alice, { ...bundle, identityKey: new Uint8Array(31) })).toThrow(
      /must be 32 bytes/,
    );
    expect(() => initiateX3DH(alice, { ...bundle, signedPreKey: new Uint8Array(33) })).toThrow(
      /must be 32 bytes/,
    );
  });

  it('signs each generated prekey with the identity key', () => {
    const identity = createIdentityKeyPair();
    const signedPreKey = createSignedPreKey(identity, 'spk-1');
    const alice = createIdentityKeyPair();

    expect(() =>
      initiateX3DH(alice, {
        identityKey: identity.publicKey,
        signedPreKeyId: signedPreKey.keyId,
        signedPreKey: signedPreKey.keyPair.publicKey,
        signedPreKeySignature: signedPreKey.signature,
        oneTimePreKeyId: null,
        oneTimePreKey: null,
      }),
    ).not.toThrow();
  });

  it('generates distinct one-time prekeys with the requested ids', () => {
    let counter = 0;
    const keys = createOneTimePreKeys(10, () => {
      counter += 1;
      return 'opk-' + counter;
    });

    expect(keys).toHaveLength(10);
    expect(new Set(keys.map((key) => key.keyId)).size).toBe(10);
    expect(new Set(keys.map((key) => key.keyPair.publicKey.join(','))).size).toBe(10);
  });

  it('derives a different secret if the responder uses the wrong one-time prekey', () => {
    const alice = createIdentityKeyPair();
    const bob = new Client('bob');
    const bundle = bob.publishBundle(true);
    const initiator = initiateX3DH(alice, bundle);

    const wrongOpk = bob.oneTimePreKeys.find((key) => key.keyId !== bundle.oneTimePreKeyId);
    const responder = respondX3DH(
      bob.identity,
      bob.signedPreKey.keyPair.privateKey,
      wrongOpk ? wrongOpk.keyPair.privateKey : null,
      alice.publicKey,
      initiator.ephemeralKey.publicKey,
    );

    expect(initiator.sharedSecret).not.toEqual(responder.sharedSecret);
  });
});
