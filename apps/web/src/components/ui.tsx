import { cloneElement, isValidElement, useId, type ReactElement, type ReactNode } from 'react';
import { Link } from 'react-router';
import type { TargetState } from '@ayonix/contracts';
import type { ApiRequestError } from '../lib/api';
import { formatMetric, NOT_AVAILABLE } from '../lib/format';
import { TARGET_STATE_INFO, type Tone } from '../lib/labels';

export function Badge({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
  return <span className={`badge tone-${tone}`}>{children}</span>;
}

export function StatusBadge({ state }: { state: TargetState }) {
  const info = TARGET_STATE_INFO[state];
  return <Badge tone={info.tone}>{info.label}</Badge>;
}

export function Banner({
  tone = 'info',
  title,
  children,
  action,
  role,
}: {
  tone?: Tone;
  title?: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
  role?: 'status' | 'alert';
}) {
  return (
    <div className={`banner tone-${tone}`} role={role ?? (tone === 'danger' ? 'alert' : 'status')}>
      <div className="banner-body">
        {title ? <p className="banner-title">{title}</p> : null}
        {children ? <div>{children}</div> : null}
      </div>
      {action ? <div className="row">{action}</div> : null}
    </div>
  );
}

function errorTitle(e: ApiRequestError): string {
  if (e.isNetwork) return 'Connection problem';
  switch (e.code) {
    case 'forbidden':
      return 'Permission denied';
    case 'entitlement_required':
      return 'Not included in the current plan';
    case 'quota_exceeded':
      return 'Quota exceeded';
    case 'version_conflict':
    case 'conflict':
      return 'This changed elsewhere';
    case 'not_found':
      return 'Not found';
    case 'unauthenticated':
      return 'Sign in required';
    case 'not_configured':
      return 'Not available on this deployment';
    case 'rate_limited':
      return 'Too many requests';
    case 'invalid_request':
    case 'unprocessable':
      return 'Check the details';
    default:
      return 'Something went wrong';
  }
}

/** Shows the real server message, request id, and a retry action when sensible. */
export function ErrorNotice({ error, onRetry, retrying }: { error: ApiRequestError; onRetry?: () => void; retrying?: boolean }) {
  const fieldErrors = Object.entries(error.fieldErrors);
  const showBilling = error.code === 'quota_exceeded' || error.code === 'entitlement_required';
  return (
    <Banner
      tone={error.code === 'forbidden' || error.code === 'not_configured' ? 'warning' : 'danger'}
      title={errorTitle(error)}
      role="alert"
      action={
        <>
          {showBilling ? (
            <Link className="btn btn-sm" to="/billings">
              View billing
            </Link>
          ) : null}
          {error.code === 'unauthenticated' ? (
            <Link className="btn btn-sm" to="/login">
              Sign in
            </Link>
          ) : null}
          {onRetry && error.code !== 'forbidden' ? (
            <button type="button" className="btn btn-sm" onClick={onRetry} disabled={retrying}>
              {retrying ? 'Retrying…' : 'Try again'}
            </button>
          ) : null}
        </>
      }
    >
      <p>{error.message}</p>
      {fieldErrors.length ? (
        <ul className="problem-list">
          {fieldErrors.map(([k, v]) => (
            <li key={k}>
              <span className="strong">{k.replace(/[._]/g, ' ')}:</span> {v}
            </li>
          ))}
        </ul>
      ) : null}
      {error.retryAfterSeconds ? <p className="small">You can try again in about {error.retryAfterSeconds} seconds.</p> : null}
      {error.requestId ? <p className="tiny">Reference: <span className="mono">{error.requestId}</span></p> : null}
    </Banner>
  );
}

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="loading" role="status" aria-live="polite">
      <span className="spinner" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}

export function SkeletonLines({ lines = 3 }: { lines?: number }) {
  return (
    <div className="stack-sm" aria-hidden="true">
      {Array.from({ length: lines }, (_, i) => (
        <div key={i} className="skeleton" style={{ width: `${90 - i * 15}%` }} />
      ))}
    </div>
  );
}

export function EmptyState({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <h3>{title}</h3>
      {children ? <div className="muted small">{children}</div> : null}
      {action}
    </div>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="page-header">
      <div>
        <h1 id="page-title">{title}</h1>
        {subtitle ? <p className="subtitle">{subtitle}</p> : null}
      </div>
      {actions ? <div className="page-actions">{actions}</div> : null}
    </header>
  );
}

/**
 * Labelled form control. The child input/select/textarea receives id,
 * aria-describedby and aria-invalid automatically.
 */
export function Field({ label, hint, error, children, className }: { label: ReactNode; hint?: ReactNode; error?: string | undefined; children: ReactElement; className?: string }) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errId = error ? `${id}-err` : undefined;
  const describedBy = [hintId, errId].filter(Boolean).join(' ') || undefined;
  const child = isValidElement(children)
    ? cloneElement(children as ReactElement<Record<string, unknown>>, {
        id,
        'aria-describedby': describedBy,
        'aria-invalid': error ? true : undefined,
      })
    : children;
  return (
    <div className={`field ${className ?? ''}`}>
      <label htmlFor={id}>{label}</label>
      {child}
      {hint ? (
        <p id={hintId} className="hint">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errId} className="field-error">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** Metric card. `value === null` means unavailable — never rendered as 0. */
export function StatCard({ label, value, note, delta }: { label: string; value: number | null | undefined; note?: ReactNode; delta?: ReactNode }) {
  const unavailable = value === null || value === undefined;
  return (
    <section className="card stat" aria-label={label}>
      <h2 className="stat-label">{label}</h2>
      <p className={`stat-value ${unavailable ? 'unavailable' : ''}`}>{unavailable ? NOT_AVAILABLE : formatMetric(value)}</p>
      {delta ? <p className="delta">{delta}</p> : null}
      {note ? <p className="stat-note">{note}</p> : null}
    </section>
  );
}

export function StaleNotice({ loadedAt, error, onRetry, refreshing }: { loadedAt: number | null; error?: ApiRequestError | undefined; onRetry: () => void; refreshing?: boolean }) {
  if (refreshing) {
    return (
      <p className="small muted" role="status" aria-live="polite">
        Refreshing…
      </p>
    );
  }
  if (!error || !loadedAt) return null;
  const at = new Date(loadedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return (
    <Banner
      tone="warning"
      title="Showing older data"
      action={
        <button type="button" className="btn btn-sm" onClick={onRetry}>
          Try again
        </button>
      }
    >
      <p>
        Last updated at {at}. Refreshing failed: {error.message}
        {error.requestId ? <span className="tiny"> (Reference: {error.requestId})</span> : null}
      </p>
    </Banner>
  );
}

export function LiveRegion({ children }: { children: ReactNode }) {
  return (
    <div role="status" aria-live="polite" className="small">
      {children}
    </div>
  );
}
