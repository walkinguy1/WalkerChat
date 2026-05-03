import type { BootstrapResponse, ChatHistoryResponse } from '../types/chat';

export const fetchBootstrap = async (apiUrl: string) => {
  const response = await fetch(`${apiUrl}/api/bootstrap`);
  if (!response.ok) {
    throw new Error(`Bootstrap request failed with status ${response.status}`);
  }

  return (await response.json()) as BootstrapResponse;
};

export const fetchHistory = async (
  apiUrl: string,
  chatId: string,
  viewerId: string,
) => {
  const response = await fetch(`${apiUrl}/api/chats/${chatId}/messages?viewer_id=${viewerId}`);
  if (!response.ok) {
    throw new Error(`History request failed with status ${response.status}`);
  }

  return (await response.json()) as ChatHistoryResponse;
};
