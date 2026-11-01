// Queue consumers. Deliveries can be duplicated or reordered; every handler
// re-reads durable state and relies on coordinator claims to stay idempotent.
import type { Env, JobMessage, QueueMessage } from '../lib/env.js';
import { nowIso } from '../lib/ids.js';
import { run } from '../lib/db.js';
import { log } from '../security/redact.js';
import { coordinator, refresher } from './coordinator.js';
import { executeDispatch, executePoll, executeReconcile, loadTarget, persistReceiptEarly } from './dispatch.js';
import { runJob } from './jobs.js';

const MAX_RECONCILE_PASSES = 24;

export async function handlePublishMessage(env: Env, msg: QueueMessage, owner: string): Promise<void> {
  const coord = coordinator(env, msg.workspace_id);
  const markOutbox = (state: 'done' | 'pending', at?: string) =>
    run(env, `UPDATE outbox SET state = ?, next_attempt_at = COALESCE(?, next_attempt_at), lease_owner = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ? AND workspace_id = ?`, state, at ?? null, nowIso(), msg.outbox_id, msg.workspace_id);

  if (msg.kind === 'dispatch') {
    const claim = await coord.claim(msg, owner);
    if (claim.kind === 'deferred') return void (await markOutbox('pending', claim.until));
    if (claim.kind === 'skip') {
      log('info', 'dispatch.skip', { target_id: msg.target_id, reason: claim.reason });
      return void (await markOutbox('done'));
    }
    const settlement = await executeDispatch(env, claim, refresher(env, msg.workspace_id, `dispatch:${msg.target_id}`));
    await persistReceiptEarly(env, claim.target, settlement);
    const next = await coord.settle(msg.workspace_id, msg.target_id, claim.fencing, settlement, 'submit');
    log('info', 'dispatch.settled', { target_id: msg.target_id, outcome: settlement.kind, next });
    return;
  }

  const current = await loadTarget(env, msg.workspace_id, msg.target_id);
  if (!current) return void (await markOutbox('done'));
  if (msg.kind === 'poll' && current.status !== 'processing') return void (await markOutbox('done'));
  if (msg.kind === 'reconcile' && !['outcome_unknown', 'processing'].includes(current.status)) return void (await markOutbox('done'));
  // Poll/reconcile passes are leased too, so duplicate deliveries never call the provider twice at once.
  const lease = await coord.claimPoll(msg.workspace_id, msg.target_id, owner);
  if (!lease) return void (await markOutbox('pending', new Date(Date.now() + 60_000).toISOString()));
  const t = lease.target;

  if (msg.kind === 'poll') {
    const settlement = await executePoll(env, t, refresher(env, msg.workspace_id, `poll:${t.id}`));
    await persistReceiptEarly(env, t, settlement);
    await coord.settle(msg.workspace_id, t.id, lease.fencing, settlement, 'poll');
    return;
  }

  const result = await executeReconcile(env, t, refresher(env, msg.workspace_id, `reconcile:${t.id}`));
  if (result.kind === 'native_canceled') {
    await coord.nativeCanceled(msg.workspace_id, t.id);
    return void (await markOutbox('done'));
  }
  if (result.kind === 'still_unknown') {
    const passes = (t.attempt_count ?? 0) + 1;
    await run(env, 'UPDATE targets SET attempt_count = attempt_count + 1, updated_at = ? WHERE workspace_id = ? AND id = ?', nowIso(), t.workspace_id, t.id);
    if (passes >= MAX_RECONCILE_PASSES) {
      log('error', 'alert.unknown_requires_operator', { workspace_id: t.workspace_id, target_id: t.id });
      return void (await markOutbox('done'));
    }
    return void (await markOutbox('pending', new Date(Date.now() + 3600_000).toISOString()));
  }
  await coord.settle(msg.workspace_id, t.id, lease.fencing, result, 'reconcile');
}

export async function handleQueueBatch(batch: MessageBatch<unknown>, env: Env, ctx: ExecutionContext): Promise<void> {
  const owner = `q:${crypto.randomUUID()}`;
  if (batch.queue.endsWith('-publish-dlq')) {
    // Dead-lettered deliveries are not replayed raw. The outbox row stays leased
    // and the cron lease-expiry path re-evaluates durable state; record for operators.
    for (const m of batch.messages) {
      log('error', 'alert.publish_dlq', { message: m.body as Record<string, unknown> });
      m.ack();
    }
    return;
  }
  if (batch.queue.endsWith('-publish')) {
    for (const m of batch.messages) {
      try {
        await handlePublishMessage(env, m.body as QueueMessage, owner);
        m.ack();
      } catch (e) {
        log('error', 'queue.publish_error', { error: e instanceof Error ? e.message : String(e), attempts: m.attempts });
        m.retry({ delaySeconds: Math.min(300, 5 * 2 ** m.attempts) });
      }
    }
    return;
  }
  for (const m of batch.messages) {
    try {
      await runJob(env, m.body as JobMessage, ctx);
      m.ack();
    } catch (e) {
      log('error', 'queue.job_error', { error: e instanceof Error ? e.message : String(e), attempts: m.attempts });
      m.retry({ delaySeconds: Math.min(600, 10 * 2 ** m.attempts) });
    }
  }
}
