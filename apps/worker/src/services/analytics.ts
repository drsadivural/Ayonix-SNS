// Normalized metrics from authorized provider snapshots only. Missing is
// null, never zero; there is no combined cross-network unique reach; the
// engagement total is a sum of defined engagement metrics, not an average of
// percentages. Sample/example data is never used.
import type { AnalyticsResponse, Platform } from '@ayonix/contracts';
import { PLATFORMS } from '@ayonix/contracts';
import type { Env } from '../lib/env.js';
import { invalid } from '../lib/errors.js';
import { newId, nowIso } from '../lib/ids.js';
import { all, first, run } from '../lib/db.js';
import { adapterFor } from '../providers/registry.js';
import { ProviderError } from '../providers/types.js';
import type { Actor } from './context.js';
import { authorize } from './context.js';
import { providerContext } from './connections.js';

export const METRIC_DEFINITIONS: Record<string, string> = {
  published: 'Destination publications confirmed by the provider (each network counts separately).',
  scheduled: 'Destination publications scheduled or awaiting approval in the period.',
  impressions: 'Sum of provider-reported impressions or views for networks that report them. Networks without the metric are excluded, not counted as zero. Not unique reach.',
  engagements: 'Sum of provider-reported likes, comments, shares and saves where each is defined by the provider.',
  reach: 'Provider-reported unique accounts reached, per network only. Never combined across networks.',
};

export interface AnalyticsQuery {
  from_utc: string;
  to_utc: string;
  product_id?: string;
  platforms?: Platform[];
}

function validate(q: AnalyticsQuery) {
  const from = new Date(q.from_utc);
  const to = new Date(q.to_utc);
  if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) || from >= to) throw invalid('Choose a valid date range');
  if (to.getTime() - from.getTime() > 400 * 86400_000) throw invalid('Date ranges are limited to 400 days');
  const platforms = (q.platforms?.length ? q.platforms : [...PLATFORMS]).filter((p) => (PLATFORMS as readonly string[]).includes(p));
  return { from: from.toISOString(), to: to.toISOString(), platforms };
}

const ENGAGEMENT = ['likes', 'comments', 'shares', 'saves'];
const IMPRESSION = ['impressions', 'views'];

export async function analytics(env: Env, actor: Actor, q: AnalyticsQuery): Promise<AnalyticsResponse> {
  authorize(actor, 'read');
  const { from, to, platforms } = validate(q);
  const pMarks = platforms.map(() => '?').join(',');
  const productClause = q.product_id ? 'AND t.product_id = ?' : '';
  const productBind = q.product_id ? [q.product_id] : [];
  const counts = await first<{ published: number; scheduled: number }>(
    env,
    `SELECT SUM(CASE WHEN t.status = 'published' THEN 1 ELSE 0 END) AS published,
            SUM(CASE WHEN t.status IN ('scheduled','queued','awaiting_approval','retry_wait') THEN 1 ELSE 0 END) AS scheduled
     FROM targets t WHERE t.workspace_id = ? AND t.due_at >= ? AND t.due_at < ? AND t.platform IN (${pMarks}) ${productClause}`,
    actor.workspaceId, from, to, ...platforms, ...productBind,
  );
  // Post-level snapshots: use the latest lifetime value per object+metric within the range.
  const rows = await all<{ provider: Platform; target_id: string | null; provider_object_id: string; metric: string; value: number | null; date: string; retrieved_at: string }>(
    env,
    `SELECT m.provider, m.target_id, m.provider_object_id, m.metric, m.value, m.date, m.retrieved_at FROM metric_snapshots m
     LEFT JOIN targets t ON t.workspace_id = m.workspace_id AND t.id = m.target_id
     WHERE m.workspace_id = ? AND m.metric IS NOT NULL AND m.provider IN (${pMarks}) AND m.date >= ? AND m.date < ? ${q.product_id ? 'AND t.product_id = ?' : ''}
     ORDER BY m.retrieved_at`,
    actor.workspaceId, ...platforms, from.slice(0, 10), to.slice(0, 10) + '￿', ...productBind,
  );
  const latest = new Map<string, (typeof rows)[number]>();
  for (const r of rows) latest.set(`${r.provider_object_id}|${r.metric}|${r.target_id ? 'post' : r.date}`, r);
  const values = [...latest.values()];

  const sumWhere = (pred: (r: (typeof rows)[number]) => boolean) => {
    const sel = values.filter(pred).filter((r) => r.value !== null);
    return sel.length ? sel.reduce((a, r) => a + (r.value ?? 0), 0) : null;
  };
  const byChannel = platforms.map((p) => {
    const has = values.some((r) => r.provider === p);
    const retrieved = values.filter((r) => r.provider === p).map((r) => r.retrieved_at).sort().at(-1) ?? null;
    return {
      platform: p,
      impressions: sumWhere((r) => r.provider === p && IMPRESSION.includes(r.metric) && r.target_id !== null),
      engagements: sumWhere((r) => r.provider === p && ENGAGEMENT.includes(r.metric) && r.target_id !== null),
      retrieved_at: retrieved,
      available: has,
      note: has ? null : 'Not available: no authorized metrics have been collected for this network.',
    };
  });
  const seriesMap = new Map<string, number>();
  for (const r of values) {
    if (r.target_id === null || !IMPRESSION.includes(r.metric) || r.value === null) continue;
    seriesMap.set(r.date, (seriesMap.get(r.date) ?? 0) + r.value);
  }
  const days: { date: string; value: number | null }[] = [];
  for (let d = new Date(from.slice(0, 10)); d.toISOString() < to; d = new Date(d.getTime() + 86400_000)) {
    const key = d.toISOString().slice(0, 10);
    days.push({ date: key, value: seriesMap.has(key) ? seriesMap.get(key)! : null });
  }
  const top = await all<{ target_id: string; platform: Platform; caption: string; url: string | null }>(
    env,
    `SELECT t.id AS target_id, t.platform, cr.caption, t.provider_url AS url FROM targets t
     JOIN content_revisions cr ON cr.workspace_id = t.workspace_id AND cr.id = t.content_revision_id
     WHERE t.workspace_id = ? AND t.status = 'published' AND t.due_at >= ? AND t.due_at < ? AND t.platform IN (${pMarks}) ${productClause} LIMIT 500`,
    actor.workspaceId, from, to, ...platforms, ...productBind,
  );
  const topPosts = top
    .map((t) => ({
      target_id: t.target_id,
      platform: t.platform,
      caption_preview: t.caption.slice(0, 140),
      url: t.url,
      impressions: sumWhere((r) => r.target_id === t.target_id && IMPRESSION.includes(r.metric)),
      engagements: sumWhere((r) => r.target_id === t.target_id && ENGAGEMENT.includes(r.metric)),
    }))
    .sort((a, b) => (b.impressions ?? -1) - (a.impressions ?? -1))
    .slice(0, 10);
  const freshness = values.map((r) => r.retrieved_at).sort().at(-1) ?? null;
  return {
    period: { from, to },
    totals: {
      published: counts?.published ?? 0,
      scheduled: counts?.scheduled ?? 0,
      impressions: sumWhere((r) => IMPRESSION.includes(r.metric) && r.target_id !== null),
      engagements: sumWhere((r) => ENGAGEMENT.includes(r.metric) && r.target_id !== null),
    },
    series: { metric: 'impressions', points: days },
    by_channel: byChannel,
    top_posts: topPosts,
    definitions: METRIC_DEFINITIONS,
    freshness,
  };
}

