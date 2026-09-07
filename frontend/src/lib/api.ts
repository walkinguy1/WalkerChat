import type { BootstrapResponse, ChatHistoryResponse } from '../types/chat';
import type { EncodedDeviceBundles, PublishablePreKeys } from './crypto/session';

type TokenResponse = {
  access_token: string;
  token_type: string;
  user_id: string;
};

type WebSocketTicketResponse = {
  ticket: string;
  expires_in_seconds: number;
};

const readErrorMessage = async (response: Response, fallback: string) => {
  try {
    const payload = (await response.json()) as { detail?: string };
    return payload.detail ?? fallback;
  } catch {
    return fallback;
  }
};

export const login = async (
  apiUrl: string,
  username: string,
  password: string,
): Promise<TokenResponse> => {
  const response = await fetch(`${apiUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });

  if (!response.ok) {
    throw new Error(await readErrorMessage(response, `Login failed with status ${response.status}`));
  }

  return (await response.json()) as TokenResponse;
};

export const logout = async (apiUrl: string, token: string): Promise<void> => {
  const response = await fetch(`${apiUrl}/api/auth/logout`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!response.ok && response.status !== 204) {
    throw new Error(await readErrorMessage(response, `Logout failed with status ${response.status}`));
  }
};

export const fetchWsTicket = async (
  apiUrl: string,
  token: string,
): Promise<WebSocketTicketResponse> => {
  const response = await fetch(`${apiUrl}/api/auth/ws-ticket`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!response.ok) {
    throw new Error(
      await readErrorMessage(response, `WebSocket ticket failed with status ${response.status}`),
    );
  }

  return (await response.json()) as WebSocketTicketResponse;
};

export const fetchBootstrap = async (apiUrl: string, token: string) => {
  const response = await fetch(`${apiUrl}/api/bootstrap`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    throw new Error(await readErrorMessage(response, `Bootstrap request failed with status ${response.status}`));
  }

  return (await response.json()) as BootstrapResponse;
};

export const fetchHistory = async (
  apiUrl: string,
  chatId: string,
  token: string,
  deviceId?: string,
) => {
  // History is per device: each message is stored as one envelope per recipient
  // installation, so which ciphertext comes back depends on who is asking.
  const query = deviceId ? `?device_id=${encodeURIComponent(deviceId)}` : '';
  const response = await fetch(`${apiUrl}/api/chats/${chatId}/messages${query}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    throw new Error(await readErrorMessage(response, `History request failed with status ${response.status}`));
  }

  return (await response.json()) as ChatHistoryResponse;
};

/**
 * Claim a prekey bundle.
 *
 * This is a POST because it consumes one of the target's one-time prekeys. It used to
 * be a GET that mutated state, so any prefetch or retry silently burned prekeys.
 */
export const claimPrekeyBundle = async (
  apiUrl: string,
  targetUserId: string,
  token: string,
): Promise<EncodedDeviceBundles> => {
  const response = await fetch(`${apiUrl}/api/keys/${targetUserId}/bundle`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    throw new Error(
      await readErrorMessage(response, `Prekey bundle request failed with status ${response.status}`),
    );
  }
  return (await response.json()) as EncodedDeviceBundles;
};

export type MediaUploadResponse = {
  media_id: string;
  chat_id: string;
  size_bytes: number;
  created_at: string;
};

/** POST already-encrypted image bytes. The server never sees the plaintext. */
export const uploadEncryptedMedia = async (
  apiUrl: string,
  chatId: string,
  token: string,
  ciphertext: ArrayBuffer,
): Promise<MediaUploadResponse> => {
  const form = new FormData();
  form.append('file', new Blob([ciphertext], { type: 'application/octet-stream' }), 'blob.bin');

  const response = await fetch(`${apiUrl}/api/media/${chatId}/upload`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });

  if (!response.ok) {
    throw new Error(
      await readErrorMessage(response, `Media upload failed with status ${response.status}`),
    );
  }

  return (await response.json()) as MediaUploadResponse;
};

