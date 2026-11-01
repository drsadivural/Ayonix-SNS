// Light/dark theme: follows the system preference unless the person picks
// one explicitly. The choice is stored per browser.
import { useSyncExternalStore } from 'react';
import { STORAGE_KEYS, readStorage, writeStorage } from './storage';

export type ThemeChoice = 'system' | 'light' | 'dark';

const listeners = new Set<() => void>();

function readChoice(): ThemeChoice {
  const v = readStorage(STORAGE_KEYS.theme);
  return v === 'light' || v === 'dark' ? v : 'system';
}

export function applyTheme(choice: ThemeChoice = readChoice()): void {
  const root = document.documentElement;
  if (choice === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', choice);
}

export function setTheme(choice: ThemeChoice): void {
  writeStorage(STORAGE_KEYS.theme, choice === 'system' ? null : choice);
  applyTheme(choice);
  listeners.forEach((l) => l());
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useTheme(): ThemeChoice {
  return useSyncExternalStore(subscribe, readChoice, () => 'system');
}