/** Collect metrics for a connection's recent published targets from the provider (job). */
export async function collectMetrics(env: Env, workspaceId: string, connectionId: string): Promise<{ rows: number; error: string | null }> {
  const targets = await all<{ id: string; provider_post_id: string }>(
    env, `SELECT id, provider_post_id FROM targets WHERE workspace_id = ? AND connection_id = ? AND status = 'published' AND provider_post_id IS NOT NULL AND due_at >= ? ORDER BY due_at DESC LIMIT 100`,
    workspaceId, connectionId, new Date(Date.now() - 90 * 86400_000).toISOString());
  if (!targets.length) return { rows: 0, error: null };
  const byObject = new Map(targets.map((t) => [t.provider_post_id, t.id]));
  try {
    const ctx = await providerContext(env, workspaceId, connectionId, `metrics:${connectionId}`);
    const metrics = await adapterFor(ctx.connection.provider).fetchMetrics(ctx, { objectIds: [...byObject.keys()], since: new Date(Date.now() - 90 * 86400_000).toISOString(), until: nowIso() });
    const now = nowIso();
    const stmts = metrics.map((m) =>
      env.DB.prepare(`INSERT INTO metric_snapshots(id, workspace_id, connection_id, target_id, provider, provider_object_id, date, raw_metric, metric, value, aggregation, estimated, retrieved_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(workspace_id, provider_object_id, raw_metric, date, aggregation) DO UPDATE SET value = excluded.value, metric = excluded.metric, estimated = excluded.estimated, retrieved_at = excluded.retrieved_at`).bind(
        newId('met'), workspaceId, connectionId, byObject.get(m.providerObjectId) ?? null, ctx.connection.provider, m.providerObjectId, m.date.slice(0, 10), m.rawMetric, m.metric, m.value, m.aggregation, m.estimated ? 1 : 0, now),
    );
    for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
    return { rows: metrics.length, error: null };
  } catch (e) {
    const msg = e instanceof ProviderError ? `${e.kind}: ${e.message}` : 'metrics collection failed';
    await run(env, `INSERT INTO connection_capabilities(workspace_id, connection_id, capability, status, detail, checked_at) VALUES (?,?,?,?,?,?)
      ON CONFLICT(workspace_id, connection_id, capability) DO UPDATE SET status = excluded.status, detail = excluded.detail, checked_at = excluded.checked_at`,
      workspaceId, connectionId, 'read_metrics', e instanceof ProviderError && e.kind === 'capability' ? 'unavailable' : 'available', msg.slice(0, 300), nowIso());
    return { rows: 0, error: msg };
  }
}
