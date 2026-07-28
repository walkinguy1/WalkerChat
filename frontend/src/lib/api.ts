import type { BootstrapResponse, ChatHistoryResponse } from '../types/chat';

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

export type PrekeyBundle = {
  user_id: string;
  identity_key_pub: string;
  signed_prekey_pub: string;
  one_time_prekey: string | null;
  one_time_prekey_id: string | null;
};

export const fetchPrekeyBundle = async (
  apiUrl: string,
  targetUserId: string,
  token: string,
): Promise<PrekeyBundle> => {
  const response = await fetch(`${apiUrl}/api/keys/${targetUserId}/bundle`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    throw new Error(await readErrorMessage(response, `Prekey bundle request failed with status ${response.status}`));
  }
  return (await response.json()) as PrekeyBundle;
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

export const uploadIdentityKeys = async (
  apiUrl: string,
  token: string,
  identityKeyPub: string,
  signedPrekeyPub: string,
): Promise<void> => {
  const response = await fetch(`${apiUrl}/api/keys/identity`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      identity_key_pub: identityKeyPub,
      signed_prekey_pub: signedPrekeyPub,
    }),
  });

  if (!response.ok) {
    throw new Error(
      await readErrorMessage(response, `Identity key upload failed with status ${response.status}`),
    );
  }
};
