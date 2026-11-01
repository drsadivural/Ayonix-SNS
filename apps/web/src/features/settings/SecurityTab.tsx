import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { Banner, Field, Loading } from '../../components/ui';
import { authClient, authFailure, type AuthFailure } from '../../lib/auth';
import { formatDateTime } from '../../lib/format';
import { useSession, useWorkspace } from '../../state/session';

interface SessionRow {
  id: string;
  token?: string;
  createdAt: string | Date;
  updatedAt?: string | Date;
  userAgent?: string | null;
  ipAddress?: string | null;
}

function iso(d: string | Date | undefined): string | null {
  if (!d) return null;
  return typeof d === 'string' ? d : d.toISOString();
}

export function SecurityTab() {
  const ws = useWorkspace();
  const { me } = useSession();
  const [sessions, setSessions] = useState<SessionRow[] | null>(null);
  const [sessionsError, setSessionsError] = useState<AuthFailure | null>(null);
  const [nonce, setNonce] = useState(0);
  const [revoking, setRevoking] = useState(false);
  const [revokeMsg, setRevokeMsg] = useState<string | null>(null);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [pwMsg, setPwMsg] = useState<string | null>(null);
  const [pwFailure, setPwFailure] = useState<AuthFailure | null>(null);
  const [pwPending, setPwPending] = useState(false);

  useEffect(() => {
    let cancelled = false;
    authClient
      .listSessions()
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error) setSessionsError(authFailure(error));
        else setSessions((data ?? []) as SessionRow[]);
      })
      .catch(() => {
        if (!cancelled) setSessionsError(authFailure({ status: 0 }));
      });
    return () => {
      cancelled = true;
    };
  }, [nonce]);

  async function changePassword(e: FormEvent) {
    e.preventDefault();
    setPwMsg(null);
    setPwFailure(null);
    if (next.length < 10) {
      setPwFailure({ message: 'Use at least 10 characters for the new password.', code: null, status: 400 });
      return;
    }
    setPwPending(true);
    try {
      const { error } = await authClient.changePassword({ currentPassword: current, newPassword: next, revokeOtherSessions: true });
      if (error) setPwFailure(authFailure(error));
      else {
        setPwMsg('Password changed. Other sessions were signed out.');
        setCurrent('');
        setNext('');
        setNonce((n) => n + 1);
      }
    } catch {
      setPwFailure(authFailure({ status: 0 }));
    } finally {
      setPwPending(false);
    }
  }

  return (
    <div className="grid-2">
      <section className="card stack" aria-labelledby="sess-h">
        <h2 id="sess-h">Sessions</h2>
        <p className="small muted">Signed in as {me?.identity.email}.</p>
        {sessions === null && !sessionsError ? <Loading label="Loading sessions…" /> : null}
        {sessionsError ? (
          <Banner tone="warning" title="Sessions could not be listed">
            {sessionsError.message}
          </Banner>
        ) : null}
        {sessions ? (
          <ul className="media-list">
            {sessions.map((s) => (
              <li key={s.id} className="media-item" style={{ display: 'grid' }}>
                <span className="small">{s.userAgent || 'Unknown device'}</span>
                <span className="tiny muted">
                  Signed in {iso(s.createdAt) ? formatDateTime(iso(s.createdAt), ws.timezone) : 'Not available'}
                  {s.ipAddress ? ` · ${s.ipAddress}` : ''}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
        <div role="status" aria-live="polite">
          {revokeMsg ? <Banner tone="info">{revokeMsg}</Banner> : null}
        </div>
        <div className="form-actions">
          <button
            type="button"
            className="btn"
            disabled={revoking}
            onClick={async () => {
              setRevoking(true);
              setRevokeMsg(null);
              try {
                const { error } = await authClient.revokeOtherSessions();
                setRevokeMsg(error ? authFailure(error).message : 'All other sessions were signed out.');
                setNonce((n) => n + 1);
              } catch {
                setRevokeMsg(authFailure({ status: 0 }).message);
              } finally {
                setRevoking(false);
              }
            }}
          >
            {revoking ? 'Signing out…' : 'Sign out other sessions'}
          </button>
        </div>
      </section>
      <section className="card stack" aria-labelledby="pw-h">
        <h2 id="pw-h">Change password</h2>
        <form className="stack" onSubmit={changePassword}>
          <Field label="Current password">
            <input className="input" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
          </Field>
          <Field label="New password" hint="At least 10 characters.">
            <input className="input" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
          </Field>
          {pwFailure ? (
            <Banner tone="danger" role="alert">
              {pwFailure.message}
            </Banner>
          ) : null}
          <div role="status" aria-live="polite">
            {pwMsg ? <Banner tone="success">{pwMsg}</Banner> : null}
          </div>
          <div className="form-actions">
            <button type="submit" className="btn btn-primary" disabled={pwPending || !current || !next}>
              {pwPending ? 'Saving…' : 'Change password'}
            </button>
          </div>
        </form>
        <p className="small muted">
          Signed in with Google or forgot your password? <Link to="/forgot-password">Reset it by email</Link>.
        </p>
      </section>
    </div>
  );
}
