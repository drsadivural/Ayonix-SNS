// Signed-in identity, workspace selection and the selected workspace summary.
// Workspace and role always come from GET /api/v1/me and /workspace; the
// stored selection is only a preference and is validated against membership.
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Me, WorkspaceSummary } from '@ayonix/contracts';
import { api, setApiWorkspace, toApiError, type ApiRequestError } from '../lib/api';
import { authClient } from '../lib/auth';
import { STORAGE_KEYS, readStorage, writeStorage } from '../lib/storage';
import { WorkspaceIdContext } from '../lib/workspace-context';

export type SessionStatus = 'loading' | 'signed_out' | 'ready' | 'error';

export interface SessionValue {
  status: SessionStatus;
  me: Me | null;
  error: ApiRequestError | null;
  workspaceId: string | null;
  workspace: WorkspaceSummary | null;
  workspaceError: ApiRequestError | null;
  workspaceLoading: boolean;
  selectWorkspace: (id: string) => void;
  refreshMe: (preferWorkspace?: string) => Promise<Me | null>;
  refreshWorkspace: () => void;
  setWorkspace: (w: WorkspaceSummary) => void;
  signOut: () => Promise<void>;
}

const SessionContext = createContext<SessionValue | null>(null);

interface MeState {
  status: SessionStatus;
  me: Me | null;
  error: ApiRequestError | null;
  workspaceId: string | null;
}

interface WsState {
  key: string | null;
  workspace: WorkspaceSummary | null;
  error: ApiRequestError | null;
}

function pickWorkspace(me: Me, prefer?: string): string | null {
  const ids = me.workspaces.map((w) => w.id);
  if (prefer && ids.includes(prefer)) return prefer;
  const stored = readStorage(STORAGE_KEYS.workspace);
  if (stored && ids.includes(stored)) return stored;
  return ids[0] ?? null;
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [meState, setMeState] = useState<MeState>({ status: 'loading', me: null, error: null, workspaceId: null });
  const [wsNonce, setWsNonce] = useState(0);
  const [wsState, setWsState] = useState<WsState>({ key: null, workspace: null, error: null });

  const applyMe = useCallback((me: Me, prefer?: string) => {
    const id = pickWorkspace(me, prefer);
    setApiWorkspace(id);
    if (id) writeStorage(STORAGE_KEYS.workspace, id);
    setMeState({ status: 'ready', me, error: null, workspaceId: id });
  }, []);

  const handleMeError = useCallback((e: unknown) => {
    const err = toApiError(e);
    setApiWorkspace(null);
    if (err.status === 401) setMeState({ status: 'signed_out', me: null, error: null, workspaceId: null });
    else setMeState((prev) => ({ ...prev, status: 'error', error: err }));
  }, []);

  useEffect(() => {
    const ctrl = new AbortController();
    api<Me>('/me', { signal: ctrl.signal, workspaceId: null }).then(
      (me) => applyMe(me),
      (e: unknown) => {
        if (!ctrl.signal.aborted) handleMeError(e);
      },
    );
    return () => ctrl.abort();
  }, [applyMe, handleMeError]);

  const refreshMe = useCallback(
    async (prefer?: string) => {
      try {
        const me = await api<Me>('/me', { workspaceId: null });
        applyMe(me, prefer);
        setWsNonce((n) => n + 1);
        return me;
      } catch (e) {
        handleMeError(e);
        return null;
      }
    },
    [applyMe, handleMeError],
  );

  const workspaceId = meState.workspaceId;
  const verified = meState.me?.identity.email_verified ?? false;
  const wsKey = workspaceId && verified ? `${workspaceId}|${wsNonce}` : null;

  useEffect(() => {
    if (!wsKey || !workspaceId) return;
    const ctrl = new AbortController();
    api<WorkspaceSummary>('/workspace', { signal: ctrl.signal, workspaceId }).then(
      (workspace) => {
        if (!ctrl.signal.aborted) setWsState({ key: wsKey, workspace, error: null });
      },
      (e: unknown) => {
        if (ctrl.signal.aborted) return;
        const err = toApiError(e);
        if (err.status === 401) {
          setApiWorkspace(null);
          setMeState({ status: 'signed_out', me: null, error: null, workspaceId: null });
        }
        setWsState((prev) => ({ key: wsKey, workspace: prev.workspace?.id === workspaceId ? prev.workspace : null, error: err }));
      },
    );
    return () => ctrl.abort();
  }, [wsKey, workspaceId]);

  const selectWorkspace = useCallback((id: string) => {
    setApiWorkspace(id);
    writeStorage(STORAGE_KEYS.workspace, id);
    setMeState((prev) => ({ ...prev, workspaceId: id }));
  }, []);

  const refreshWorkspace = useCallback(() => setWsNonce((n) => n + 1), []);
  const setWorkspace = useCallback((w: WorkspaceSummary) => setWsState((prev) => ({ ...prev, workspace: w, error: null })), []);

  const signOut = useCallback(async () => {
    try {
      await authClient.signOut();
    } finally {
      setApiWorkspace(null);
      setMeState({ status: 'signed_out', me: null, error: null, workspaceId: null });
      setWsState({ key: null, workspace: null, error: null });
    }
  }, []);

  const workspace = wsState.workspace && wsState.workspace.id === workspaceId ? wsState.workspace : null;
  const value = useMemo<SessionValue>(
    () => ({
      status: meState.status,
      me: meState.me,
      error: meState.error,
      workspaceId,
      workspace,
      workspaceError: wsState.key === wsKey ? wsState.error : null,
      workspaceLoading: wsKey !== null && wsState.key !== wsKey,
      selectWorkspace,
      refreshMe,
      refreshWorkspace,
      setWorkspace,
      signOut,
    }),
    [meState, workspaceId, workspace, wsState, wsKey, selectWorkspace, refreshMe, refreshWorkspace, setWorkspace, signOut],
  );

  return (
    <SessionContext.Provider value={value}>
      <WorkspaceIdContext.Provider value={workspaceId}>{children}</WorkspaceIdContext.Provider>
    </SessionContext.Provider>
  );
}

export function useSession(): SessionValue {
  const v = useContext(SessionContext);
  if (!v) throw new Error('useSession must be used inside SessionProvider');
  return v;
}

/** The selected workspace summary; only call under a route that guarantees it is loaded. */
export function useWorkspace(): WorkspaceSummary {
  const { workspace } = useSession();
  if (!workspace) throw new Error('Workspace not loaded');
  return workspace;
}
