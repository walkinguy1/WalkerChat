import { decryptMessage } from './crypto';
import type {
  ChatMessageEvent,
  ChatMessageRecord,
  DisplayMessage,
  ImageAttachment,
  StructuredMessagePayload,
} from '../types/chat';

/**
 * Build the plaintext that goes inside the encrypted envelope.
 *
 * Text-only messages stay a bare string so messages written before attachments
 * existed still decrypt correctly.
 */
export const encodeMessagePayload = (
  caption: string,
  attachment?: ImageAttachment,
): string => {
  if (!attachment) {
    return caption;
  }

  return JSON.stringify({ _wc: 1, caption, attachment } satisfies StructuredMessagePayload);
};

/**
 * Split decrypted plaintext back into caption and attachment.
 *
 * The `_wc` marker keeps a user who literally types JSON from being parsed as
 * an attachment envelope.
 */
export const decodeMessagePayload = (
  plaintext: string,
): { body: string; attachment?: ImageAttachment } => {
  if (!plaintext.startsWith('{')) {
    return { body: plaintext };
  }

  try {
    const parsed = JSON.parse(plaintext) as Partial<StructuredMessagePayload>;
    if (parsed._wc === 1 && parsed.attachment?.kind === 'image') {
      return { body: parsed.caption ?? '', attachment: parsed.attachment };
    }
  } catch {
    // Not an envelope; fall through and treat it as ordinary text.
  }

  return { body: plaintext };
};

export const createOptimisticDisplayMessage = (
  body: string,
  message: ChatMessageEvent,
  attachment?: ImageAttachment,
): DisplayMessage => ({
  id: message.message_id ?? message.client_message_id,
  clientMessageId: message.client_message_id,
  serverMessageId: message.message_id,
  senderId: message.sender_id,
  body,
  attachment,
  sentAt: message.sent_at ?? new Date().toISOString(),
  state: message.message_id ? 'sent' : 'sending',
});

export const resolveDisplayMessage = async (
  message: ChatMessageEvent | ChatMessageRecord,
  aesKey?: CryptoKey | null,
): Promise<DisplayMessage> => {
  const decrypted = await decryptMessage(message.ciphertext, aesKey);
  const { body, attachment } = decodeMessagePayload(decrypted.body);
  const clientMessageId =
    'client_message_id' in message ? message.client_message_id : message.message_id;
  const serverMessageId = message.message_id;

  return {
    id: serverMessageId ?? clientMessageId,
    clientMessageId,
    serverMessageId,
    senderId: message.sender_id,
    body,
    attachment,
    sentAt: message.sent_at ?? decrypted.createdAt,
    state: serverMessageId ? 'sent' : 'sending',
  };
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
