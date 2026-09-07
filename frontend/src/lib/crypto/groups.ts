/**
 * Group messaging on top of Sender Keys.
 *
 * Distribution is the interesting part: a sender key is itself secret, so it is sent to
 * each member through the *pairwise* Double Ratchet session with that member. Groups
 * therefore depend on 1:1 sessions working, and inherit their authentication -- a
 * distribution message can only have come from someone who holds that pairwise session.
 */
import { fromBase64, fromUtf8, toBase64, utf8 } from './primitives';
import {
  acceptDistribution,
  buildDistribution,
  createSenderKey,
  groupAssociatedData,
  senderKeyDecrypt,
  senderKeyEncrypt,
} from './senderKey';
import type { SenderKeyDistribution, SenderKeyState } from './senderKey';
import type { CryptoStore } from './store';
import type { SessionManager } from './session';
import { DecryptionFailure } from './session';

/** Marks a pairwise plaintext as a sender key distribution rather than a chat message. */
const DISTRIBUTION_MARKER = '_wc_sender_key';

export type EncodedDistribution = {
  [DISTRIBUTION_MARKER]: 1;
  distributionId: string;
  senderId: string;
  iteration: number;
  chainKey: string;
  signingPublicKey: string;
};

export const encodeDistribution = (distribution: SenderKeyDistribution): string =>
  JSON.stringify({
    [DISTRIBUTION_MARKER]: 1,
    distributionId: distribution.distributionId,
    senderId: distribution.senderId,
    iteration: distribution.iteration,
    chainKey: toBase64(distribution.chainKey),
    signingPublicKey: toBase64(distribution.signingPublicKey),
  } satisfies EncodedDistribution);

/** Returns null when the plaintext is an ordinary message rather than a distribution. */
export const decodeDistribution = (plaintext: string): SenderKeyDistribution | null => {
  if (!plaintext.startsWith('{')) {
    return null;
  }

  try {
    const parsed = JSON.parse(plaintext) as Partial<EncodedDistribution>;
    if (parsed[DISTRIBUTION_MARKER] !== 1) {
      return null;
    }
    if (!parsed.distributionId || !parsed.senderId || !parsed.chainKey || !parsed.signingPublicKey) {
      return null;
    }

    return {
      distributionId: parsed.distributionId,
      senderId: parsed.senderId,
      iteration: parsed.iteration ?? 0,
      chainKey: fromBase64(parsed.chainKey),
      signingPublicKey: fromBase64(parsed.signingPublicKey),
    };
  } catch {
    return null;
  }
};

/**
 * One sender key distribution, already encrypted for one specific *device*.
 *
 * A member with two installations needs two of these: each holds its own pairwise
 * ratchet, so there is no single ciphertext both can read.
 */
export type PendingDistribution = {
  userId: string;
  deviceRowId: string;
  ciphertext: string;
};

export class GroupSessionManager {
  private readonly store: CryptoStore;
  private readonly sessions: SessionManager;
  private readonly selfId: string;

  /** Serialises per group, so two sends cannot both advance the same chain. */
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(options: { store: CryptoStore; sessions: SessionManager; selfId: string }) {
    this.store = options.store;
    this.sessions = options.sessions;
    this.selfId = options.selfId;
  }

  private enqueue<T>(groupId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(groupId) ?? Promise.resolve();
    const next = previous.then(task, task);
    this.queues.set(
      groupId,
      next.catch(() => undefined),
    );
    return next;
  }

  /**
   * Encrypt a group message, along with any sender key distributions that still need
   * sending.
   *
   * Distributions are produced for every member each time the chain is created or
   * rotated. They are encrypted here but sent by the caller, because delivery is the
   * app's job.
   */
  encrypt(
    groupId: string,
    memberIds: string[],
    plaintext: string,
  ): Promise<{ message: string; distributions: PendingDistribution[] }> {
    return this.enqueue(groupId, async () => {
      let state = await this.store.loadSenderKey(groupId, this.selfId);
      let distributions: PendingDistribution[] = [];

      if (!state) {
        state = createSenderKey(groupId, this.selfId);
        distributions = await this.buildDistributions(state, memberIds);
      }

      const result = await senderKeyEncrypt(
        state,
        utf8(plaintext),
        groupAssociatedData(groupId, this.selfId),
      );
      await this.store.saveSenderKey(result.state);

      return { message: toBase64(result.message), distributions };
    });
  }

  /** Decrypt a group message from `senderId`. */
  decrypt(groupId: string, senderId: string, ciphertextBase64: string): Promise<string> {
    return this.enqueue(groupId, async () => {
      const state = await this.store.loadSenderKey(groupId, senderId);
      if (!state) {
        // We have not received this member's sender key yet. Their next distribution
        // will arrive over the pairwise session and later messages will decrypt.
        throw new DecryptionFailure('No sender key for this member yet.');
      }

      let message: Uint8Array;
      try {
        message = fromBase64(ciphertextBase64);
      } catch (error) {
        throw new DecryptionFailure('Group message is not valid base64.', { cause: error });
      }

      let result;
      try {
        result = await senderKeyDecrypt(
          state,
          message,
          groupAssociatedData(groupId, senderId),
        );
      } catch (error) {
        throw new DecryptionFailure('Group message failed authentication.', { cause: error });
      }

      await this.store.saveSenderKey(result.state);
      return fromUtf8(result.plaintext);
    });
  }

  /** Store a sender key received from another member. */
  async acceptDistribution(distribution: SenderKeyDistribution): Promise<void> {
    if (distribution.senderId === this.selfId) {
      // Our own key, echoed back from another device. Ours is authoritative.
      return;
    }
    await this.store.saveSenderKey(acceptDistribution(distribution));
  }

  /**
   * Rotate our sender key for a group and redistribute it.
   *
   * Required whenever someone leaves: they keep the chain key they were given, so
   * without rotation they can still read everything sent afterwards.
   */
  rotate(groupId: string, memberIds: string[]): Promise<PendingDistribution[]> {
    return this.enqueue(groupId, async () => {
      const state = createSenderKey(groupId, this.selfId);
      const distributions = await this.buildDistributions(state, memberIds);
      await this.store.saveSenderKey(state);
      return distributions;
    });
  }

  /** Forget every chain for a group, for example when we leave it. */
  async forget(groupId: string): Promise<void> {
    await this.store.clearSenderKeys(groupId);
  }

  private async buildDistributions(
    state: SenderKeyState,
    memberIds: string[],
  ): Promise<PendingDistribution[]> {
    const payload = encodeDistribution(buildDistribution(state));
    const recipients = memberIds.filter((memberId) => memberId !== this.selfId);

    const perMember = await Promise.all(
      recipients.map(async (userId) => {
        try {
          // One ciphertext per device the member has.
          const envelopes = await this.sessions.encryptForUser(userId, payload);
          return Object.entries(envelopes).map(([deviceRowId, ciphertext]) => ({
            userId,
            deviceRowId,
            ciphertext,
          }));
        } catch {
          // One unreachable member must not block the group. They will get the key on
          // the next rotation, and until then simply cannot read our messages.
          return [];
        }
      }),
    );

    return perMember.flat();
  }
}
