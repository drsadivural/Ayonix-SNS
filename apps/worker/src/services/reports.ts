// CSV/PDF reports from real authorized analytics, stored in R2 under the
// workspace prefix, downloadable through short-lived signed links.
import type { Platform, ReportJob } from '@ayonix/contracts';
import { PLATFORMS } from '@ayonix/contracts';
import type { Env } from '../lib/env.js';
import { AppError, invalid, notFound } from '../lib/errors.js';
import { newId, nowIso } from '../lib/ids.js';
import { all, first, parseJson, run, stmt } from '../lib/db.js';
import { renderPdf, type PdfLine } from '../lib/pdf.js';
import { signToken, verifyToken } from '../security/crypto.js';
import { analytics, METRIC_DEFINITIONS, type AnalyticsQuery } from './analytics.js';
import { auditStmt } from './audit.js';
import type { Actor } from './context.js';
import { authorize, systemActor } from './context.js';

const DOWNLOAD_TTL = 15 * 60;
const RETENTION_DAYS = 30;

interface JobRow {
  id: string;
  workspace_id: string;
  format: 'csv' | 'pdf';
  filters_json: string;
  status: ReportJob['status'];
  r2_key: string | null;
  error: string | null;
  created_at: string;
  expires_at: string | null;
}

async function toJob(env: Env, r: JobRow): Promise<ReportJob> {
  let download_url: string | null = null;
  let download_expires_at: string | null = null;
  if (r.status === 'ready' && r.r2_key) {
    const s = await signToken(env, 'report', { ws: r.workspace_id, job: r.id }, DOWNLOAD_TTL);
    download_url = `${env.APP_ORIGIN}/u/report/${encodeURIComponent(s.token)}`;
    download_expires_at = s.expires_at;
  }
  return { id: r.id, format: r.format, status: r.status, error: r.error, download_url, download_expires_at, created_at: r.created_at };
}

export async function requestReport(env: Env, actor: Actor, input: { format: string; from_utc: string; to_utc: string; product_id?: string; platforms?: Platform[] }): Promise<ReportJob> {
  authorize(actor, 'read');
  if (input.format !== 'csv' && input.format !== 'pdf') throw invalid('Choose CSV or PDF', { format: 'csv or pdf' });
  if (input.platforms && input.platforms.some((p) => !(PLATFORMS as readonly string[]).includes(p))) throw invalid('Unknown platform');
  if (input.product_id && !(await first(env, 'SELECT 1 FROM products WHERE workspace_id = ? AND id = ?', actor.workspaceId, input.product_id))) throw notFound('Product');
  const filters: AnalyticsQuery = { from_utc: input.from_utc, to_utc: input.to_utc, ...(input.product_id ? { product_id: input.product_id } : {}), ...(input.platforms ? { platforms: input.platforms } : {}) };
  await analytics(env, actor, filters); // validates the range before queueing
  const id = newId('rpt');
  const now = nowIso();
  await env.DB.batch([
    stmt(env, `INSERT INTO report_jobs(id, workspace_id, requested_by, format, filters_json, status, created_at) VALUES (?,?,?,?,?,?,?)`, id, actor.workspaceId, actor.identityId, input.format, JSON.stringify(filters), 'queued', now),
    auditStmt(env, actor, 'report.requested', 'report', id, { format: input.format }),
  ]);
  try {
    await env.JOBS_QUEUE.send({ kind: 'report', workspace_id: actor.workspaceId, job_id: id });
  } catch {
    await env.DB.prepare(`UPDATE report_jobs SET status = 'failed', error = 'Could not queue the job. Try again.' WHERE id = ?`).bind(id).run();
    throw new AppError('unavailable', 'The job could not be queued. Try again.', { retryable: true });
  }
  return toJob(env, (await first<JobRow>(env, 'SELECT * FROM report_jobs WHERE id = ?', id))!);
}

export async function getReport(env: Env, actor: Actor, id: string): Promise<ReportJob> {
  authorize(actor, 'read');
  const r = await first<JobRow>(env, 'SELECT * FROM report_jobs WHERE workspace_id = ? AND id = ?', actor.workspaceId, id);
  if (!r) throw notFound('Report');
  return toJob(env, r);
}

export async function listReports(env: Env, actor: Actor): Promise<ReportJob[]> {
  authorize(actor, 'read');
  const rows = await all<JobRow>(env, 'SELECT * FROM report_jobs WHERE workspace_id = ? ORDER BY created_at DESC LIMIT 20', actor.workspaceId);
  return Promise.all(rows.map((r) => toJob(env, r)));
}

