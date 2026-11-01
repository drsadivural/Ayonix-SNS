// Per-destination status (design: post-details.png). Honest states only:
// "Published" requires provider confirmation; processing is not published.
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import type { Target, TargetState, WorkspaceSummary } from '@ayonix/contracts';
import { LocalTimePicker, evaluateLocalTime, type LocalTimeValue } from '../../components/LocalTimePicker';
import { ConfirmDialog } from '../../components/overlay';
import { Banner, ErrorNotice, Field, Loading, StatusBadge } from '../../components/ui';
import { api } from '../../lib/api';
import { formatDateTime, formatLocalAndUtc } from '../../lib/format';
import { useAction, useApi } from '../../lib/hooks';
import { atLeast, CANCEL_OUTCOME_LABELS, FORMAT_LABELS, PLATFORM_LABELS, TARGET_STATE_INFO } from '../../lib/labels';
import { splitLocal } from '../../lib/schedule';
import { newKey } from '../../lib/storage';

const RESCHEDULABLE: TargetState[] = ['scheduled', 'queued', 'awaiting_approval', 'retry_wait', 'reconnect_required'];
const CANCELABLE: TargetState[] = ['draft', 'awaiting_approval', 'scheduled', 'queued', 'retry_wait', 'reconnect_required', 'submitting', 'processing', 'outcome_unknown'];

interface TargetEvents {
  attempts: Array<Record<string, unknown>>;
  events: Array<{ action: string; created_at: string; detail: Record<string, unknown> }>;
}

