export type EncryptionMetadata = {
  algorithm: string;
  version: number;
  key_id: string;
};

export type ChatMessageEvent = {
  type: 'chat_message';
  chat_id: string;
  client_message_id: string;
  message_id?: string;
  sender_id: string;
  target_id: string;
  ciphertext: string;
  is_media?: boolean;
  encryption: EncryptionMetadata;
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
  iv: string;
  mime: string;
  name: string;
  size: number;
  width?: number;
  height?: number;
};

/**
 * Decrypted message body. Plain text messages are stored as a bare string for
 * backward compatibility; anything with an attachment uses this envelope,
 * tagged with `_wc` so a user typing raw JSON is not mistaken for one.
 */
export type StructuredMessagePayload = {
  _wc: 1;
  caption: string;
  attachment: ImageAttachment;
};

export type ChatMessageRecord = {
  message_id: string;
  chat_id: string;
  sender_id: string;
  ciphertext: string;
  status: string;
  is_media: boolean;
  sent_at: string;
  encryption: EncryptionMetadata;
};

export type TypingEvent = {
  type: 'typing';
  chat_id: string;
  sender_id: string;
  target_id: string;
  is_typing: boolean;
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
  sentAt: string;
  state: 'sending' | 'sent';
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
  summary: string;
  members: BootstrapChatMember[];
};

export type BootstrapResponse = {
  users: BootstrapUser[];
  chats: BootstrapChat[];
};
