import { useState } from 'react';
import type { AuditEvent, Page } from '@ayonix/contracts';
import { Banner, EmptyState, ErrorNotice, Loading } from '../../components/ui';
import { api, toApiError, type ApiRequestError } from '../../lib/api';
import { formatDateTime } from '../../lib/format';
import { useApi } from '../../lib/hooks';
import { useWorkspace } from '../../state/session';

export function EventsTab() {
  const ws = useWorkspace();
  const first = useApi<Page<AuditEvent>>('/events');
  const [more, setMore] = useState<{ items: AuditEvent[]; cursor: string | null } | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<ApiRequestError | null>(null);

  if (first.error?.status === 403) {
    return <Banner tone="warning" title="Permission denied">Only owners and admins can view the event log.</Banner>;
  }
  const items = [...(first.data?.items ?? []), ...(more?.items ?? [])];
  const cursor = more ? more.cursor : (first.data?.next_cursor ?? null);

  return (
    <section className="card" aria-labelledby="events-h">
      <div className="card-header">
        <h2 id="events-h">Events</h2>
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          onClick={() => {
            setMore(null);
            first.reload();
          }}
        >
          Refresh
        </button>
      </div>
      <p className="small muted">Audit trail of actions in this workspace, newest first. Times in {ws.timezone}.</p>
      {first.loading && !first.data ? <Loading label="Loading events…" /> : null}
      {first.error && first.error.status !== 403 ? <ErrorNotice error={first.error} onRetry={first.reload} /> : null}
      {first.data && items.length === 0 ? <EmptyState title="No events yet" /> : null}
      {items.length ? (
        <div className="table-wrap">
          <table className="table table-stack">
            <caption className="visually-hidden">Audit events</caption>
            <thead>
              <tr>
                <th scope="col">Time</th>
                <th scope="col">Event</th>
                <th scope="col">Object</th>
                <th scope="col">Actor</th>
              </tr>
            </thead>
            <tbody>
              {items.map((e) => (
                <tr key={e.id}>
                  <td data-label="Time">{formatDateTime(e.created_at, ws.timezone)}</td>
                  <td data-label="Event">
                    <span className="strong">{e.action}</span>
                    {Object.keys(e.detail).length ? (
                      <details>
                        <summary className="small">Details</summary>
                        <code className="mono">{JSON.stringify(e.detail)}</code>
                      </details>
                    ) : null}
                  </td>
                  <td data-label="Object">
                    {e.object_type}
                    {e.object_id ? <span className="cell-sub mono">{e.object_id}</span> : null}
                  </td>
                  <td data-label="Actor">{e.actor ?? 'System'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {moreError ? <ErrorNotice error={moreError} /> : null}
      {cursor ? (
        <button
          type="button"
          className="btn btn-ghost"
          disabled={loadingMore}
          onClick={async () => {
            setLoadingMore(true);
            setMoreError(null);
            try {
              const page = await api<Page<AuditEvent>>(`/events?cursor=${encodeURIComponent(cursor)}`);
              setMore((prev) => ({ items: [...(prev?.items ?? []), ...page.items], cursor: page.next_cursor }));
            } catch (err) {
              setMoreError(toApiError(err));
            } finally {
              setLoadingMore(false);
            }
          }}
        >
          {loadingMore ? 'Loading…' : 'Load older events'}
        </button>
      ) : null}
    </section>
  );
}