function EventsPanel({ targetId, tz }: { targetId: string; tz: string }) {
  const [open, setOpen] = useState(false);
  const events = useApi<TargetEvents>(open ? `/targets/${encodeURIComponent(targetId)}/events` : null);
  return (
    <details className="disclosure" onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary>Diagnostic events</summary>
      <div className="disclosure-body">
        {events.loading && !events.data ? <Loading label="Loading events…" /> : null}
        {events.error ? <ErrorNotice error={events.error} onRetry={events.reload} /> : null}
        {events.data ? (
          <>
            <h3>Publishing attempts</h3>
            {events.data.attempts.length ? (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th scope="col">#</th>
                      <th scope="col">Phase</th>
                      <th scope="col">Started</th>
                      <th scope="col">Outcome</th>
                      <th scope="col">Error</th>
                    </tr>
                  </thead>
                  <tbody>
                    {events.data.attempts.map((a, i) => (
                      <tr key={i}>
                        <td>{String(a.attempt_no ?? i + 1)}</td>
                        <td>{String(a.phase ?? '')}</td>
                        <td>{typeof a.started_at === 'string' ? formatDateTime(a.started_at, tz) : ''}</td>
                        <td>{String(a.outcome ?? 'in progress')}</td>
                        <td className="small">{a.error_code ? `${String(a.error_code)}: ${String(a.error_message ?? '')}` : ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="small muted">No publishing attempts yet.</p>
            )}
            <h3>Events</h3>
            {events.data.events.length ? (
              <ul className="media-list">
                {events.data.events.map((ev, i) => (
                  <li key={i} className="media-item" style={{ display: 'grid' }}>
                    <span className="strong">{ev.action}</span>
                    <span className="small muted">{formatDateTime(ev.created_at, tz)}</span>
                    {Object.keys(ev.detail).length ? <code className="mono">{JSON.stringify(ev.detail)}</code> : null}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="small muted">No events recorded.</p>
            )}
          </>
        ) : null}
      </div>
    </details>
  );
}

function Reschedule({ target, tz, onDone }: { target: Target; tz: string; onDone: (t: Target) => void }) {
  const [when, setWhen] = useState<LocalTimeValue>(() => splitLocal(target.local_time));
  const action = useAction(async (body: { expected_version: number; scheduled_at_utc: string; timezone: string }) => {
    await api<unknown>(`/targets/${encodeURIComponent(target.id)}`, { method: 'PATCH', body });
    return api<Target>(`/targets/${encodeURIComponent(target.id)}`);
  });
  const r = evaluateLocalTime(when, tz);
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (r.kind !== 'ok' || r.past) return;
    const res = await action.run({ expected_version: target.version, scheduled_at_utc: r.time.utc, timezone: tz });
    if (res) onDone(res);
  }
  return (
    <form className="stack" onSubmit={submit}>
      <LocalTimePicker value={when} onChange={setWhen} timezone={tz} legend="New time" />
      {action.error ? <ErrorNotice error={action.error} /> : null}
      <div className="form-actions">
        <button type="submit" className="btn btn-primary" disabled={action.pending || r.kind !== 'ok' || Boolean(r.past)}>
          {action.pending ? 'Rescheduling…' : 'Reschedule'}
        </button>
      </div>
    </form>
  );
}

function ResolveUnknown({ target, onDone }: { target: Target; onDone: () => void }) {
  const [outcome, setOutcome] = useState<'' | 'published' | 'not_published'>('');
  const [url, setUrl] = useState('');
  const [remoteId, setRemoteId] = useState('');
  const action = useAction(async (body: Record<string, unknown>) => {
    await api<unknown>(`/targets/${encodeURIComponent(target.id)}/resolve`, { method: 'POST', body });
    return true;
  });
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!outcome) return;
    const body = outcome === 'published' ? { expected_version: target.version, outcome, provider_url: url.trim(), provider_post_id: remoteId.trim() } : { expected_version: target.version, outcome };
    const r = await action.run(body);
    if (r) onDone();
  }
  return (
    <form className="stack" onSubmit={submit}>
      <h3>I checked the account</h3>
      <p className="small muted">Open {PLATFORM_LABELS[target.platform]} and look for this post. Record what you found; Ayonix will not retry automatically.</p>
      <fieldset>
        <legend>What did you find?</legend>
        <div className="choice-group">
          <label className="choice">
            <input type="radio" name="outcome" checked={outcome === 'published'} onChange={() => setOutcome('published')} />
            <span>It was published</span>
          </label>
          <label className="choice">
            <input type="radio" name="outcome" checked={outcome === 'not_published'} onChange={() => setOutcome('not_published')} />
            <span>It was not published (release the reserved publication)</span>
          </label>
        </div>
      </fieldset>
      {outcome === 'published' ? (
        <>
          <Field label="Post URL" hint="The https link to the live post." error={action.error?.fieldErrors.provider_url}>
            <input className="input" type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://" />
          </Field>
          <Field label="Post ID on the network" error={action.error?.fieldErrors.provider_post_id}>
            <input className="input" value={remoteId} onChange={(e) => setRemoteId(e.target.value)} />
          </Field>
        </>
      ) : null}
      {action.error ? <ErrorNotice error={action.error} /> : null}
      <div className="form-actions">
        <button type="submit" className="btn btn-primary" disabled={!outcome || action.pending || (outcome === 'published' && (!/^https:\/\//.test(url.trim()) || !remoteId.trim()))}>
          {action.pending ? 'Saving…' : 'Record result'}
        </button>
      </div>
    </form>
  );
}

export function TargetDetails({ targetId, workspace, onChanged }: { targetId: string; workspace: WorkspaceSummary; onChanged?: () => void }) {
  const tz = workspace.timezone;
  const target = useApi<Target>(`/targets/${encodeURIComponent(targetId)}`);
  const [mode, setMode] = useState<null | 'reschedule' | 'cancel'>(null);
  const [cancelKey, setCancelKey] = useState<string | null>(null);
  const [outcomes, setOutcomes] = useState<Record<string, string> | null>(null);
  const cancel = useAction((t: Target, key: string) =>
    api<{ schedule_id: string; version: number; outcomes: Record<string, string> }>(`/schedules/${encodeURIComponent(t.schedule_id)}/cancel`, {
      method: 'POST',
      body: { expected_version: t.schedule_version, idempotency_key: key },
    }),
  );

  if (target.loading && !target.data) return <Loading label="Loading post details…" />;
  if (target.error && !target.data) return <ErrorNotice error={target.error} onRetry={target.reload} />;
  const t = target.data;
  if (!t) return null;
  const info = TARGET_STATE_INFO[t.status];
  const canSchedule = atLeast(workspace.role, 'editor');
  const canResolve = atLeast(workspace.role, 'admin');
  const receipt = t.receipt;
  const verifiedUrl = receipt?.url && receipt.verified_at ? receipt.url : null;

  return (
    <div className="stack">
      {target.error ? <ErrorNotice error={target.error} onRetry={target.reload} /> : null}
      <div className="row-between">
        <div className="stack-sm">
          <h2 style={{ fontSize: 24 }}>
            {PLATFORM_LABELS[t.platform]} · {t.account_name || 'Account'}
          </h2>
          <p className="muted small">{FORMAT_LABELS[t.format]} post</p>
        </div>
        <StatusBadge state={t.status} />
      </div>
      <p>{info.description}</p>
      {t.next_action ? (
        <Banner tone={info.tone === 'danger' ? 'danger' : info.tone === 'warning' ? 'warning' : 'info'} title="Next step">
          {t.next_action}
        </Banner>
      ) : null}
      {t.status === 'processing' ? <p className="small strong">Processing is not published. The status changes to Published only after {PLATFORM_LABELS[t.platform]} confirms it.</p> : null}
      {t.status === 'outcome_unknown' ? <p className="small strong">Do not retry blindly. Reconcile the provider outcome first.</p> : null}

      <dl className="dl">
        <dt>Scheduled for</dt>
        <dd>{formatLocalAndUtc(t.due_at, t.timezone || tz)}</dd>
        {t.timezone && t.timezone !== tz ? (
          <>
            <dt>Workspace time</dt>
            <dd>{formatDateTime(t.due_at, tz)}</dd>
          </>
        ) : null}
        <dt>Content</dt>
        <dd>{t.caption_preview || <span className="muted">No caption</span>}</dd>
        <dt>Attempts</dt>
        <dd>{t.attempts}</dd>
        <dt>Last update</dt>
        <dd>{formatDateTime(t.updated_at, tz)}</dd>
        {t.error ? (
          <>
            <dt>Error</dt>
            <dd>
              <span className="field-error">{t.error.message || 'The network reported an error.'}</span>
              <span className="cell-sub mono">{t.error.code}</span>
            </dd>
          </>
        ) : null}
        <dt>Provider receipt</dt>
        <dd>
          {receipt ? (
            <span className="stack-sm">
              <span>Status: {receipt.status}</span>
              {receipt.remote_id ? (
                <span>
                  Post ID: <span className="mono">{receipt.remote_id}</span>
                </span>
              ) : null}
              {receipt.container_id ? (
                <span>
                  Upload ID: <span className="mono">{receipt.container_id}</span>
                </span>
              ) : null}
              {receipt.verified_at ? <span>Verified {formatDateTime(receipt.verified_at, tz)}</span> : <span className="muted">Not verified yet</span>}
              {verifiedUrl ? (
                <a href={verifiedUrl} target="_blank" rel="noopener noreferrer">
                  Open the published post on {PLATFORM_LABELS[t.platform]}
                </a>
              ) : null}
            </span>
          ) : (
            <span className="muted">No receipt yet. A receipt appears once the network accepts the post.</span>
          )}
        </dd>
      </dl>

      {outcomes ? (
        <Banner tone="info" title="Cancellation results">
          <ul className="problem-list">
            {Object.entries(outcomes).map(([id, o]) => (
              <li key={id}>
                {id === t.id ? 'This destination' : `Destination ${id}`}: {CANCEL_OUTCOME_LABELS[o] ?? o}
              </li>
            ))}
          </ul>
        </Banner>
      ) : null}

      {canSchedule ? (
        <div className="form-actions">
          {t.status === 'awaiting_approval' && t.platform === 'tiktok' ? (
            <Link className="btn btn-primary" to={`/approve/tiktok/${encodeURIComponent(t.id)}`}>
              Open TikTok approval
            </Link>
          ) : null}
          {RESCHEDULABLE.includes(t.status) ? (
            <button type="button" className="btn" aria-expanded={mode === 'reschedule'} onClick={() => setMode(mode === 'reschedule' ? null : 'reschedule')}>
              Reschedule
            </button>
          ) : null}
          {CANCELABLE.includes(t.status) ? (
            <button
              type="button"
              className="btn btn-danger"
              onClick={() => {
                setCancelKey(newKey());
                setMode('cancel');
              }}
            >
              Cancel schedule
            </button>
          ) : null}
        </div>
      ) : (
        <p className="small muted">Your viewer role can see this post but not change it.</p>
      )}

      {mode === 'reschedule' ? (
        <Reschedule
          target={t}
          tz={tz}
          onDone={(next) => {
            target.setData(next);
            setMode(null);
            onChanged?.();
          }}
        />
      ) : null}

      {t.status === 'outcome_unknown' && canResolve ? (
        <section className="card">
          <ResolveUnknown
            target={t}
            onDone={() => {
              target.reload();
              onChanged?.();
            }}
          />
        </section>
      ) : null}

      <EventsPanel targetId={t.id} tz={tz} />

      <ConfirmDialog
        open={mode === 'cancel'}
        onClose={() => setMode(null)}
        title="Cancel this schedule?"
        confirmLabel="Cancel schedule"
        danger
        pending={cancel.pending}
        onConfirm={async () => {
          if (!cancelKey) return;
          const r = await cancel.run(t, cancelKey);
          if (r) {
            setOutcomes(r.outcomes);
            setMode(null);
            target.reload();
            onChanged?.();
          }
        }}
      >
        <p>This cancels every destination in the schedule this post belongs to, not only {PLATFORM_LABELS[t.platform]}.</p>
        <p className="small muted">
          Destinations not yet sent are canceled and their reserved publications released. Anything already sent to a network may already be published; Ayonix will report each outcome honestly.
        </p>
        {cancel.error ? <ErrorNotice error={cancel.error} /> : null}
      </ConfirmDialog>
    </div>
  );
}
