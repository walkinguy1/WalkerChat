import { useCallback, useEffect, useState } from 'react';

import { computeSafetyNumber, formatSafetyNumber } from '../lib/crypto/fingerprint';
import type { CryptoStore } from '../lib/crypto/store';

export type VerificationState =
  /** No session established yet, so there is nothing to compare. */
  | 'pending'
  /** Session exists; the user has not compared the number out of band. */
  | 'unverified'
  /** The user confirmed the number matches. */
  | 'verified'
  /** The peer's identity key changed after we had already seen a different one. */
  | 'changed';

export type SafetyNumber = {
  state: VerificationState;
  /** 60 digits, or null before a session exists. */
  value: string | null;
  /** The same digits in twelve groups of five, for reading aloud. */
  formatted: string | null;
  markVerified: () => Promise<void>;
  clearVerification: () => Promise<void>;
};

type Resolved = {
  value: string | null;
  trusted: boolean;
  known: boolean;
};

const UNKNOWN: Resolved = { value: null, trusted: false, known: false };

/**
 * Safety number for one conversation.
 *
 * X3DH authenticates a conversation only as well as the identity keys can be trusted,
 * and those come from the server. Comparing this number over another channel is what
 * turns "the server said so" into something a user can actually check -- and it is the
 * only way a key substitution becomes visible.
 */
export const useSafetyNumber = (options: {
  store: CryptoStore | null;
  selfUserId: string | null;
  selfIdentityKey: Uint8Array | null;
  peerUserId: string | null;
  /** Peers whose identity key changed during this session. */
  changedPeerIds: Set<string>;
}): SafetyNumber => {
  const { store, selfUserId, selfIdentityKey, peerUserId, changedPeerIds } = options;

  const [resolved, setResolved] = useState<Resolved>(UNKNOWN);
  const [reloadToken, setReloadToken] = useState(0);

  const resolve = useCallback(async (): Promise<Resolved> => {
    if (!store || !selfUserId || !selfIdentityKey || !peerUserId) {
      return UNKNOWN;
    }

    // Every device the peer has, not just one: verifying a single installation of an
    // account says nothing about the others.
    const peerDevices = await store.loadPeerIdentitiesForUser(peerUserId);
    if (peerDevices.length === 0) {
      // No session yet: the peer's identity keys are genuinely unknown, and inventing
      // a number here would be worse than showing none.
      return UNKNOWN;
    }

    return {
      value: computeSafetyNumber(
        { identityKeys: [selfIdentityKey], identifier: selfUserId },
        {
          identityKeys: peerDevices.map((device) => device.identityKey),
          identifier: peerUserId,
        },
      ),
      // Verified only when every known device of theirs has been accepted.
      trusted: peerDevices.every((device) => device.trusted),
      known: true,
    };
  }, [peerUserId, selfIdentityKey, selfUserId, store]);

  useEffect(() => {
    let cancelled = false;

    // The guard matters beyond tidiness: switching chats quickly would otherwise let a
    // slower lookup for the previous peer overwrite the current one's number.
    void resolve().then((next) => {
      if (!cancelled) {
        setResolved(next);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [resolve, changedPeerIds, reloadToken]);

  const setTrust = useCallback(
    async (trusted: boolean) => {
      if (!store || !peerUserId) return;

      // Trust applies to the account, which means every device of it: the safety
      // number the user compared covers the whole set.
      const devices = await store.loadPeerIdentitiesForUser(peerUserId);
      for (const device of devices) {
        await store.setPeerTrusted(device.peerId, trusted);
      }
      setReloadToken((token) => token + 1);
    },
    [peerUserId, store],
  );

  const markVerified = useCallback(() => setTrust(true), [setTrust]);
  const clearVerification = useCallback(() => setTrust(false), [setTrust]);

  // A changed key outranks a stored "verified" flag: the verification was of a
  // different key, so it says nothing about this one.
  const state: VerificationState = !resolved.known
    ? 'pending'
    : peerUserId && changedPeerIds.has(peerUserId)
      ? 'changed'
      : resolved.trusted
        ? 'verified'
        : 'unverified';

  return {
    state,
    value: resolved.value,
    formatted: resolved.value ? formatSafetyNumber(resolved.value) : null,
    markVerified,
    clearVerification,
  };
};