/** Fetch encrypted image bytes back. Decryption happens in the caller. */
export const fetchEncryptedMedia = async (
  apiUrl: string,
  mediaId: string,
  token: string,
): Promise<ArrayBuffer> => {
  const response = await fetch(`${apiUrl}/api/media/${mediaId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!response.ok) {
    throw new Error(
      await readErrorMessage(response, `Media download failed with status ${response.status}`),
    );
  }

  return response.arrayBuffer();
};

export type IceConfigResponse = {
  ice_servers: { urls: string[]; username?: string | null; credential?: string | null }[];
};

export const fetchIceConfig = async (
  apiUrl: string,
  token: string,
): Promise<RTCIceServer[]> => {
  const response = await fetch(`${apiUrl}/api/webrtc/ice-config`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!response.ok) {
    throw new Error(
      await readErrorMessage(response, `ICE config failed with status ${response.status}`),
    );
  }

  const payload = (await response.json()) as IceConfigResponse;

  return payload.ice_servers.map((server) => ({
    urls: server.urls,
    ...(server.username ? { username: server.username } : {}),
    ...(server.credential ? { credential: server.credential } : {}),
  }));
};

/** Publish identity key, signed prekey and an initial batch of one-time prekeys. */
export const publishKeys = async (
  apiUrl: string,
  token: string,
  keys: PublishablePreKeys,
): Promise<{ device_row_id: string; identity_changed: boolean; one_time_prekeys_stored: number }> => {
  const response = await fetch(`${apiUrl}/api/keys/publish`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      device_id: keys.deviceId,
      identity_key: keys.identityKey,
      signed_prekey: {
        key_id: keys.signedPreKey.keyId,
        public_key: keys.signedPreKey.publicKey,
        signature: keys.signedPreKey.signature,
      },
      one_time_prekeys: keys.oneTimePreKeys.map((preKey) => ({
        key_id: preKey.keyId,
        public_key: preKey.publicKey,
      })),
    }),
  });

  if (!response.ok) {
    throw new Error(
      await readErrorMessage(response, `Key publication failed with status ${response.status}`),
    );
  }

  return (await response.json()) as {
    device_row_id: string;
    identity_changed: boolean;
    one_time_prekeys_stored: number;
  };
};

export type PrekeyCount = {
  remaining: number;
  low_water: number;
  should_replenish: boolean;
};

/** How many one-time prekeys the server still holds for us. */
export const fetchPrekeyCount = async (
  apiUrl: string,
  token: string,
  deviceId: string,
): Promise<PrekeyCount> => {
  const response = await fetch(
    `${apiUrl}/api/keys/opks/count?device_id=${encodeURIComponent(deviceId)}`,
    {
      headers: { Authorization: `Bearer ${token}` },
    },
  );
  if (!response.ok) {
    throw new Error(
      await readErrorMessage(response, `Prekey count failed with status ${response.status}`),
    );
  }
  return (await response.json()) as PrekeyCount;
};

/** Top up the one-time prekey pool before it runs dry. */
export const uploadOneTimePreKeys = async (
  apiUrl: string,
  token: string,
  deviceId: string,
  preKeys: { keyId: string; publicKey: string }[],
): Promise<void> => {
  if (preKeys.length === 0) {
    return;
  }

  const response = await fetch(`${apiUrl}/api/keys/opks`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      device_id: deviceId,
      prekeys: preKeys.map((preKey) => ({
        key_id: preKey.keyId,
        public_key: preKey.publicKey,
      })),
    }),
  });

  if (!response.ok) {
    throw new Error(
      await readErrorMessage(response, `Prekey upload failed with status ${response.status}`),
    );
  }
};

export type UserProfile = {
  id: string;
  username: string;
  display_name: string;
  initials: string;
  presence_state: 'online' | 'offline';
};

/** Username-prefix search, so a user can find someone to start a chat with. */
export const searchUsers = async (
  apiUrl: string,
  token: string,
  query: string,
): Promise<UserProfile[]> => {
  const response = await fetch(
    `${apiUrl}/api/chats/users/search?query=${encodeURIComponent(query)}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!response.ok) {
    throw new Error(
      await readErrorMessage(response, `User search failed with status ${response.status}`),
    );
  }
  return (await response.json()) as UserProfile[];
};

/** Create a direct or group chat. Direct chats are deduplicated server-side. */
export const createChat = async (
  apiUrl: string,
  token: string,
  body: { type: 'DIRECT' | 'GROUP'; name?: string; member_ids: string[] },
): Promise<{ chat_id: string; type: string }> => {
  const response = await fetch(`${apiUrl}/api/chats`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(
      await readErrorMessage(response, `Chat creation failed with status ${response.status}`),
    );
  }

  return (await response.json()) as { chat_id: string; type: string };
};

/**
 * Remove someone from a group.
 *
 * The response flags that sender keys must be rotated: removal alone does not stop the
 * departing member reading future messages, because they keep the chain keys they were
 * already given.
 */
export const removeChatMember = async (
  apiUrl: string,
  token: string,
  chatId: string,
  userId: string,
): Promise<{ sender_key_rotation_required: boolean }> => {
  const response = await fetch(`${apiUrl}/api/chats/${chatId}/members/${userId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!response.ok) {
    throw new Error(
      await readErrorMessage(response, `Member removal failed with status ${response.status}`),
    );
  }

  return (await response.json()) as { sender_key_rotation_required: boolean };
};

export type DeviceSummary = {
  device_row_id: string;
  device_id: string;
  display_name: string | null;
  identity_key: string;
  created_at: string | null;
  last_seen_at: string | null;
};

/**
 * Every device belonging to a user.
 *
 * Senders need this to know how many copies of a message to produce, and safety
 * numbers are computed over the whole set.
 */
export const fetchDevices = async (
  apiUrl: string,
  userId: string,
  token: string,
): Promise<DeviceSummary[]> => {
  const response = await fetch(`${apiUrl}/api/keys/${userId}/devices`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    throw new Error(
      await readErrorMessage(response, `Device list failed with status ${response.status}`),
    );
  }
  return (await response.json()) as DeviceSummary[];
};
