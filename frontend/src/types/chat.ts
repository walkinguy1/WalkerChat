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
  encryption: EncryptionMetadata;
  sent_at?: string;
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

export type WebRtcSignalEvent = {
  type: 'webrtc_offer' | 'webrtc_answer' | 'webrtc_ice';
  sender_id: string;
  target_id: string;
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
