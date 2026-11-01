import { useState } from 'react';
import type { AnalyticsResponse, Page, Product, ProviderStatus, ReportJob } from '@ayonix/contracts';
import { PLATFORMS } from '@ayonix/contracts';
import { AreaChart } from '../components/charts';
import { Badge, Banner, EmptyState, ErrorNotice, Loading, PageHeader, SkeletonLines, StaleNotice, StatCard } from '../components/ui';
import { api, qs, toApiError, type ApiRequestError } from '../lib/api';
import { formatDateTime, formatMetric, formatNumber, formatRelative, nowMs, previousRange, rollingRange } from '../lib/format';
import { useApi, usePoll } from '../lib/hooks';
import { jobStatus, PLATFORM_LABELS } from '../lib/labels';
import { useWorkspace } from '../state/session';
import { FilterBar, type Filters } from './Dashboard';

function delta(cur: number | null, prev: number | null): string | null {
  if (cur === null || prev === null) return 'Change: not available';
  if (prev === 0) return cur === 0 ? 'No change vs previous period' : `+${formatNumber(cur)} vs previous period (was 0)`;
  const pct = ((cur - prev) / prev) * 100;
  const sign = pct > 0 ? '+' : '';
  return `${sign}${pct.toFixed(1)}% vs previous period (${formatNumber(prev)})`;
}

function ExportPanel({ filters }: { filters: Filters }) {
  const ws = useWorkspace();
  const [job, setJob] = useState<ReportJob | null>(null);
  const [error, setError] = useState<ApiRequestError | null>(null);
  const [pending, setPending] = useState<null | 'csv' | 'pdf'>(null);
  const history = useApi<ReportJob[]>('/reports');
  const active = job !== null && (job.status === 'queued' || job.status === 'running');
  usePoll(
    async () => {
      if (!job) return true;
      const j = await api<ReportJob>(`/reports/${encodeURIComponent(job.id)}`);
      setJob(j);
      if (j.status === 'ready' || j.status === 'failed') {
        history.reload();
        return true;
      }
      return false;
    },
    2000,
    active,
  );
  async function request(format: 'csv' | 'pdf') {
    setPending(format);
    setError(null);
    try {
      const j = await api<ReportJob>('/reports', {
        method: 'POST',
        body: { format, from_utc: filters.range.from, to_utc: filters.range.to, ...(filters.productId ? { product_id: filters.productId } : {}), ...(filters.platform ? { platforms: [filters.platform] } : {}) },
      });
      setJob(j);
    } catch (e) {
      setError(toApiError(e));
    } finally {
      setPending(null);
    }
  }
  return (
    <section className="card stack" aria-labelledby="export-h">
      <div className="card-header">
        <h2 id="export-h">Export</h2>
        <div className="row">
          <button type="button" className="btn" disabled={pending !== null || active} onClick={() => request('csv')}>
            {pending === 'csv' ? 'Requesting…' : 'Export CSV'}
          </button>
          <button type="button" className="btn btn-primary" disabled={pending !== null || active} onClick={() => request('pdf')}>
            {pending === 'pdf' ? 'Requesting…' : 'Export PDF'}
          </button>
        </div>
      </div>
      <p className="small muted">Exports use the filters above. Download links are signed and expire.</p>
      {error ? <ErrorNotice error={error} /> : null}
      <div role="status" aria-live="polite">
        {job ? (
          job.status === 'ready' && job.download_url ? (
            <Banner tone="success" title={`${job.format.toUpperCase()} report ready`} action={<a className="btn btn-sm btn-primary" href={job.download_url}>Download</a>}>
              {job.download_expires_at ? `Link expires ${formatDateTime(job.download_expires_at, ws.timezone)}.` : null}
            </Banner>
          ) : job.status === 'failed' ? (
            <Banner tone="danger" title="The report could not be generated">
              {job.error ?? 'Try again.'}
            </Banner>
          ) : (
            <p className="row small">
              <span className="spinner" aria-hidden="true" /> Generating {job.format.toUpperCase()} report…
            </p>
          )
        ) : null}
      </div>
      {history.data && history.data.length ? (
        <details className="disclosure">
          <summary>Recent exports</summary>
          <div className="disclosure-body">
            <ul className="media-list">
              {history.data.slice(0, 10).map((r) => {
                const st = jobStatus(r.status);
                return (
                  <li key={r.id} className="media-item">
                    <span className="name">
                      {r.format.toUpperCase()} · {formatDateTime(r.created_at, ws.timezone)}
                    </span>
                    <Badge tone={st.tone}>{st.label}</Badge>
                    {r.status === 'ready' && r.download_url ? <a href={r.download_url}>Download</a> : null}
                    {r.download_expires_at ? <span className="tiny muted">Expires {formatDateTime(r.download_expires_at, ws.timezone)}</span> : null}
                  </li>
                );
              })}
            </ul>
          </div>
        </details>
      ) : null}
    </section>
  );
}

