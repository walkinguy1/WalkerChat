export type ChatMessageEvent = {
  type: 'chat_message';
  chat_id: string;
  client_message_id: string;
  message_id?: string;
  sender_id: string;
  /** This installation's id, as published. */
  sender_device_id?: string;
  /** Server-resolved device row; receivers key their ratchet session on it. */
  sender_device_row_id?: string | null;
  target_id?: string;
  /**
   * One ciphertext per recipient device, keyed by device row id. A pairwise ratchet
   * encrypts to a single device's chain, so a two-device recipient needs two
   * ciphertexts. Group messages use the single "*" key, because Sender Keys produce
   * one ciphertext for the whole membership.
   */
  envelopes: Record<string, string>;
  is_media?: boolean;
  sent_at?: string;
};

/**
 * Describes an encrypted image. This object is itself encrypted inside the
 * message envelope, so the server learns neither the mime type nor the IV
 * needed to read the blob it stores.
 */
export type ImageAttachment = {
  kind: 'image';
  media_id: string;
  /**
   * Per-attachment content key, base64. Each image gets its own random key rather
   * than reusing a long-lived session key, so attachments inherit the ratchet's
   * forward secrecy: this descriptor travels inside the ratcheted message, so the
   * key is only readable by someone who could read that message.
   */
  key: string;
  iv: string;
  mime: string;
  name: string;
  size: number;
  width?: number;
  height?: number;
};

/**
 * Reference to the message being replied to.
 *
 * The preview is a copy of the quoted plaintext rather than a lookup, so a
 * reply still renders its quote when the original is outside loaded history.
 */
export type ReplyRef = {
  message_id: string;
  sender_id: string;
  preview: string;
};

/**
 * Decrypted message body. Plain text messages are stored as a bare string for
 * backward compatibility; anything with an attachment or a reply uses this
 * envelope, tagged with `_wc` so a user typing raw JSON is not mistaken for one.
 */
export type StructuredMessagePayload = {
  _wc: 1;
  kind?: 'message';
  caption: string;
  attachment?: ImageAttachment;
  reply_to?: ReplyRef;
};

/**
 * A reaction travels as an ordinary encrypted message rather than a plaintext
 * column, so the server learns only that a message was sent — never which
 * message was reacted to, nor with what.
 */
export type ReactionPayload = {
  _wc: 1;
  kind: 'reaction';
  target_message_id: string;
  emoji: string;
  action: 'add' | 'remove';
};

export type MessageEnvelope = StructuredMessagePayload | ReactionPayload;

/** A decoded reaction, tagged with who sent it and when it was sent. */
export type ReactionEvent = {
  id: string;
  targetMessageId: string;
  senderId: string;
  emoji: string;
  action: 'add' | 'remove';
  sentAt: string;
};

/** Folded reaction state for one message: an emoji and who chose it. */
export type ReactionTally = {
  emoji: string;
  userIds: string[];
};

export type ChatMessageRecord = {
  message_id: string;
  chat_id: string;
  sender_id: string;
  /** Which installation sent it; the receiver keys its ratchet session on this. */
  sender_device_row_id: string | null;
  /** The one envelope addressed to this device. */
  ciphertext: string;
  status: string;
  is_media: boolean;
  sent_at: string;
  client_message_id: string;
};

export type TypingEvent = {
  type: 'typing';
  chat_id: string;
  sender_id: string;
  target_id: string;
  is_typing: boolean;
  sent_at?: string;
};

/**
 * A sender key distribution for a group, addressed to one member.
 *
 * Encrypted with the pairwise session between sender and target, so the server relays
 * bytes it cannot read, and never stores it.
 */
export type SenderKeyEvent = {
  type: 'sender_key';
  chat_id: string;
  sender_id: string;
  sender_device_id?: string;
  /** Server-resolved, so the recipient keys its session on a verified value. */
  sender_device_row_id?: string | null;
  target_id: string;
  ciphertext: string;
  sent_at?: string;
};

export type PresenceEvent = {
  type: 'presence';
  chat_id: string;
  user_id: string;
  target_id: string;
  state: 'online' | 'offline';
  sent_at?: string;
};

export type CallMediaKind = 'audio' | 'video';

export type WebRtcSignalType =
  | 'webrtc_offer'
  | 'webrtc_answer'
  | 'webrtc_ice'
  | 'webrtc_hangup'
  | 'webrtc_reject';

export type WebRtcSignalEvent = {
  type: WebRtcSignalType;
  chat_id: string;
  call_id: string;
  sender_id: string;
  target_id: string;
  media: CallMediaKind;
  payload: Record<string, unknown>;
  sent_at?: string;
};

export type ErrorEvent = {
  type: 'error';
  detail: string;
};

export type RealtimeEvent =
  | ChatMessageEvent
  | TypingEvent
  | PresenceEvent
  | SenderKeyEvent
  | WebRtcSignalEvent
  | ErrorEvent;

export type ChatHistoryResponse = {
  items: ChatMessageRecord[];
};

export type DisplayMessage = {
  id: string;
  clientMessageId: string;
  serverMessageId?: string;
  senderId: string;
  body: string;
  attachment?: ImageAttachment;
  replyTo?: ReplyRef;
  sentAt: string;
  state: 'sending' | 'sent' | 'failed';
};

export type BootstrapUser = {
  id: string;
  username: string;
  display_name: string;
  initials: string;
  presence_state: 'online' | 'offline';
};

export type BootstrapChatMember = {
  user_id: string;
  username: string;
  display_name: string;
  initials: string;
  presence_state: 'online' | 'offline';
};

export type BootstrapChat = {
  id: string;
  name: string;
  type: string;
  /** Drives the Rooms / Direct split in the sidebar. */
  kind: 'room' | 'direct';
  member_count: number;
  summary: string;
  members: BootstrapChatMember[];
};

export type BootstrapResponse = {
  users: BootstrapUser[];
  chats: BootstrapChat[];
};
