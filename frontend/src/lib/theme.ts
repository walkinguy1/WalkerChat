import { useSyncExternalStore } from 'react';

export type ThemePreference = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

const STORAGE_KEY = 'walkerchat-theme';

const listeners = new Set<() => void>();
const systemQuery =
  typeof window === 'undefined' ? null : window.matchMedia('(prefers-color-scheme: light)');

const readStoredPreference = (): ThemePreference => {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored === 'light' || stored === 'dark' ? stored : 'system';
  } catch {
    return 'system';
  }
};

let preference: ThemePreference = readStoredPreference();

const resolve = (value: ThemePreference): ResolvedTheme => {
  if (value !== 'system') {
    return value;
  }
  return systemQuery?.matches ? 'light' : 'dark';
};

const emit = () => {
  document.documentElement.dataset.theme = resolve(preference);
  listeners.forEach((listener) => listener());
};

// Following the OS is only meaningful while the preference is 'system'.
systemQuery?.addEventListener('change', () => {
  if (preference === 'system') {
    emit();
  }
});

export const setThemePreference = (next: ThemePreference) => {
  preference = next;

  try {
    if (next === 'system') {
      localStorage.removeItem(STORAGE_KEY);
    } else {
      localStorage.setItem(STORAGE_KEY, next);
    }
  } catch {
    // Private-mode browsers can refuse writes; the in-memory value still works.
  }

  emit();
};

/** Flip between light and dark, dropping out of 'system' in the process. */
export const toggleTheme = () => {
  setThemePreference(resolve(preference) === 'dark' ? 'light' : 'dark');
};

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export const useTheme = () => {
  const resolved = useSyncExternalStore(
    subscribe,
    () => resolve(preference),
    () => 'dark' as ResolvedTheme,
  );

  return { theme: resolved, preference, setThemePreference, toggleTheme };
};