export function ReportsPage() {
  const ws = useWorkspace();
  const tz = ws.timezone;
  const [filters, setFilters] = useState<Filters>(() => ({ productId: '', platform: '', range: rollingRange(30) }));
  const [compare, setCompare] = useState(false);
  const products = useApi<Page<Product>>('/products');
  const providers = useApi<ProviderStatus[]>('/connections');
  const q = (from: string, to: string) => `/analytics${qs({ from, to, product_id: filters.productId, platforms: filters.platform })}`;
  const current = useApi<AnalyticsResponse>(q(filters.range.from, filters.range.to));
  const prevRange = previousRange(filters.range);
  const previous = useApi<AnalyticsResponse>(compare ? q(prevRange.from, prevRange.to) : null);
  const a = current.data;
  const p = compare ? previous.data : undefined;
  const now = nowMs();
  const connectedPlatforms = new Set((providers.data ?? []).filter((x) => x.connections.length > 0).map((x) => x.provider));

  return (
    <>
      <PageHeader title="Reports" subtitle="Understand performance, with clear source definitions." />
      <div className="row-between">
        <FilterBar filters={filters} onChange={setFilters} products={products.data?.items ?? []} />
        <label className="check">
          <input type="checkbox" checked={compare} onChange={(e) => setCompare(e.target.checked)} />
          <span>Compare with the previous {filters.range.days} days</span>
        </label>
      </div>
      <p className="small muted">
        {formatDateTime(filters.range.from, tz)} – {formatDateTime(filters.range.to, tz)} ({tz})
        {compare ? ` · compared with ${formatDateTime(prevRange.from, tz)} – ${formatDateTime(prevRange.to, tz)}` : ''}
      </p>

      <StaleNotice loadedAt={current.loadedAt} error={a ? current.error : undefined} onRetry={current.reload} refreshing={current.refreshing} />
      {current.error && !a ? <ErrorNotice error={current.error} onRetry={current.reload} /> : null}
      {compare && previous.error ? <ErrorNotice error={previous.error} onRetry={previous.reload} /> : null}

      <div className="grid-4">
        {a ? (
          <>
            <StatCard label="Published" value={a.totals.published} delta={p ? delta(a.totals.published, p.totals.published) : undefined} />
            <StatCard label="Scheduled" value={a.totals.scheduled} delta={p ? delta(a.totals.scheduled, p.totals.scheduled) : undefined} />
            <StatCard label="Impressions" value={a.totals.impressions} delta={p ? delta(a.totals.impressions, p.totals.impressions) : undefined} />
            <StatCard label="Engagements" value={a.totals.engagements} delta={p ? delta(a.totals.engagements, p.totals.engagements) : undefined} />
          </>
        ) : current.loading ? (
          [0, 1, 2, 3].map((i) => (
            <div className="card" key={i}>
              <SkeletonLines />
            </div>
          ))
        ) : null}
      </div>

      <div className="grid-main-side">
        <section className="card" aria-labelledby="imp-h">
          <h2 id="imp-h">{a?.series.metric === 'engagements' ? 'Engagements over time' : 'Impressions over time'}</h2>
          {a ? <AreaChart points={a.series.points} metricLabel={a.series.metric === 'engagements' ? 'Engagements' : 'Impressions'} title={a.series.metric === 'engagements' ? 'Engagements per day' : 'Impressions per day'} /> : current.loading ? <SkeletonLines lines={5} /> : null}
          {compare && p ? (
            <details className="disclosure" style={{ marginTop: 12 }}>
              <summary>Previous period</summary>
              <div className="disclosure-body">
                <AreaChart points={p.series.points} metricLabel={p.series.metric === 'engagements' ? 'Engagements' : 'Impressions'} title="Previous period per day" />
              </div>
            </details>
          ) : null}
        </section>
        <section className="card" aria-labelledby="cov-h">
          <h2 id="cov-h">Data coverage</h2>
          {a ? (
            <ul className="bars">
              {PLATFORMS.filter((pl) => !filters.platform || pl === filters.platform).map((pl) => {
                const row = a.by_channel.find((r) => r.platform === pl);
                let text: string;
                if (!connectedPlatforms.has(pl) && providers.data) text = 'Not connected';
                else if (row?.available && row.retrieved_at) text = `Updated ${formatRelative(row.retrieved_at, now)}`;
                else text = row?.note ?? 'Not available';
                return (
                  <li key={pl} className="row-between">
                    <span className="strong">{PLATFORM_LABELS[pl]}</span>
                    <span className="small muted">{text}</span>
                  </li>
                );
              })}
            </ul>
          ) : current.loading ? (
            <SkeletonLines lines={5} />
          ) : null}
          <p className="tiny muted" style={{ marginTop: 12 }}>
            Data freshness: {a?.freshness ? `${formatDateTime(a.freshness, tz)} (${formatRelative(a.freshness, now)})` : 'Not available'}
          </p>
        </section>
      </div>

      <section className="card" aria-labelledby="top-h">
        <h2 id="top-h">Top posts</h2>
        {a && a.top_posts.length === 0 ? <EmptyState title="No measured posts in this period">Posts appear once networks report metrics for them.</EmptyState> : null}
        {a && a.top_posts.length ? (
          <div className="table-wrap">
            <table className="table table-stack">
              <caption className="visually-hidden">Top posts by impressions</caption>
              <thead>
                <tr>
                  <th scope="col">Post</th>
                  <th scope="col">Channel</th>
                  <th scope="col" className="num">
                    Impressions
                  </th>
                  <th scope="col" className="num">
                    Engagements
                  </th>
                </tr>
              </thead>
              <tbody>
                {a.top_posts.map((t) => (
                  <tr key={t.target_id}>
                    <td data-label="Post">
                      {t.url ? (
                        <a href={t.url} target="_blank" rel="noopener noreferrer">
                          {t.caption_preview || 'Untitled post'}
                        </a>
                      ) : (
                        t.caption_preview || 'Untitled post'
                      )}
                    </td>
                    <td data-label="Channel">{PLATFORM_LABELS[t.platform]}</td>
                    <td data-label="Impressions" className="num">
                      {formatMetric(t.impressions)}
                    </td>
                    <td data-label="Engagements" className="num">
                      {formatMetric(t.engagements)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
        {current.loading && !a ? <Loading /> : null}
        <p className="tiny muted" style={{ marginTop: 12 }}>
          Unsupported metrics are unavailable, never counted as zero.
        </p>
      </section>

      <section className="card" aria-labelledby="definitions">
        <h2 id="definitions">Metric definitions</h2>
        {a ? (
          <dl className="dl">
            {Object.entries(a.definitions).map(([k, v]) => (
              <div key={k} style={{ display: 'contents' }}>
                <dt className="strong">{k.charAt(0).toUpperCase() + k.slice(1)}</dt>
                <dd>{v}</dd>
              </div>
            ))}
          </dl>
        ) : (
          <SkeletonLines />
        )}
      </section>

      <ExportPanel filters={filters} />
    </>
  );
}
