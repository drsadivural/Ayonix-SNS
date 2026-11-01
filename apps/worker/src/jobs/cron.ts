// Every minute: lease due outbox rows (keyset batches with backpressure) and
// enqueue them; an outbox row stays retryable until enqueue is acknowledged.
// Daily: metrics collection, retention cleanup, trial expiry, period checks.
import type { Env, QueueMessage } from '../lib/env.js';
import { newId, nowIso } from '../lib/ids.js';
import { all, run } from '../lib/db.js';
import { log } from '../security/redact.js';
import { sweepExpiredClaims } from './dispatch.js';
import { dailyMaintenance } from './jobs.js';

const BATCH = 100;
const MAX_PER_TICK = 1000;
const LEASE_MS = 2 * 60_000;

export async function scanOutbox(env: Env, now = new Date()): Promise<{ enqueued: number }> {
  const owner = `cron:${newId('lease')}`;
  const nowS = now.toISOString();
  let enqueued = 0;
  let cursor: [string, string] | null = null;
  while (enqueued < MAX_PER_TICK) {
    const rows: Array<{ id: string; workspace_id: string; target_id: string; revision: number; kind: QueueMessage['kind']; next_attempt_at: string; state: string }> = await all(
      env,
      `SELECT id, workspace_id, target_id, revision, kind, next_attempt_at, state FROM outbox
       WHERE ((state = 'pending' AND next_attempt_at <= ?) OR (state = 'leased' AND lease_expires_at < ?) OR (state = 'enqueued' AND updated_at < ?))
       ${cursor ? 'AND (next_attempt_at, id) > (?, ?)' : ''}
       ORDER BY next_attempt_at, id LIMIT ?`,
      nowS, nowS, new Date(now.getTime() - 15 * 60_000).toISOString(), ...(cursor ?? []), BATCH,
    );
    if (!rows.length) break;
    cursor = [rows.at(-1)!.next_attempt_at, rows.at(-1)!.id];
    const leased: typeof rows = [];
    for (const r of rows) {
      const res = await run(env, `UPDATE outbox SET state = 'leased', lease_owner = ?, lease_expires_at = ?, enqueue_attempts = enqueue_attempts + 1, updated_at = ? WHERE id = ? AND state = ?`,
        owner, new Date(now.getTime() + LEASE_MS).toISOString(), nowS, r.id, r.state);
      if (res.meta.changes) leased.push(r);
    }
    if (!leased.length) continue;
    // Informative state for dispatch rows whose time has come.
    for (const r of leased) {
      if (r.kind === 'dispatch') await run(env, `UPDATE targets SET status = 'queued', version = version + 1, updated_at = ? WHERE workspace_id = ? AND id = ? AND status = 'scheduled'`, nowS, r.workspace_id, r.target_id);
    }
    try {
      await env.PUBLISH_QUEUE.sendBatch(leased.map((r) => ({ body: { kind: r.kind, workspace_id: r.workspace_id, target_id: r.target_id, revision: r.revision, outbox_id: r.id } satisfies QueueMessage })));
    } catch (e) {
      // Leave rows leased; they become eligible again when the lease expires.
      log('error', 'outbox.enqueue_failed', { error: e instanceof Error ? e.message : String(e), count: leased.length });
      break;
    }
    for (const r of leased) await run(env, `UPDATE outbox SET state = 'enqueued', updated_at = ? WHERE id = ? AND lease_owner = ?`, nowIso(), r.id, owner);
    enqueued += leased.length;
  }
  return { enqueued };
}

/** Due-target lag monitoring: dispatch not started 5 minutes after due time. */
export async function lagAlerts(env: Env, now = new Date()) {
  const late = await all<{ n: number }>(env, `SELECT COUNT(*) AS n FROM targets WHERE status IN ('scheduled','queued') AND due_at < ? AND scheduling_owner = 'ayonix'`, new Date(now.getTime() - 5 * 60_000).toISOString());
  const unknown = await all<{ n: number }>(env, `SELECT COUNT(*) AS n FROM targets WHERE status = 'outcome_unknown' AND updated_at < ?`, new Date(now.getTime() - 15 * 60_000).toISOString());
  if ((late[0]?.n ?? 0) > 0) log('warn', 'alert.dispatch_lag', { late_targets: late[0]!.n });
  if ((unknown[0]?.n ?? 0) > 0) log('warn', 'alert.unknown_outcomes', { count: unknown[0]!.n });
}

export async function handleScheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
  if (controller.cron === '17 3 * * *') {
    ctx.waitUntil(dailyMaintenance(env));
    return;
  }
  await sweepExpiredClaims(env);
  await scanOutbox(env, new Date(controller.scheduledTime));
  await lagAlerts(env);
}
