// localStorage can throw (privacy mode, disabled storage, quota). Nothing the
// app stores here is required for correctness: losing it only loses a
// convenience (selected workspace, theme, current draft ids).

export function readStorage(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeStorage(key: string, value: string | null): void {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    // Storage unavailable: keep working without persistence.
  }
}

export function readJson<T>(key: string): T | null {
  const raw = readStorage(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function writeJson(key: string, value: unknown): void {
  writeStorage(key, value === null || value === undefined ? null : JSON.stringify(value));
}

export const STORAGE_KEYS = {
  workspace: 'ayonix.workspace',
  theme: 'ayonix.theme',
  draft: (workspaceId: string) => `ayonix.draft.${workspaceId}`,
} as const;

/** Random id for idempotency keys (kept outside render code paths). */
export function newKey(): string {
  return crypto.randomUUID();
}
