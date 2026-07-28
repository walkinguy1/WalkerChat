import { decryptMessage } from './crypto';
import type {
  ChatMessageEvent,
  ChatMessageRecord,
  DisplayMessage,
  ImageAttachment,
  MessageEnvelope,
  ReactionEvent,
  ReactionPayload,
  ReactionTally,
  ReplyRef,
  StructuredMessagePayload,
} from '../types/chat';

/** How much of the quoted message travels with a reply. */
const REPLY_PREVIEW_LIMIT = 140;

export const buildReplyRef = (message: DisplayMessage): ReplyRef => ({
  message_id: message.id,
  sender_id: message.senderId,
  preview: (message.body || (message.attachment ? 'Photo' : '')).slice(
    0,
    REPLY_PREVIEW_LIMIT,
  ),
});

/**
 * Build the plaintext that goes inside the encrypted envelope.
 *
 * Text-only messages stay a bare string so messages written before attachments
 * existed still decrypt correctly.
 */
export const encodeMessagePayload = (
  caption: string,
  attachment?: ImageAttachment,
  replyTo?: ReplyRef,
): string => {
  if (!attachment && !replyTo) {
    return caption;
  }

  return JSON.stringify({
    _wc: 1,
    caption,
    ...(attachment ? { attachment } : {}),
    ...(replyTo ? { reply_to: replyTo } : {}),
  } satisfies StructuredMessagePayload);
};

/**
 * Build the plaintext for a reaction.
 *
 * It rides the same ciphertext path as a message, which is what keeps the
 * emoji and its target off the server. The cost is one stored row per
 * reaction — the server cannot distinguish it from any other message.
 */
export const encodeReactionPayload = (
  targetMessageId: string,
  emoji: string,
  action: 'add' | 'remove',
): string =>
  JSON.stringify({
    _wc: 1,
    kind: 'reaction',
    target_message_id: targetMessageId,
    emoji,
    action,
  } satisfies ReactionPayload);

export type DecodedPayload =
  | { kind: 'message'; body: string; attachment?: ImageAttachment; replyTo?: ReplyRef }
  | {
      kind: 'reaction';
      targetMessageId: string;
      emoji: string;
      action: 'add' | 'remove';
    };

/**
 * Split decrypted plaintext back into its parts.
 *
 * The `_wc` marker keeps a user who literally types JSON from being parsed as
 * an envelope.
 */
export const decodeMessagePayload = (plaintext: string): DecodedPayload => {
  if (!plaintext.startsWith('{')) {
    return { kind: 'message', body: plaintext };
  }

  try {
    const parsed = JSON.parse(plaintext) as Partial<MessageEnvelope>;

    if (parsed._wc !== 1) {
      return { kind: 'message', body: plaintext };
    }

    if (parsed.kind === 'reaction') {
      const reaction = parsed as ReactionPayload;
      if (reaction.target_message_id && reaction.emoji) {
        return {
          kind: 'reaction',
          targetMessageId: reaction.target_message_id,
          emoji: reaction.emoji,
          action: reaction.action === 'remove' ? 'remove' : 'add',
        };
      }
      return { kind: 'message', body: plaintext };
    }

    const envelope = parsed as StructuredMessagePayload;
    if (envelope.attachment?.kind === 'image' || envelope.reply_to) {
      return {
        kind: 'message',
        body: envelope.caption ?? '',
        attachment: envelope.attachment?.kind === 'image' ? envelope.attachment : undefined,
        replyTo: envelope.reply_to,
      };
    }
  } catch {
    // Not an envelope; fall through and treat it as ordinary text.
  }

  return { kind: 'message', body: plaintext };
};

export const createOptimisticDisplayMessage = (
  body: string,
  message: ChatMessageEvent,
  attachment?: ImageAttachment,
  replyTo?: ReplyRef,
): DisplayMessage => ({
  id: message.message_id ?? message.client_message_id,
  clientMessageId: message.client_message_id,
  serverMessageId: message.message_id,
  senderId: message.sender_id,
  body,
  attachment,
  replyTo,
  sentAt: message.sent_at ?? new Date().toISOString(),
  state: message.message_id ? 'sent' : 'sending',
});

