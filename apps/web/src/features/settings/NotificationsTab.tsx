import { useState } from 'react';
import type { NotificationPreference } from '@ayonix/contracts';
import { Banner, ErrorNotice, Loading } from '../../components/ui';
import { api } from '../../lib/api';
import { useAction, useApi } from '../../lib/hooks';
import { NOTIFICATION_LABELS } from '../../lib/labels';
import { useWorkspace } from '../../state/session';

export function NotificationsTab() {
  const ws = useWorkspace();
  const prefs = useApi<NotificationPreference[]>('/notification-preferences');
  const [draft, setDraft] = useState<NotificationPreference[] | null>(null);
  const [saved, setSaved] = useState(false);
  const save = useAction((preferences: NotificationPreference[]) => api<NotificationPreference[]>('/notification-preferences', { method: 'PUT', body: { preferences } }));
  const value = draft ?? prefs.data ?? [];
  return (
    <section className="card stack" aria-labelledby="notif-h" style={{ maxWidth: 720 }}>
      <h2 id="notif-h">Email notifications</h2>
      <p className="small muted">These apply to you in this workspace.</p>
      {!ws.integrations.email ? <Banner tone="warning">Email is not configured on this deployment, so notifications cannot be delivered yet.</Banner> : null}
      {prefs.loading && !prefs.data ? <Loading label="Loading preferences…" /> : null}
      {prefs.error ? <ErrorNotice error={prefs.error} onRetry={prefs.reload} /> : null}
      {value.length ? (
        <fieldset className="stack-sm">
          <legend>Send me an email when…</legend>
          {value.map((p) => {
            const info = NOTIFICATION_LABELS[p.event] ?? { label: p.event, description: '' };
            return (
              <label key={p.event} className="check">
                <input
                  type="checkbox"
                  checked={p.email}
                  onChange={(e) => {
                    setSaved(false);
                    setDraft(value.map((x) => (x.event === p.event ? { ...x, email: e.target.checked } : x)));
                  }}
                />
                <span>
                  {info.label}
                  <span className="cell-sub">{info.description}</span>
                </span>
              </label>
            );
          })}
        </fieldset>
      ) : null}
      {save.error ? <ErrorNotice error={save.error} /> : null}
      <div role="status" aria-live="polite">
        {saved ? <Banner tone="success">Notification preferences saved.</Banner> : null}
      </div>
      <div className="form-actions">
        <button
          type="button"
          className="btn btn-primary"
          disabled={!draft || save.pending}
          onClick={async () => {
            if (!draft) return;
            const r = await save.run(draft);
            if (r) {
              prefs.setData(r);
              setDraft(null);
              setSaved(true);
            }
          }}
        >
          {save.pending ? 'Saving…' : 'Save preferences'}
        </button>
      </div>
    </section>
  );
}
