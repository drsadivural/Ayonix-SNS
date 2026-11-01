import { useCallback, useContext, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { api, toApiError, type ApiRequestError } from './api';
import { WorkspaceIdContext } from './workspace-context';

export interface ApiState<T> {
  data: T | undefined;
  error: ApiRequestError | undefined;
  /** True while the current request has not settled. */
  loading: boolean;
  /** True when re-fetching while older data is still shown. */
  refreshing: boolean;
  /** Epoch ms of the last successful load. */
  loadedAt: number | null;
  reload: () => void;
  /** Replace the data locally (after a mutation returned the new value). */
  setData: (data: T) => void;
}

interface Settled<T> {
  key: string | null;
  path: string | null;
  data: T | undefined;
  error: ApiRequestError | undefined;
  loadedAt: number | null;
}

/**
 * GET an API path. `null` skips the request. Older data for the same path
 * is kept while reloading or after a failed reload so the UI can show it as
 * stale rather than blanking the page.
 */
export function useApi<T>(path: string | null, workspaceScoped = true): ApiState<T> {
  const [nonce, setNonce] = useState(0);
  const selected = useContext(WorkspaceIdContext);
  const ws = workspaceScoped ? selected : null;
  const key = path === null ? null : `${ws ?? ''}|${path}|${nonce}`;
  const [settled, setSettled] = useState<Settled<T>>({ key: null, path: null, data: undefined, error: undefined, loadedAt: null });

  useEffect(() => {
    if (key === null || path === null) return;
    const ctrl = new AbortController();
    api<T>(path, { signal: ctrl.signal, ...(workspaceScoped ? { workspaceId: ws } : {}) }).then(
      (data) => {
        if (!ctrl.signal.aborted) setSettled({ key, path, data, error: undefined, loadedAt: Date.now() });
      },
      (err: unknown) => {
        if (ctrl.signal.aborted) return;
        setSettled((prev) => ({
          key,
          path,
          data: prev.path === path ? prev.data : undefined,
          error: toApiError(err),
          loadedAt: prev.path === path ? prev.loadedAt : null,
        }));
      },
    );
    return () => ctrl.abort();
  }, [key, path, ws, workspaceScoped]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  const setData = useCallback(
    (data: T) => setSettled((prev) => ({ ...prev, data, error: undefined, loadedAt: Date.now() })),
    [],
  );

  const samePath = settled.path === path && path !== null;
  const loading = key !== null && settled.key !== key;
  return {
    data: samePath ? settled.data : undefined,
    error: settled.key === key ? settled.error : undefined,
    loading,
    refreshing: loading && samePath && settled.data !== undefined,
    loadedAt: samePath ? settled.loadedAt : null,
    reload,
    setData,
  };
}

/** Repeatedly call `tick` while `active`; stop when it returns true. */
export function usePoll(tick: () => Promise<boolean | void>, intervalMs: number, active: boolean): void {
  const tickRef = useRef(tick);
  useEffect(() => {
    tickRef.current = tick;
  });
  useEffect(() => {
    if (!active) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    const run = async () => {
      let done: boolean | void;
      try {
        done = await tickRef.current();
      } catch {
        done = false;
      }
      if (!stopped && !done) timer = setTimeout(run, intervalMs);
    };
    timer = setTimeout(run, intervalMs);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [active, intervalMs]);
}

function subscribeOnline(cb: () => void) {
  window.addEventListener('online', cb);
  window.addEventListener('offline', cb);
  return () => {
    window.removeEventListener('online', cb);
    window.removeEventListener('offline', cb);
  };
}

export function useOnline(): boolean {
  return useSyncExternalStore(subscribeOnline, () => navigator.onLine, () => true);
}

function subscribeMedia(query: string) {
  return (cb: () => void) => {
    const m = window.matchMedia(query);
    m.addEventListener('change', cb);
    return () => m.removeEventListener('change', cb);
  };
}

export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    subscribeMedia(query),
    () => (typeof window.matchMedia === 'function' ? window.matchMedia(query).matches : false),
    () => false,
  );
}

/** Run an async action with pending/error state. */
export function useAction<A extends unknown[], R>(fn: (...args: A) => Promise<R>) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ApiRequestError | undefined>(undefined);
  const fnRef = useRef(fn);
  useEffect(() => {
    fnRef.current = fn;
  });
  const run = useCallback(async (...args: A): Promise<R | undefined> => {
    setPending(true);
    setError(undefined);
    try {
      return await fnRef.current(...args);
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') return undefined;
      setError(toApiError(e));
      return undefined;
    } finally {
      setPending(false);
    }
  }, []);
  const clear = useCallback(() => setError(undefined), []);
  return { run, pending, error, clear };
}