const csvCell = (v: unknown) => {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // spreadsheet formula injection guard
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const fmt = (v: number | null) => (v === null ? 'Not available' : String(v));

export async function runReport(env: Env, workspaceId: string, jobId: string) {
  const job = await first<JobRow>(env, 'SELECT * FROM report_jobs WHERE workspace_id = ? AND id = ?', workspaceId, jobId);
  if (!job || job.status === 'ready') return;
  await run(env, `UPDATE report_jobs SET status = 'running' WHERE id = ?`, jobId);
  try {
    const filters = parseJson<AnalyticsQuery>(job.filters_json, { from_utc: '', to_utc: '' });
    const data = await analytics(env, systemActor(workspaceId, `report:${jobId}`), filters);
    const ws = await first<{ name: string }>(env, 'SELECT name FROM workspaces WHERE id = ?', workspaceId);
    const generated = nowIso();
    let body: Uint8Array;
    let type: string;
    if (job.format === 'csv') {
      const rows: unknown[][] = [
        ['Ayonix-SNS report', ws?.name ?? ''],
        ['Period (UTC)', data.period.from, data.period.to],
        ['Generated (UTC)', generated],
        ['Data freshness (latest provider retrieval)', data.freshness ?? 'No provider metrics collected'],
        [],
        ['Metric', 'Value', 'Definition'],
        ['Published', data.totals.published, METRIC_DEFINITIONS.published],
        ['Scheduled', data.totals.scheduled, METRIC_DEFINITIONS.scheduled],
        ['Impressions', fmt(data.totals.impressions), METRIC_DEFINITIONS.impressions],
        ['Engagements', fmt(data.totals.engagements), METRIC_DEFINITIONS.engagements],
        [],
        ['Channel', 'Impressions', 'Engagements', 'Retrieved at', 'Note'],
        ...data.by_channel.map((c) => [c.platform, fmt(c.impressions), fmt(c.engagements), c.retrieved_at ?? '', c.note ?? '']),
        [],
        ['Top posts', 'Platform', 'Impressions', 'Engagements', 'URL'],
        ...data.top_posts.map((p) => [p.caption_preview, p.platform, fmt(p.impressions), fmt(p.engagements), p.url ?? '']),
        [],
        ['Daily impressions (UTC date)', 'Value'],
        ...data.series.points.map((p) => [p.date, fmt(p.value)]),
      ];
      body = new TextEncoder().encode('﻿' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n');
      type = 'text/csv; charset=utf-8';
    } else {
      const lines: PdfLine[] = [
        { text: 'Ayonix-SNS report', size: 18, bold: true, gap: 6 },
        { text: `${ws?.name ?? ''}` },
        { text: `Period (UTC): ${data.period.from} to ${data.period.to}` },
        { text: `Generated (UTC): ${generated}` },
        { text: `Data freshness: ${data.freshness ?? 'no provider metrics collected'}`, gap: 10 },
        { text: 'Totals', size: 13, bold: true },
        { text: `Published: ${data.totals.published}` },
        { text: `Scheduled: ${data.totals.scheduled}` },
        { text: `Impressions: ${fmt(data.totals.impressions)}` },
        { text: `Engagements: ${fmt(data.totals.engagements)}`, gap: 10 },
        { text: 'By channel', size: 13, bold: true },
        ...data.by_channel.map((c) => ({ text: `${c.platform}: impressions ${fmt(c.impressions)}, engagements ${fmt(c.engagements)}${c.note ? ` (${c.note})` : ''}` })),
        { text: '', gap: 8 },
        { text: 'Top posts', size: 13, bold: true },
        ...(data.top_posts.length ? data.top_posts.map((p) => ({ text: `${p.platform}: ${p.caption_preview} | impressions ${fmt(p.impressions)} | ${p.url ?? 'no URL'}` })) : [{ text: 'No published posts in this period.' }]),
        { text: '', gap: 8 },
        { text: 'Definitions', size: 13, bold: true },
        ...Object.entries(METRIC_DEFINITIONS).map(([k, v]) => ({ text: `${k}: ${v}`, size: 9 })),
      ];
      body = renderPdf(lines);
      type = 'application/pdf';
    }
    const key = `ws/${workspaceId}/reports/${jobId}.${job.format}`;
    await env.MEDIA.put(key, body, { httpMetadata: { contentType: type } });
    await run(env, `UPDATE report_jobs SET status = 'ready', r2_key = ?, completed_at = ?, expires_at = ? WHERE id = ?`, key, nowIso(), new Date(Date.now() + RETENTION_DAYS * 86400_000).toISOString(), jobId);
  } catch (e) {
    await run(env, `UPDATE report_jobs SET status = 'failed', error = ?, completed_at = ? WHERE id = ?`, e instanceof AppError ? e.message : 'Report generation failed', nowIso(), jobId);
    throw e;
  }
}

export async function serveReport(env: Env, token: string): Promise<Response> {
  const claims = await verifyToken<{ ws: string; job: string }>(env, 'report', token);
  const job = await first<JobRow>(env, `SELECT * FROM report_jobs WHERE workspace_id = ? AND id = ? AND status = 'ready'`, claims.ws, claims.job);
  if (!job?.r2_key) throw notFound('Report');
  const obj = await env.MEDIA.get(job.r2_key);
  if (!obj) throw notFound('Report');
  return new Response(obj.body, {
    headers: {
      'content-type': job.format === 'csv' ? 'text/csv; charset=utf-8' : 'application/pdf',
      'content-disposition': `attachment; filename="ayonix-report-${job.id}.${job.format}"`,
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}