/**
 * Decrypt one envelope. Reactions and messages share the ciphertext path, so
 * which of the two arrived is only knowable after decryption.
 */
export const resolveEnvelope = async (
  message: ChatMessageEvent | ChatMessageRecord,
  aesKey?: CryptoKey | null,
): Promise<
  { kind: 'message'; message: DisplayMessage } | { kind: 'reaction'; reaction: ReactionEvent }
> => {
  const decrypted = await decryptMessage(message.ciphertext, aesKey);
  const payload = decodeMessagePayload(decrypted.body);
  const clientMessageId =
    'client_message_id' in message ? message.client_message_id : message.message_id;
  const serverMessageId = message.message_id;
  const sentAt = message.sent_at ?? decrypted.createdAt;

  if (payload.kind === 'reaction') {
    return {
      kind: 'reaction',
      reaction: {
        id: serverMessageId ?? clientMessageId,
        targetMessageId: payload.targetMessageId,
        senderId: message.sender_id,
        emoji: payload.emoji,
        action: payload.action,
        sentAt,
      },
    };
  }

  return {
    kind: 'message',
    message: {
      id: serverMessageId ?? clientMessageId,
      clientMessageId,
      serverMessageId,
      senderId: message.sender_id,
      body: payload.body,
      attachment: payload.attachment,
      replyTo: payload.replyTo,
      sentAt,
      state: serverMessageId ? 'sent' : 'sending',
    },
  };
};

export const mergeReactions = (
  previousReactions: ReactionEvent[],
  incomingReaction: ReactionEvent,
) => {
  if (previousReactions.some((reaction) => reaction.id === incomingReaction.id)) {
    return previousReactions;
  }
  return [...previousReactions, incomingReaction];
};

/**
 * Fold the reaction log into a per-message tally.
 *
 * Replaying in send order makes the result independent of arrival order, so a
 * reaction that decrypts before its target message still lands correctly.
 */
export const buildReactionTallies = (
  reactions: ReactionEvent[],
): Map<string, ReactionTally[]> => {
  const byMessage = new Map<string, Map<string, Set<string>>>();

  [...reactions]
    .sort((left, right) => left.sentAt.localeCompare(right.sentAt))
    .forEach((reaction) => {
      let emojis = byMessage.get(reaction.targetMessageId);
      if (!emojis) {
        emojis = new Map();
        byMessage.set(reaction.targetMessageId, emojis);
      }

      let userIds = emojis.get(reaction.emoji);
      if (!userIds) {
        userIds = new Set();
        emojis.set(reaction.emoji, userIds);
      }

      if (reaction.action === 'add') {
        userIds.add(reaction.senderId);
      } else {
        userIds.delete(reaction.senderId);
      }
    });

  const tallies = new Map<string, ReactionTally[]>();
  byMessage.forEach((emojis, messageId) => {
    const entries = [...emojis.entries()]
      .filter(([, userIds]) => userIds.size > 0)
      .map(([emoji, userIds]) => ({ emoji, userIds: [...userIds] }));

    if (entries.length) {
      tallies.set(messageId, entries);
    }
  });

  return tallies;
};

export const mergeMessages = (
  previousMessages: DisplayMessage[],
  incomingMessage: DisplayMessage,
) => {
  const existingIndex = previousMessages.findIndex(
    (message) =>
      message.serverMessageId === incomingMessage.serverMessageId ||
      message.clientMessageId === incomingMessage.clientMessageId,
  );

  if (existingIndex === -1) {
    return [...previousMessages, incomingMessage].sort((left, right) =>
      left.sentAt.localeCompare(right.sentAt),
    );
  }

  return previousMessages.map((message, index) =>
    index === existingIndex ? incomingMessage : message,
  );
};
