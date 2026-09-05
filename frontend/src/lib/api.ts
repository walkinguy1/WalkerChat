import type { BootstrapResponse, ChatHistoryResponse } from '../types/chat';
import type { EncodedPreKeyBundle, PublishablePreKeys } from './crypto/session';

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
) => {
  const response = await fetch(`${apiUrl}/api/chats/${chatId}/messages`, {
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
): Promise<EncodedPreKeyBundle> => {
  const response = await fetch(`${apiUrl}/api/keys/${targetUserId}/bundle`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    throw new Error(
      await readErrorMessage(response, `Prekey bundle request failed with status ${response.status}`),
    );
  }
  return (await response.json()) as EncodedPreKeyBundle;
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
): Promise<{ identity_changed: boolean; one_time_prekeys_stored: number }> => {
  const response = await fetch(`${apiUrl}/api/keys/publish`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
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

  return (await response.json()) as { identity_changed: boolean; one_time_prekeys_stored: number };
};

export type PrekeyCount = {
  remaining: number;
  low_water: number;
  should_replenish: boolean;
};

/** How many one-time prekeys the server still holds for us. */
export const fetchPrekeyCount = async (apiUrl: string, token: string): Promise<PrekeyCount> => {
  const response = await fetch(`${apiUrl}/api/keys/opks/count`, {
    headers: { Authorization: `Bearer ${token}` },
  });
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
