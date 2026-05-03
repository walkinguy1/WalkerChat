import { decryptMessage } from './crypto';
import type { ChatMessageEvent, ChatMessageRecord, DisplayMessage } from '../types/chat';

export const toDisplayMessage = (
  message: ChatMessageEvent | ChatMessageRecord,
): DisplayMessage => {
  const decrypted = decryptMessage(message.ciphertext);
  const clientMessageId =
    'client_message_id' in message ? message.client_message_id : message.message_id;
  const serverMessageId = message.message_id;

  return {
    id: serverMessageId ?? clientMessageId,
    clientMessageId,
    serverMessageId,
    senderId: message.sender_id,
    body: decrypted.body,
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
