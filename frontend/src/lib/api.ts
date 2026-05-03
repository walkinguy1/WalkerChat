import type { BootstrapResponse, ChatHistoryResponse } from '../types/chat';

type TokenResponse = {
  access_token: string;
  token_type: string;
  user_id: string;
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
    throw new Error(`Login failed with status ${response.status}`);
  }

  return (await response.json()) as TokenResponse;
};

export const fetchBootstrap = async (apiUrl: string, token: string) => {
  const response = await fetch(`${apiUrl}/api/bootstrap`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    throw new Error(`Bootstrap request failed with status ${response.status}`);
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
    throw new Error(`History request failed with status ${response.status}`);
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
    throw new Error(`Prekey bundle request failed with status ${response.status}`);
  }
  return (await response.json()) as PrekeyBundle;
};

export const uploadIdentityKeys = async (
  apiUrl: string,
  token: string,
  identityKeyPub: string,
  signedPrekeyPub: string,
): Promise<void> => {
  await fetch(`${apiUrl}/api/keys/identity`, {
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
};
