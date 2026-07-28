import { useSyncExternalStore } from 'react';

export type ToastTone = 'error' | 'info' | 'success';

export type Toast = {
  id: string;
  tone: ToastTone;
  message: string;
};

const DISMISS_AFTER_MS: Record<ToastTone, number> = {
  error: 7000,
  info: 4500,
  success: 3500,
};

let toasts: Toast[] = [];
const listeners = new Set<() => void>();

const emit = () => {
  listeners.forEach((listener) => listener());
};

export const dismissToast = (id: string) => {
  const next = toasts.filter((toast) => toast.id !== id);
  if (next.length !== toasts.length) {
    toasts = next;
    emit();
  }
};

export const pushToast = (message: string, tone: ToastTone = 'error') => {
  // Repeating the same message (a reconnect loop, say) should refresh the
  // existing toast rather than stack duplicates.
  const duplicate = toasts.find((toast) => toast.message === message && toast.tone === tone);
  if (duplicate) {
    return duplicate.id;
  }

  const id = crypto.randomUUID();
  toasts = [...toasts, { id, tone, message }].slice(-4);
  emit();

  window.setTimeout(() => dismissToast(id), DISMISS_AFTER_MS[tone]);
  return id;
};

export const clearToasts = () => {
  if (toasts.length) {
    toasts = [];
    emit();
  }
};

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

const emptySnapshot: Toast[] = [];

export const useToasts = () =>
  useSyncExternalStore(
    subscribe,
    () => toasts,
    () => emptySnapshot,
  );
