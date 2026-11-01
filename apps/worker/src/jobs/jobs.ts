import type { Env, JobMessage } from '../lib/env.js';
import { nowIso } from '../lib/ids.js';
import { all, run } from '../lib/db.js';
import { log } from '../security/redact.js';
import { collectMetrics } from '../services/analytics.js';
import { runPrivacyJob } from '../services/privacy.js';
import { runReport } from '../services/reports.js';
import { runResearch } from '../services/research.js';

export async function runJob(env: Env, msg: JobMessage, _ctx: ExecutionContext) {
  switch (msg.kind) {
    case 'report':
      return runReport(env, msg.workspace_id, msg.job_id);
    case 'research':
      return runResearch(env, msg.workspace_id, msg.job_id);
    case 'metrics': {
      const r = await collectMetrics(env, msg.workspace_id, msg.connection_id);
      if (r.error) log('warn', 'metrics.collection_failed', { connection_id: msg.connection_id, error: r.error });
      return;
    }
    case 'privacy':
      return runPrivacyJob(env, msg.workspace_id, msg.job_id);
    case 'notify':
      return;
  }
}

/** Daily: metrics fan-out, retention cleanup, trial expiry bookkeeping. */
export async function dailyMaintenance(env: Env) {
  const now = new Date();
  const conns = await all<{ workspace_id: string; id: string }>(env, `SELECT workspace_id, id FROM connections WHERE state IN ('connected','expiring')`);
  for (let i = 0; i < conns.length; i += 100) {
    await env.JOBS_QUEUE.sendBatch(conns.slice(i, i + 100).map((c) => ({ body: { kind: 'metrics' as const, workspace_id: c.workspace_id, connection_id: c.id } })));
  }
  // Expire trials (entitlement is computed from trial_ends_at, this records it).
  await run(env, `UPDATE subscriptions SET status = 'expired', entitlement_version = entitlement_version + 1, updated_at = ? WHERE plan = 'trial' AND status = 'trialing' AND trial_ends_at < ?`, nowIso(), now.toISOString());
  // Retention: raw research 90 days, reports 30 days, OAuth states, idempotency records 30 days.
  const expiredSources = await all<{ id: string; r2_key: string | null }>(env, `SELECT id, r2_key FROM research_sources WHERE delete_after < ? AND r2_key IS NOT NULL LIMIT 500`, now.toISOString());
  if (expiredSources.length) {
    await env.MEDIA.delete(expiredSources.map((s) => s.r2_key!));
    for (const s of expiredSources) await run(env, 'UPDATE research_sources SET r2_key = NULL WHERE id = ?', s.id);
  }
  const expiredReports = await all<{ id: string; r2_key: string | null }>(env, `SELECT id, r2_key FROM report_jobs WHERE expires_at < ? AND r2_key IS NOT NULL LIMIT 500`, now.toISOString());
  if (expiredReports.length) {
    await env.MEDIA.delete(expiredReports.map((r) => r.r2_key!));
    for (const r of expiredReports) await run(env, `UPDATE report_jobs SET r2_key = NULL, status = 'failed', error = 'Expired after 30 days' WHERE id = ?`, r.id);
  }
  await run(env, 'DELETE FROM oauth_states WHERE expires_at < ?', new Date(now.getTime() - 86400_000).toISOString());
  await run(env, 'DELETE FROM idempotency_records WHERE created_at < ?', new Date(now.getTime() - 30 * 86400_000).toISOString());
  await run(env, `UPDATE sent_notifications SET dev_body = NULL WHERE dev_body IS NOT NULL AND created_at < ?`, new Date(now.getTime() - 7 * 86400_000).toISOString());
  await run(env, 'DELETE FROM billing_quotes WHERE expires_at < ? AND used_at IS NULL', new Date(now.getTime() - 7 * 86400_000).toISOString());
}
