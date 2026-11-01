import { useState } from 'react';
import { Link } from 'react-router';
import { PLATFORMS, type AnalyticsResponse, type Page, type Platform, type Product, type ProviderStatus, type Target } from '@ayonix/contracts';
import { resolveLocalTime } from '@ayonix/domain';
import { AreaChart, ChannelBars } from '../components/charts';
import { Drawer } from '../components/overlay';
import { QuotaMeter } from '../components/QuotaMeter';
import { EmptyState, ErrorNotice, Loading, PageHeader, SkeletonLines, StaleNotice, StatCard, StatusBadge } from '../components/ui';
import { ComposerBody } from '../features/composer/Composer';
import { TargetDetails } from '../features/targets/TargetDetails';
import { qs } from '../lib/api';
import { dayKey, formatNumber, formatShortDateTime, nowMs, rollingRange, zoneCity, type DateRange } from '../lib/format';
import { useApi } from '../lib/hooks';
import { ATTENTION_STATES, atLeast, PLATFORM_LABELS } from '../lib/labels';
import { useWorkspace } from '../state/session';

export interface Filters {
  productId: string;
  platform: '' | Platform;
  range: DateRange;
}

export function FilterBar({ filters, onChange, products }: { filters: Filters; onChange: (f: Filters) => void; products: Product[] }) {
  return (
    <div className="filters" role="group" aria-label="Filters">
      <label className="field">
        <span className="field-label">Product</span>
        <select className="select" value={filters.productId} onChange={(e) => onChange({ ...filters, productId: e.target.value })}>
          <option value="">All products</option>
          {products.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span className="field-label">Channel</span>
        <select className="select" value={filters.platform} onChange={(e) => onChange({ ...filters, platform: e.target.value as Filters['platform'] })}>
          <option value="">All channels</option>
          {PLATFORMS.map((p) => (
            <option key={p} value={p}>
              {PLATFORM_LABELS[p]}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span className="field-label">Date range</span>
        <select className="select" value={filters.range.days} onChange={(e) => onChange({ ...filters, range: rollingRange(Number(e.target.value)) })}>
          <option value={7}>Last 7 days</option>
          <option value={30}>Last 30 days</option>
          <option value={90}>Last 90 days</option>
        </select>
      </label>
    </div>
  );
}

function monthBounds(year: number, month: number, tz: string): { from: string; to: string } {
  const p = (n: number) => String(n).padStart(2, '0');
  const ny = month === 12 ? year + 1 : year;
  const nm = month === 12 ? 1 : month + 1;
  const at = (y: number, m: number) => {
    try {
      return resolveLocalTime(`${y}-${p(m)}-01T00:00`, tz, 'earlier').utc;
    } catch {
      try {
        return resolveLocalTime(`${y}-${p(m)}-01T01:00`, tz, 'earlier').utc;
      } catch {
        return new Date(Date.UTC(y, m - 1, 1)).toISOString();
      }
    }
  };
  return { from: at(year, month), to: at(ny, nm) };
}

function CalendarView({ tz, filters, onOpen }: { tz: string; filters: Filters; onOpen: (id: string) => void }) {
  const [month, setMonth] = useState(() => {
    const [y, m] = dayKey(nowMs(), tz).split('-').map(Number);
    return { year: y ?? 2026, month: m ?? 1 };
  });
  const bounds = monthBounds(month.year, month.month, tz);
  const list = useApi<Page<Target>>(`/schedules${qs({ from: bounds.from, to: bounds.to, limit: 200, product_id: filters.productId, platform: filters.platform })}`);
  const first = new Date(Date.UTC(month.year, month.month - 1, 1));
  const daysInMonth = new Date(Date.UTC(month.year, month.month, 0)).getUTCDate();
  const lead = (first.getUTCDay() + 6) % 7; // Monday first
  const cells: Array<{ key: string; day: number } | null> = [];
  for (let i = 0; i < lead; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push({ key: `${month.year}-${String(month.month).padStart(2, '0')}-${String(d).padStart(2, '0')}`, day: d });
  while (cells.length % 7) cells.push(null);
  const byDay = new Map<string, Target[]>();
  for (const t of list.data?.items ?? []) {
    const k = dayKey(t.due_at, tz);
    byDay.set(k, [...(byDay.get(k) ?? []), t]);
  }
  const today = dayKey(nowMs(), tz);
  const label = new Intl.DateTimeFormat('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(first);
  const shift = (delta: number) =>
    setMonth((m) => {
      const idx = m.year * 12 + (m.month - 1) + delta;
      return { year: Math.floor(idx / 12), month: (idx % 12) + 1 };
    });
  return (
    <div className="stack-sm">
      <div className="row-between">
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => shift(-1)}>
          Previous month
        </button>
        <h3 aria-live="polite">{label}</h3>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => shift(1)}>
          Next month
        </button>
      </div>
      {list.error ? <ErrorNotice error={list.error} onRetry={list.reload} /> : null}
      {list.loading && !list.data ? <Loading label="Loading calendar…" /> : null}
      <div className="calendar" role="grid" aria-label={`Scheduled posts, ${label}, ${tz}`}>
        {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => (
          <div key={d} className="dow" role="columnheader">
            {d}
          </div>
        ))}
        {cells.map((c, i) =>
          c ? (
            <div key={c.key} className={`day ${c.key === today ? 'today' : ''}`} role="gridcell" aria-label={`${c.day} ${label}${c.key === today ? ', today' : ''}`}>
              <span className="day-num">{c.day}</span>
              {(byDay.get(c.key) ?? []).map((t) => (
                <button key={t.id} type="button" className="cal-item" onClick={() => onOpen(t.id)} title={`${PLATFORM_LABELS[t.platform]} · ${t.caption_preview}`}>
                  {formatShortDateTime(t.due_at, tz).split(', ')[1]} {PLATFORM_LABELS[t.platform]}
                  <span className="visually-hidden">: {t.caption_preview}</span>
                </button>
              ))}
            </div>
          ) : (
            <div key={`empty-${i}`} className="day outside" role="gridcell" aria-hidden="true" />
          ),
        )}
      </div>
      {list.data?.next_cursor ? <p className="small muted">Showing the first 200 posts this month.</p> : null}
    </div>
  );
}

export function TargetTable({ items, tz, onOpen, caption }: { items: Target[]; tz: string; onOpen: (id: string) => void; caption: string }) {
  return (
    <div className="table-wrap">
      <table className="table table-stack">
        <caption className="visually-hidden">{caption}</caption>
        <thead>
          <tr>
            <th scope="col">Time / {zoneCity(tz)}</th>
            <th scope="col">Content</th>
            <th scope="col">Status</th>
          </tr>
        </thead>
        <tbody>
          {items.map((t) => {
            const attention = ATTENTION_STATES.includes(t.status);
            return (
              <tr key={t.id} className={`clickable ${attention ? 'attention' : ''}`} onClick={() => onOpen(t.id)}>
                <td data-label={`Time / ${zoneCity(tz)}`}>{formatShortDateTime(t.due_at, tz)}</td>
                <td data-label="Content">
                  <button type="button" className="row-button" onClick={(e) => { e.stopPropagation(); onOpen(t.id); }}>
                    {t.caption_preview ? t.caption_preview.slice(0, 90) : 'Untitled post'}
                    <span className="visually-hidden"> — open details</span>
                  </button>
                  <span className="cell-sub">
                    {PLATFORM_LABELS[t.platform]} · {t.account_name}
                  </span>
                  {attention && t.next_action ? <span className="cell-sub strong">{t.next_action}</span> : null}
                </td>
                <td data-label="Status">
                  <StatusBadge state={t.status} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function DashboardPage() {
  const workspace = useWorkspace();
  const tz = workspace.timezone;
  const [filters, setFilters] = useState<Filters>(() => ({ productId: '', platform: '', range: rollingRange(30) }));
  const [view, setView] = useState<'list' | 'calendar'>('list');
  const [composerOpen, setComposerOpen] = useState(false);
  const [openTarget, setOpenTarget] = useState<string | null>(null);
  const [upcomingFrom, setUpcomingFrom] = useState(() => new Date(nowMs()).toISOString());

  const products = useApi<Page<Product>>('/products');
  const providers = useApi<ProviderStatus[]>('/connections');
  const analytics = useApi<AnalyticsResponse>(
    `/analytics${qs({ from: filters.range.from, to: filters.range.to, product_id: filters.productId, platforms: filters.platform })}`,
  );
  const upcoming = useApi<Page<Target>>(`/schedules${qs({ from: upcomingFrom, limit: 50, product_id: filters.productId, platform: filters.platform })}`);
  const attention = useApi<Page<Target>>(
    `/schedules${qs({ status: ATTENTION_STATES.join(','), from: filters.range.from, limit: 20, product_id: filters.productId, platform: filters.platform })}`,
  );

  const connectionCount = (providers.data ?? []).reduce((n, p) => n + p.connections.length, 0);
  const firstTime = providers.data !== undefined && connectionCount === 0;
  const canSchedule = atLeast(workspace.role, 'editor');
  const a = analytics.data;

  function refreshAll() {
    setUpcomingFrom(new Date(nowMs()).toISOString());
    upcoming.reload();
    attention.reload();
    analytics.reload();
  }

  return (
    <>
      <PageHeader
        title="Dashboard"
        subtitle="Plan in ChatGPT. Publish with Ayonix."
        actions={
          canSchedule ? (
            <button type="button" className="btn btn-primary" onClick={() => setComposerOpen(true)}>
              New schedule
            </button>
          ) : null
        }
      />
      <FilterBar filters={filters} onChange={setFilters} products={products.data?.items ?? []} />

      {firstTime ? (
        <EmptyState
          title="Connect a channel"
          action={
            <Link className="btn btn-primary" to="/connectors">
              Connect a channel
            </Link>
          }
        >
          No social accounts are connected yet. Connect LinkedIn, Facebook, Instagram, TikTok or YouTube to start publishing.
        </EmptyState>
      ) : null}
      {providers.error ? <ErrorNotice error={providers.error} onRetry={providers.reload} /> : null}

      <section className="card">
        <QuotaMeter quota={workspace.quota} timezone={tz} />
      </section>

      {analytics.error && !a ? <ErrorNotice error={analytics.error} onRetry={analytics.reload} /> : null}
      <StaleNotice loadedAt={analytics.loadedAt} error={a ? analytics.error : undefined} onRetry={analytics.reload} refreshing={analytics.refreshing} />
      <div className="grid-4">
        {analytics.loading && !a ? (
          [0, 1, 2, 3].map((i) => (
            <div key={i} className="card">
              <SkeletonLines lines={3} />
            </div>
          ))
        ) : a ? (
          <>
            <StatCard label="Published" value={a.totals.published} note={workspace.quota.allowance ? `${formatNumber(workspace.quota.allowance)} publications this cycle` : 'Provider-confirmed only'} />
            <StatCard label="Scheduled" value={a.totals.scheduled} note="Capacity reserved" />
            <StatCard label="Impressions" value={a.totals.impressions} note="Available channels only" />
            <StatCard label="Engagements" value={a.totals.engagements} note={<Link to="/reports#definitions">See metric definitions</Link>} />
          </>
        ) : null}
      </div>

      <div className="grid-main-side">
        <section className="card" aria-labelledby="eng-h">
          <h2 id="eng-h">{a?.series.metric === 'engagements' ? 'Audience engagement' : 'Impressions over time'}</h2>
          {a ? (
            <AreaChart points={a.series.points} metricLabel={a.series.metric === 'engagements' ? 'Engagements' : 'Impressions'} title={a.series.metric === 'engagements' ? 'Engagements per day' : 'Impressions per day'} />
          ) : analytics.loading ? (
            <SkeletonLines lines={5} />
          ) : null}
        </section>
        <section className="card" aria-labelledby="ch-h">
          <h2 id="ch-h">By channel</h2>
          {a ? <ChannelBars rows={a.by_channel} /> : analytics.loading ? <SkeletonLines lines={5} /> : null}
          {a?.freshness ? <p className="tiny muted" style={{ marginTop: 12 }}>Data as of {formatShortDateTime(a.freshness, tz)}</p> : null}
        </section>
      </div>

      {attention.data && attention.data.items.length ? (
        <section className="card" aria-labelledby="att-h">
          <div className="card-header">
            <h2 id="att-h">Needs attention</h2>
            <span className="badge tone-warning">{attention.data.items.length} item{attention.data.items.length === 1 ? '' : 's'}</span>
          </div>
          <TargetTable items={attention.data.items} tz={tz} onOpen={setOpenTarget} caption="Posts that need attention" />
        </section>
      ) : null}
      {attention.error ? <ErrorNotice error={attention.error} onRetry={attention.reload} /> : null}

      <section className="card" aria-labelledby="up-h">
        <div className="card-header">
          <h2 id="up-h">Upcoming posts</h2>
          <div className="row">
            <div className="segmented" role="group" aria-label="Queue view">
              <button type="button" aria-pressed={view === 'list'} onClick={() => setView('list')}>
                List
              </button>
              <button type="button" aria-pressed={view === 'calendar'} onClick={() => setView('calendar')}>
                Calendar
              </button>
            </div>
            <button type="button" className="btn btn-ghost btn-sm" onClick={refreshAll}>
              Refresh
            </button>
          </div>
        </div>
        {view === 'calendar' ? (
          <CalendarView tz={tz} filters={filters} onOpen={setOpenTarget} />
        ) : (
          <>
            <StaleNotice loadedAt={upcoming.loadedAt} error={upcoming.data ? upcoming.error : undefined} onRetry={upcoming.reload} refreshing={upcoming.refreshing} />
            {upcoming.error && !upcoming.data ? <ErrorNotice error={upcoming.error} onRetry={upcoming.reload} /> : null}
            {upcoming.loading && !upcoming.data ? <Loading label="Loading upcoming posts…" /> : null}
            {upcoming.data && upcoming.data.items.length === 0 ? (
              <EmptyState
                title="Nothing scheduled"
                action={
                  canSchedule ? (
                    <button type="button" className="btn" onClick={() => setComposerOpen(true)}>
                      New schedule
                    </button>
                  ) : null
                }
              >
                Upcoming posts appear here with their exact time in {tz}.
              </EmptyState>
            ) : null}
            {upcoming.data && upcoming.data.items.length ? <TargetTable items={upcoming.data.items} tz={tz} onOpen={setOpenTarget} caption="Upcoming posts" /> : null}
            {upcoming.data?.next_cursor ? <p className="small muted">Showing the next 50 posts. Use the calendar to browse further ahead.</p> : null}
          </>
        )}
      </section>

      <Drawer open={composerOpen} onClose={() => setComposerOpen(false)} title="Schedule a post" description="Review each destination before confirming.">
        <ComposerBody workspace={workspace} onScheduled={refreshAll} onClose={() => setComposerOpen(false)} />
      </Drawer>
      <Drawer open={openTarget !== null} onClose={() => setOpenTarget(null)} title="Post details" description="Honest status for this destination." narrow>
        {openTarget ? (
          <>
            <TargetDetails targetId={openTarget} workspace={workspace} onChanged={refreshAll} />
            <p className="small">
              <Link to={`/targets/${encodeURIComponent(openTarget)}`}>Open as a full page</Link>
            </p>
          </>
        ) : null}
      </Drawer>
    </>
  );
}
