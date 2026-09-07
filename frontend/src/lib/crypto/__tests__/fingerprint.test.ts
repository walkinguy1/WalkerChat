import { describe, expect, it } from 'vitest';

import { computeSafetyNumber, formatSafetyNumber, safetyNumberMatches } from '../fingerprint';
import { generateKeyPair } from '../primitives';

const alice = { identityKeys: [generateKeyPair().publicKey], identifier: 'alice' };
const bob = { identityKeys: [generateKeyPair().publicKey], identifier: 'bob' };

describe('safety numbers', () => {
  it('produces 60 digits', () => {
    const safetyNumber = computeSafetyNumber(alice, bob);
    expect(safetyNumber).toHaveLength(60);
    expect(safetyNumber).toMatch(/^[0-9]{60}$/);
  });

  it('is identical for both participants regardless of who computes it', () => {
    // Both people must read the same string aloud, or comparison is meaningless.
    expect(computeSafetyNumber(alice, bob)).toBe(computeSafetyNumber(bob, alice));
  });

  it('is deterministic', () => {
    expect(computeSafetyNumber(alice, bob)).toBe(computeSafetyNumber(alice, bob));
  });

  it('changes when the peer identity key changes', () => {
    // This is the property the "safety number changed" warning depends on.
    const impostor = { identityKeys: [generateKeyPair().publicKey], identifier: 'bob' };
    expect(computeSafetyNumber(alice, bob)).not.toBe(computeSafetyNumber(alice, impostor));
  });

  it('changes when the identifier changes, even with the same key', () => {
    const renamed = { identityKeys: bob.identityKeys, identifier: 'mallory' };
    expect(computeSafetyNumber(alice, bob)).not.toBe(computeSafetyNumber(alice, renamed));
  });

  it('changes when the peer adds a device', () => {
    // A new device is a new key that can read the conversation, so it must be visible
    // rather than silently enrolled.
    const twoDevices = {
      identityKeys: [...bob.identityKeys, generateKeyPair().publicKey],
      identifier: 'bob',
    };
    expect(computeSafetyNumber(alice, bob)).not.toBe(computeSafetyNumber(alice, twoDevices));
  });

  it('is independent of the order devices are listed in', () => {
    const first = generateKeyPair().publicKey;
    const second = generateKeyPair().publicKey;

    expect(
      computeSafetyNumber(alice, { identityKeys: [first, second], identifier: 'bob' }),
    ).toBe(computeSafetyNumber(alice, { identityKeys: [second, first], identifier: 'bob' }));
  });

  it('formats as twelve groups of five', () => {
    const formatted = formatSafetyNumber(computeSafetyNumber(alice, bob));
    const groups = formatted.split(' ');
    expect(groups).toHaveLength(12);
    expect(groups.every((group) => group.length === 5)).toBe(true);
  });

  it('matches a value typed back with or without spacing', () => {
    const safetyNumber = computeSafetyNumber(alice, bob);
    expect(safetyNumberMatches(safetyNumber, formatSafetyNumber(safetyNumber))).toBe(true);
    expect(safetyNumberMatches(safetyNumber, safetyNumber)).toBe(true);
    expect(safetyNumberMatches(safetyNumber, '0'.repeat(60))).toBe(false);
  });
});
