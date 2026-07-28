import type { DisplayMessage } from '../types/chat';

/**
 * Local search index.
 *
 * The backend stores ciphertext, so a `LIKE` query on the server is impossible
 * by design. Searching therefore happens here, over the plaintext this device
 * has already decrypted — which means results only cover history this browser
 * has opened. The command palette states that to the user rather than hiding
 * it.
 *
 * The index is deliberately in-memory and dies with the tab. Persisting it
 * would survive reloads, but it would also leave decrypted message bodies at
 * rest in the browser, readable without any key — a strictly weaker position
 * than the app holds today.
 */

export type SearchEntry = {
  messageId: string;
  chatId: string;
  senderId: string;
  body: string;
  sentAt: string;
  hasAttachment: boolean;
};

export type SearchHit = SearchEntry & {
  /** Character range of the match inside `body`, for highlighting. */
  matchStart: number;
  matchEnd: number;
};

/** Bodies the crypto layer substitutes when it cannot produce plaintext. */
const UNRESOLVED = new Set([
  '[Unable to decrypt]',
  '[Secure session required]',
  '[Encrypted payload]',
]);

const indexByChatId = new Map<string, Map<string, SearchEntry>>();

/**
 * Fold a thread's decrypted messages into the index.
 *
 * Called as messages resolve, so a message first rendered as a locked
 * placeholder becomes searchable the moment its key lands.
 */
export const indexChatMessages = (chatId: string, messages: DisplayMessage[]) => {
  let entries = indexByChatId.get(chatId);
  if (!entries) {
    entries = new Map();
    indexByChatId.set(chatId, entries);
  }

  messages.forEach((message) => {
    const isReadable = Boolean(message.body) && !UNRESOLVED.has(message.body);
    if (!isReadable && !message.attachment) {
      return;
    }

    entries.set(message.id, {
      messageId: message.id,
      chatId,
      senderId: message.senderId,
      body: isReadable ? message.body : '',
      sentAt: message.sentAt,
      hasAttachment: Boolean(message.attachment),
    });
  });
};

export const clearSearchIndex = () => indexByChatId.clear();

/** How many threads currently have decrypted history in the index. */
export const indexedChatCount = () => indexByChatId.size;

export const searchLocalIndex = (query: string, limit = 20): SearchHit[] => {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];

  const hits: SearchHit[] = [];

  indexByChatId.forEach((entries) => {
    entries.forEach((entry) => {
      const matchStart = entry.body.toLowerCase().indexOf(needle);
      if (matchStart === -1) return;

      hits.push({ ...entry, matchStart, matchEnd: matchStart + needle.length });
    });
  });

  return hits
    .sort((left, right) => right.sentAt.localeCompare(left.sentAt))
    .slice(0, limit);
};

/** Decrypted photos this device has seen, newest first. */
export const searchLocalPhotos = (query: string, limit = 20): SearchEntry[] => {
  const needle = query.trim().toLowerCase();
  const found: SearchEntry[] = [];

  indexByChatId.forEach((entries) => {
    entries.forEach((entry) => {
      if (!entry.hasAttachment) return;
      if (needle && !entry.body.toLowerCase().includes(needle)) return;
      found.push(entry);
    });
  });

  return found
    .sort((left, right) => right.sentAt.localeCompare(left.sentAt))
    .slice(0, limit);
};
