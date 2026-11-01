// Durable dispatcher. Claims are serialized per workspace by the coordinator
// Durable Object and fenced in D1; provider calls run in the queue consumer.
// Queues may redeliver: a claim only succeeds from a dispatchable state, so a
// duplicate message is a no-op. A claim that expires after submission started
// becomes outcome_unknown and is reconciled — never blindly re-published.
import type { Platform, TargetState } from '@ayonix/contracts';
import { retryDelaySeconds } from '@ayonix/domain';
import type { Env, QueueMessage } from '../lib/env.js';
import { newId, nowIso } from '../lib/ids.js';
import { all, first, isGuardError, parseJson, run, stmt, guardChanged } from '../lib/db.js';
import { log, safeProviderMessage } from '../security/redact.js';
import { adapterFor } from '../providers/registry.js';
import type { MediaItem, ProviderAdapter, ProviderContext, PublishContent, Receipt } from '../providers/types.js';
import { ProviderError } from '../providers/types.js';
import { auditStmt } from '../services/audit.js';
import { loadRevision } from '../services/campaigns.js';
import { ensureFreshTokens, markReconnectRequired, providerContext } from '../services/connections.js';
import { openAssetStream, signedMediaUrl } from '../services/assets.js';
import { releaseAndCancelStatements } from '../services/schedules.js';
import { entitlementsFrom, getSubscription, notifyWorkspace } from '../services/workspace.js';

/** Test seam: contract tests substitute a provider double. Never set in deployed code. */
export const testHooks: { adapter: ((p: Platform) => ProviderAdapter) | null; fetch: typeof fetch | null } = { adapter: null, fetch: null };
const adapter = (env: Env, p: Platform) => (env.ENVIRONMENT === 'test' && testHooks.adapter ? testHooks.adapter(p) : adapterFor(p));
export const providerFetch = (env: Env) => (env.ENVIRONMENT === 'test' && testHooks.fetch ? testHooks.fetch : fetch);

const CLAIM_LEASE_MS = 10 * 60_000;
/** Do not burst-publish long-missed posts (payment hold, outage): ask the user to reschedule. */
export const MISSED_WINDOW_MS = 6 * 3600_000;
const MAX_PAYMENT_HOLD_MS = 72 * 3600_000;
const MAX_PROCESSING_MS = 24 * 3600_000;

export interface TargetRecord {
  id: string;
  workspace_id: string;
  schedule_id: string;
  post_id: string;
  revision: number;
  content_revision_id: string;
  connection_id: string;
  period_id: string;
  platform: Platform;
  format: string;
  status: TargetState;
  version: number;
  due_at: string;
  scheduling_owner: 'ayonix' | 'provider_native';
  approval_id: string | null;
  attempt_count: number;
  fencing_token: number;
  claim_expires_at: string | null;
  submission_started_at: string | null;
  hold_reason: string | null;
}

export async function loadTarget(env: Env, workspaceId: string, targetId: string) {
  return first<TargetRecord>(env, 'SELECT * FROM targets WHERE workspace_id = ? AND id = ?', workspaceId, targetId);
}

export type ClaimResult =
  | { kind: 'claimed'; target: TargetRecord; fencing: number; attempt: number }
  | { kind: 'skip'; reason: string }
  | { kind: 'deferred'; until: string; reason: string };

/** Runs inside the coordinator. Decides whether this delivery may dispatch now. */
export async function claimForDispatch(env: Env, msg: QueueMessage, owner: string): Promise<ClaimResult> {
  const t = await loadTarget(env, msg.workspace_id, msg.target_id);
  if (!t) return { kind: 'skip', reason: 'target_missing' };
  if (!['scheduled', 'queued', 'retry_wait'].includes(t.status)) return { kind: 'skip', reason: `status_${t.status}` };
  const now = Date.now();
  const due = new Date(t.due_at).getTime();
  const native = t.scheduling_owner === 'provider_native';
  if (!native && due > now + 5_000) return { kind: 'deferred', until: t.due_at, reason: 'not_due' };
  if (t.status === 'retry_wait') {
    const next = await first<{ next_attempt_at: string | null }>(env, 'SELECT next_attempt_at FROM targets WHERE workspace_id = ? AND id = ?', t.workspace_id, t.id);
    if (next?.next_attempt_at && new Date(next.next_attempt_at).getTime() > now + 5_000) return { kind: 'deferred', until: next.next_attempt_at, reason: 'retry_wait' };
  }
  const requestId = `dispatch:${t.id}`;
  const ws = await first<{ status: string }>(env, 'SELECT status FROM workspaces WHERE id = ?', t.workspace_id);
  if (ws?.status !== 'active') {
    await failAndRelease(env, t, 'workspace_inactive', 'The workspace is not active, so publishing is paused.', requestId);
    return { kind: 'skip', reason: 'workspace_inactive' };
  }
  // Entitlement gate: past_due holds; terminal billing states fail.
  const ent = entitlementsFrom(await getSubscription(env, t.workspace_id));
  if (ent.status === 'past_due') {
    if (now - due > MAX_PAYMENT_HOLD_MS) {
      await failAndRelease(env, t, 'payment_hold_expired', 'Held more than 72 hours while payment failed. Schedule it again after payment recovers.', requestId);
      return { kind: 'skip', reason: 'payment_hold_expired' };
    }
    const until = new Date(now + 10 * 60_000).toISOString();
    await run(env, `UPDATE targets SET hold_reason = 'payment_past_due', updated_at = ? WHERE workspace_id = ? AND id = ?`, nowIso(), t.workspace_id, t.id);
    return { kind: 'deferred', until, reason: 'payment_past_due' };
  }
  if (!['active', 'trialing'].includes(ent.status)) {
    await failAndRelease(env, t, 'entitlement_inactive', ent.restriction ?? 'Publishing is paused for this workspace.', requestId);
    return { kind: 'skip', reason: 'entitlement_inactive' };
  }
  if (!native && now - due > MISSED_WINDOW_MS) {
    await failAndRelease(env, t, 'missed_window', 'The scheduled time passed long ago (for example during a payment hold or outage). Ayonix does not burst-publish late posts; schedule it again.', requestId, 'missed_window');
    return { kind: 'skip', reason: 'missed_window' };
  }
  const conn = await first<{ state: string }>(env, 'SELECT state FROM connections WHERE workspace_id = ? AND id = ?', t.workspace_id, t.connection_id);
  if (!conn || !['connected', 'expiring'].includes(conn.state)) {
    await run(env, `UPDATE targets SET status = 'reconnect_required', version = version + 1, updated_at = ? WHERE workspace_id = ? AND id = ? AND version = ?`, nowIso(), t.workspace_id, t.id, t.version);
    return { kind: 'skip', reason: 'reconnect_required' };
  }
  if (t.platform === 'tiktok' && !t.approval_id) return { kind: 'skip', reason: 'approval_missing' };
  const nowS = nowIso();
  const fencing = t.fencing_token + 1;
  const attempt = t.attempt_count + 1;
  try {
    await env.DB.batch([
      stmt(env, `UPDATE targets SET status = 'submitting', claim_owner = ?, claim_expires_at = ?, fencing_token = ?, attempt_count = ?, submission_started_at = ?, hold_reason = NULL, version = version + 1, updated_at = ?
        WHERE workspace_id = ? AND id = ? AND version = ? AND status IN ('scheduled','queued','retry_wait')`,
        owner, new Date(now + CLAIM_LEASE_MS).toISOString(), fencing, attempt, nowS, nowS, t.workspace_id, t.id, t.version),
      guardChanged(env),
      stmt(env, `INSERT INTO attempts(id, workspace_id, target_id, attempt_no, fencing_token, phase, started_at, correlation_id) VALUES (?,?,?,?,?,?,?,?)`, newId('att'), t.workspace_id, t.id, attempt, fencing, 'submit', nowS, `${t.id}:${attempt}`),
    ]);
  } catch (e) {
    if (isGuardError(e)) return { kind: 'skip', reason: 'lost_race' };
    throw e;
  }
  return { kind: 'claimed', target: { ...t, status: 'submitting', version: t.version + 1, fencing_token: fencing, attempt_count: attempt }, fencing, attempt };
}

async function failAndRelease(env: Env, t: TargetRecord, code: string, message: string, requestId: string, holdReason: string | null = null) {
  try {
    await env.DB.batch([
      ...releaseAndCancelStatements(env, t.workspace_id, t.id, t.version, t.period_id, 'failed', code, message),
      ...(holdReason ? [stmt(env, 'UPDATE targets SET hold_reason = ? WHERE workspace_id = ? AND id = ?', holdReason, t.workspace_id, t.id)] : []),
      auditStmt(env, { workspaceId: t.workspace_id, actorType: 'system', requestId }, 'target.failed', 'target', t.id, { code }),
    ]);
  } catch (e) {
    if (!isGuardError(e)) throw e;
  }
  await notifyWorkspace(env, t.workspace_id, 'publish_failed', 'A scheduled post was not published', `A ${t.platform} post scheduled for ${t.due_at} was not published: ${message}\n\nDetails: ${env.APP_ORIGIN}/dashboard?target=${t.id}`, `failed:${t.id}`);
}

/** Build provider content from the immutable revision, approval settings and owned media. */
export async function buildContent(env: Env, t: TargetRecord): Promise<PublishContent> {
  const rows = await loadRevision(env, t.workspace_id, t.post_id, t.revision);
  const cr = rows.find((r) => r.id === t.content_revision_id);
  if (!cr) throw new ProviderError('validation', 'content_missing', 'The approved content revision is missing.');
  let options: Record<string, unknown> = { ...cr.options };
  let caption = cr.caption;
  if (t.platform === 'tiktok') {
    const approval = await first<{ settings_json: string; content_hash: string }>(env, 'SELECT settings_json, content_hash FROM approvals WHERE workspace_id = ? AND id = ? AND target_id = ?', t.workspace_id, t.approval_id, t.id);
    if (!approval || approval.content_hash !== cr.content_hash) throw new ProviderError('validation', 'approval_mismatch', 'The TikTok approval does not match this content.');
    const settings = parseJson<Record<string, unknown>>(approval.settings_json, {});
    options = { ...options, ...settings };
    if (typeof settings.title === 'string') caption = settings.title;
  }
  const media: MediaItem[] = [];
  for (const assetId of cr.asset_ids) {
    const a = await first<{ mime: string; bytes: number; width: number | null; height: number | null; duration_ms: number | null; filename: string }>(
      env, `SELECT mime, bytes, width, height, duration_ms, filename FROM assets WHERE workspace_id = ? AND id = ? AND validation_state = 'valid'`, t.workspace_id, assetId);
    if (!a) throw new ProviderError('validation', 'asset_missing', 'A media item is no longer available.');
    media.push({
      assetId,
      mime: a.mime,
      bytes: a.bytes,
      width: a.width,
      height: a.height,
      durationMs: a.duration_ms,
      filename: a.filename,
      publicUrl: await signedMediaUrl(env, t.workspace_id, assetId, 6 * 3600),
      open: () => openAssetStream(env, t.workspace_id, assetId),
    });
  }
  return { format: cr.format, caption, title: cr.title, linkUrl: cr.link_url, options, media, publishAt: t.scheduling_owner === 'provider_native' ? t.due_at : null };
}

export type Settlement =
  | { kind: 'published'; receipt: Receipt }
  | { kind: 'processing'; receipt: Receipt; pollAfterSeconds: number }
  | { kind: 'retry'; code: string; message: string; retryAfterSeconds: number | null }
  | { kind: 'failed'; code: string; message: string; receipt?: Receipt }
  | { kind: 'reconnect'; code: string; message: string }
  | { kind: 'unknown'; code: string; message: string; receipt?: Receipt };

/** Queue consumer side: perform provider calls for a claimed target. */
export async function executeDispatch(env: Env, claim: Extract<ClaimResult, { kind: 'claimed' }>, refresh: (ctx: ProviderContext) => Promise<ProviderContext>): Promise<Settlement> {
  const t = claim.target;
  const a = adapter(env, t.platform);
  let ctx: ProviderContext;
  let content: PublishContent;
  try {
    ctx = await refresh(await providerContext(env, t.workspace_id, t.connection_id, `${t.id}:${claim.attempt}`, providerFetch(env)));
    content = await buildContent(env, t);
    const problems = a.validatePost(ctx, content);
    if (problems.length) return { kind: 'failed', code: 'validation', message: problems.join(' ') };
  } catch (e) {
    return classify(e, false);
  }
  let uploaded: Record<string, unknown>;
  try {
    uploaded = await a.uploadMedia(ctx, content);
  } catch (e) {
    return classify(e, false);
  }
  try {
    const result = await a.submitPost(ctx, content, uploaded);
    return result.kind === 'published' ? { kind: 'published', receipt: result.receipt } : { kind: 'processing', receipt: result.receipt, pollAfterSeconds: result.pollAfterSeconds };
  } catch (e) {
    return classify(e, true);
  }
}

function classify(e: unknown, afterSubmit: boolean): Settlement {
  if (e instanceof ProviderError) {
    switch (e.kind) {
      case 'rate_limited':
        return { kind: 'retry', code: e.code, message: e.message, retryAfterSeconds: e.retryAfterSeconds };
      case 'transient':
        return { kind: 'retry', code: e.code, message: e.message, retryAfterSeconds: e.retryAfterSeconds };
      case 'reconnect_required':
        return { kind: 'reconnect', code: e.code, message: e.message };
      case 'validation':
      case 'capability':
        return { kind: 'failed', code: e.code, message: e.message };
      case 'ambiguous':
        return { kind: 'unknown', code: e.code, message: e.message };
    }
  }
  log('error', 'dispatch.unexpected_error', { error: e instanceof Error ? e.message : String(e), after_submit: afterSubmit });
  // An unexpected error after submission started may have reached the provider.
  return afterSubmit ? { kind: 'unknown', code: 'internal_error', message: 'An internal error occurred after submission started.' } : { kind: 'retry', code: 'internal_error', message: 'Temporary internal error.', retryAfterSeconds: null };
}

function receiptUpsert(env: Env, t: TargetRecord, receipt: Receipt, status: 'accepted' | 'processing' | 'published' | 'failed' | 'unknown', verified: boolean) {
  const now = nowIso();
  return stmt(env, `INSERT INTO provider_receipts(id, workspace_id, target_id, provider, remote_id, container_id, publish_id, url, status, raw_status, verified_at, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(workspace_id, target_id) DO UPDATE SET remote_id = COALESCE(excluded.remote_id, remote_id), container_id = COALESCE(excluded.container_id, container_id),
      publish_id = COALESCE(excluded.publish_id, publish_id), url = COALESCE(excluded.url, url), status = excluded.status, raw_status = excluded.raw_status,
      verified_at = COALESCE(excluded.verified_at, verified_at), updated_at = excluded.updated_at`,
    newId('rcp'), t.workspace_id, t.id, t.platform, receipt.remoteId, receipt.containerId, receipt.publishId, receipt.url, status, JSON.stringify(receipt.state ?? {}).slice(0, 4000), verified ? now : null, now, now);
}

/**
 * Persist a provider receipt as soon as the provider answers, outside the
 * fenced settlement, so a lost lease or a failed settle never loses the id.
 */
export async function persistReceiptEarly(env: Env, t: TargetRecord, s: Settlement) {
  const receipt = 'receipt' in s ? s.receipt : undefined;
  if (!receipt || (!receipt.remoteId && !receipt.containerId && !receipt.publishId)) return;
  const status = s.kind === 'published' ? 'accepted' : s.kind === 'processing' ? 'processing' : 'unknown';
  await receiptUpsert(env, t, receipt, status, false).run();
}

/**
 * Runs inside the coordinator: apply a settlement only if the fencing token
 * still matches (a stale worker can never overwrite a newer claim).
 */
export async function applySettlement(env: Env, workspaceId: string, targetId: string, fencing: number, s: Settlement, phase: 'submit' | 'poll' | 'reconcile'): Promise<TargetState | 'stale'> {
  const t = await loadTarget(env, workspaceId, targetId);
  if (!t || t.fencing_token !== fencing) return 'stale';
  // A late submit result may still land after the lease sweeper marked the
  // target unknown (same fencing token): a real provider id resolves it.
  const lateSubmit = phase === 'submit' && t.status === 'outcome_unknown' && (s.kind === 'published' || s.kind === 'processing');
  const from = phase === 'submit' ? ['submitting'] : phase === 'poll' ? ['processing'] : ['outcome_unknown', 'processing'];
  if (!from.includes(t.status) && !lateSubmit) return 'stale';
  const now = nowIso();
  const requestId = `settle:${t.id}:${fencing}`;
  const sys = { workspaceId, actorType: 'system' as const, requestId };
  const cas = (status: TargetState, extra = '', ...binds: unknown[]) => [
    stmt(env, `UPDATE targets SET status = ?, version = version + 1, claim_owner = NULL, claim_expires_at = NULL, updated_at = ?${extra} WHERE workspace_id = ? AND id = ? AND version = ? AND fencing_token = ?`, status, now, ...binds, workspaceId, targetId, t.version, fencing),
    guardChanged(env),
  ];
  const finishAttempt = (outcome: string, code: string | null, message: string | null, retryAfter: number | null = null) =>
    stmt(env, `UPDATE attempts SET finished_at = ?, outcome = ?, error_code = ?, error_message = ?, retry_after_seconds = ? WHERE workspace_id = ? AND target_id = ? AND fencing_token = ? AND finished_at IS NULL`, now, outcome, code, message ? safeProviderMessage(message) : null, retryAfter, workspaceId, targetId, fencing);
  const doneOutbox = (kinds: string[]) => stmt(env, `UPDATE outbox SET state = 'done', updated_at = ? WHERE workspace_id = ? AND target_id = ? AND kind IN (${kinds.map(() => '?').join(',')}) AND state <> 'done'`, now, workspaceId, targetId, ...kinds);
  const upsertOutbox = (kind: 'poll' | 'reconcile' | 'dispatch', at: string) =>
    stmt(env, `INSERT INTO outbox(id, workspace_id, target_id, revision, kind, state, next_attempt_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)
      ON CONFLICT(workspace_id, target_id, revision, kind) DO UPDATE SET state = 'pending', next_attempt_at = excluded.next_attempt_at, lease_owner = NULL, lease_expires_at = NULL, updated_at = excluded.updated_at`,
      newId('obx'), workspaceId, targetId, 1, kind, 'pending', at, now, now);
  let statements: D1PreparedStatement[] = [];
  let next: TargetState;
  try {
    switch (s.kind) {
      case 'published': {
        if (!s.receipt.remoteId) throw new Error('published settlement without provider id');
        next = 'published';
        statements = [
          ...cas('published', ', provider_post_id = ?, provider_url = ?, last_error_code = NULL, last_error_message = NULL', s.receipt.remoteId, s.receipt.url),
          receiptUpsert(env, t, s.receipt, 'published', true),
          stmt(env, `UPDATE quota_ledger SET state = 'committed', settled_at = ? WHERE workspace_id = ? AND target_id = ? AND state = 'reserved'`, now, workspaceId, targetId),
          stmt(env, `UPDATE quota_periods SET reserved = reserved - 1, used = used + 1, version = version + 1 WHERE workspace_id = ? AND id = ? AND changes() = 1`, workspaceId, t.period_id),
          finishAttempt('published', null, null),
          doneOutbox(['dispatch', 'poll', 'reconcile']),
          auditStmt(env, sys, 'target.published', 'target', targetId, { remote_id: s.receipt.remoteId, phase }),
        ];
        break;
      }
      case 'processing': {
        const started = t.submission_started_at ? new Date(t.submission_started_at).getTime() : Date.now();
        const nativeWaiting = t.scheduling_owner === 'provider_native' && new Date(t.due_at).getTime() + MAX_PROCESSING_MS > Date.now();
        if (!nativeWaiting && Date.now() - started > MAX_PROCESSING_MS) {
          next = 'outcome_unknown';
          statements = [
            ...cas('outcome_unknown', ', last_error_code = ?, last_error_message = ?', 'processing_timeout', 'The provider has been processing for over 24 hours.'),
            receiptUpsert(env, t, s.receipt, 'unknown', false),
            finishAttempt('unknown', 'processing_timeout', null),
            doneOutbox(['dispatch', 'poll']),
            upsertOutbox('reconcile', new Date(Date.now() + 3600_000).toISOString()),
          ];
          break;
        }
        next = 'processing';
        statements = [
          // Keep the fencing token: polling continues under the same claim lineage.
          stmt(env, `UPDATE targets SET status = 'processing', version = version + 1, claim_owner = NULL, claim_expires_at = NULL, updated_at = ? WHERE workspace_id = ? AND id = ? AND version = ? AND fencing_token = ?`, now, workspaceId, targetId, t.version, fencing),
          guardChanged(env),
          receiptUpsert(env, t, s.receipt, 'processing', false),
          finishAttempt('processing', null, null),
          doneOutbox(['dispatch']),
          upsertOutbox('poll', new Date(Date.now() + Math.max(5, s.pollAfterSeconds) * 1000).toISOString()),
        ];
        break;
      }
      case 'retry': {
        const delay = retryDelaySeconds(t.attempt_count, s.retryAfterSeconds);
        if (delay === null) {
          // Retries exhausted on a request proven not to have created content: definite failure.
          next = 'failed';
          statements = [
            ...releaseAndCancelStatements(env, workspaceId, targetId, t.version, t.period_id, 'failed', s.code, `Gave up after ${t.attempt_count} attempts: ${safeProviderMessage(s.message)}`),
            finishAttempt('failed', s.code, s.message),
            stmt(env, `UPDATE outbox SET state = 'dead', updated_at = ? WHERE workspace_id = ? AND target_id = ? AND kind = 'dispatch'`, now, workspaceId, targetId),
            auditStmt(env, sys, 'target.dead_lettered', 'target', targetId, { code: s.code }),
          ];
          break;
        }
        const at = new Date(Date.now() + delay * 1000).toISOString();
        next = 'retry_wait';
        statements = [
          ...cas('retry_wait', ', next_attempt_at = ?, last_error_code = ?, last_error_message = ?', at, s.code, safeProviderMessage(s.message)),
          finishAttempt('retry', s.code, s.message, s.retryAfterSeconds),
          upsertOutbox('dispatch', at),
          auditStmt(env, sys, 'target.retry_scheduled', 'target', targetId, { code: s.code, delay_seconds: delay }),
        ];
        break;
      }
      case 'failed': {
        next = 'failed';
        statements = [
          ...releaseAndCancelStatements(env, workspaceId, targetId, t.version, t.period_id, 'failed', s.code, safeProviderMessage(s.message)),
          ...(s.receipt ? [receiptUpsert(env, t, s.receipt, 'failed', true)] : []),
          finishAttempt('failed', s.code, s.message),
          auditStmt(env, sys, 'target.failed', 'target', targetId, { code: s.code, phase }),
        ];
        break;
      }
      case 'reconnect': {
        // Before submission: pause (reservation kept until the user reconnects or cancels).
        // During poll/reconcile: content may exist, so the outcome is unknown.
        next = phase === 'submit' ? 'reconnect_required' : 'outcome_unknown';
        statements = [
          ...cas(next, ', last_error_code = ?, last_error_message = ?', s.code, safeProviderMessage(s.message)),
          finishAttempt(next, s.code, s.message),
          doneOutbox(['dispatch', 'poll']),
          ...(phase === 'submit' ? [] : [upsertOutbox('reconcile', new Date(Date.now() + 15 * 60_000).toISOString())]),
          auditStmt(env, sys, `target.${next}`, 'target', targetId, { code: s.code }),
        ];
        break;
      }
      case 'unknown': {
        next = 'outcome_unknown';
        statements = [
          ...cas('outcome_unknown', ', last_error_code = ?, last_error_message = ?', s.code, safeProviderMessage(s.message)),
          ...(s.receipt ? [receiptUpsert(env, t, s.receipt, 'unknown', false)] : []),
          finishAttempt('unknown', s.code, s.message),
          doneOutbox(['dispatch', 'poll']),
          upsertOutbox('reconcile', new Date(Date.now() + 5 * 60_000).toISOString()),
          auditStmt(env, sys, 'target.outcome_unknown', 'target', targetId, { code: s.code, phase }),
        ];
        break;
      }
    }
    await env.DB.batch(statements);
  } catch (e) {
    if (isGuardError(e)) return 'stale';
    throw e;
  }
  if (next === 'failed' && s.kind !== 'retry') {
    await notifyWorkspace(env, workspaceId, 'publish_failed', 'A scheduled post failed', `A ${t.platform} post failed: ${'message' in s ? safeProviderMessage(s.message) : ''}\n\nDetails: ${env.APP_ORIGIN}/dashboard?target=${targetId}`, `failed:${targetId}`);
  }
  if (s.kind === 'reconnect') await markReconnectRequired(env, workspaceId, t.connection_id, s.message, requestId);
  if (next === 'outcome_unknown') log('warn', 'alert.outcome_unknown', { workspace_id: workspaceId, target_id: targetId, code: 'code' in s ? s.code : null });
  return next;
}

/** Lease a processing target for one poll/reconcile pass (inside the coordinator). */
export async function claimPoll(env: Env, workspaceId: string, targetId: string, owner: string): Promise<{ target: TargetRecord; fencing: number } | null> {
  const t = await loadTarget(env, workspaceId, targetId);
  if (!t || !['processing', 'outcome_unknown'].includes(t.status)) return null;
  if (t.claim_expires_at && new Date(t.claim_expires_at).getTime() > Date.now()) return null;
  const fencing = t.fencing_token + 1;
  const now = nowIso();
  try {
    await env.DB.batch([
      stmt(env, `UPDATE targets SET claim_owner = ?, claim_expires_at = ?, fencing_token = ?, version = version + 1, updated_at = ? WHERE workspace_id = ? AND id = ? AND version = ?`,
        owner, new Date(Date.now() + 5 * 60_000).toISOString(), fencing, now, workspaceId, targetId, t.version),
      guardChanged(env),
    ]);
  } catch (e) {
    if (isGuardError(e)) return null;
    throw e;
  }
  return { target: { ...t, version: t.version + 1, fencing_token: fencing }, fencing };
}

/** Poll a processing target (queue consumer). */
export async function executePoll(env: Env, t: TargetRecord, refresh: (ctx: ProviderContext) => Promise<ProviderContext>): Promise<Settlement> {
  const receiptRow = await first<{ remote_id: string | null; container_id: string | null; publish_id: string | null; url: string | null; raw_status: string | null }>(
    env, 'SELECT remote_id, container_id, publish_id, url, raw_status FROM provider_receipts WHERE workspace_id = ? AND target_id = ?', t.workspace_id, t.id);
  if (!receiptRow) return { kind: 'unknown', code: 'receipt_missing', message: 'No provider receipt to poll.' };
  const receipt: Receipt = { remoteId: receiptRow.remote_id, containerId: receiptRow.container_id, publishId: receiptRow.publish_id, url: receiptRow.url, state: parseJson(receiptRow.raw_status, {}) };
  try {
    const ctx = await refresh(await providerContext(env, t.workspace_id, t.connection_id, `${t.id}:poll`, providerFetch(env)));
    const r = await adapter(env, t.platform).pollStatus(ctx, receipt);
    if (r.kind === 'published') return { kind: 'published', receipt: r.receipt };
    if (r.kind === 'processing') return { kind: 'processing', receipt: r.receipt, pollAfterSeconds: r.pollAfterSeconds };
    return { kind: 'failed', code: r.code, message: r.message, receipt: r.receipt };
  } catch (e) {
    if (e instanceof ProviderError && (e.kind === 'transient' || e.kind === 'rate_limited')) {
      // Keep processing and poll again later; polling is read-only.
      return { kind: 'processing', receipt, pollAfterSeconds: Math.max(60, e.retryAfterSeconds ?? 60) };
    }
    if (e instanceof ProviderError && e.kind === 'reconnect_required') return { kind: 'reconnect', code: e.code, message: e.message };
    if (e instanceof ProviderError && e.kind === 'ambiguous') return { kind: 'unknown', code: e.code, message: e.message, receipt };
    return classify(e, true);
  }
}

/**
 * Cron sweeper: claims whose lease expired while submitting may have reached
 * the provider. Mark them outcome_unknown and schedule reconciliation.
 */
export async function sweepExpiredClaims(env: Env): Promise<number> {
  const now = nowIso();
  const stale = await all<TargetRecord>(env, `SELECT * FROM targets WHERE status = 'submitting' AND claim_expires_at < ? LIMIT 100`, now);
  for (const t of stale) {
    try {
      await env.DB.batch([
        stmt(env, `UPDATE targets SET status = 'outcome_unknown', last_error_code = 'claim_expired', last_error_message = 'The dispatcher stopped after submission started; the provider may have published this.', claim_owner = NULL, claim_expires_at = NULL, version = version + 1, updated_at = ?
          WHERE workspace_id = ? AND id = ? AND version = ? AND status = 'submitting'`, now, t.workspace_id, t.id, t.version),
        guardChanged(env),
        stmt(env, `INSERT INTO outbox(id, workspace_id, target_id, revision, kind, state, next_attempt_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)
          ON CONFLICT(workspace_id, target_id, revision, kind) DO UPDATE SET state = 'pending', next_attempt_at = excluded.next_attempt_at, updated_at = excluded.updated_at`,
          newId('obx'), t.workspace_id, t.id, 1, 'reconcile', 'pending', now, now, now),
        stmt(env, `UPDATE outbox SET state = 'done', updated_at = ? WHERE workspace_id = ? AND target_id = ? AND kind = 'dispatch'`, now, t.workspace_id, t.id),
        auditStmt(env, { workspaceId: t.workspace_id, actorType: 'system', requestId: `sweep:${t.id}` }, 'target.outcome_unknown', 'target', t.id, { code: 'claim_expired' }),
      ]);
      log('warn', 'alert.outcome_unknown', { workspace_id: t.workspace_id, target_id: t.id, code: 'claim_expired' });
    } catch (e) {
      if (!isGuardError(e)) throw e;
    }
  }
  return stale.length;
}

/** Reconcile an unknown/native-cancel target from its real provider receipt. */
export async function executeReconcile(env: Env, t: TargetRecord, refresh: (ctx: ProviderContext) => Promise<ProviderContext>): Promise<Settlement | { kind: 'native_canceled' } | { kind: 'still_unknown' }> {
  if (t.hold_reason === 'cancel_requested' && t.scheduling_owner === 'provider_native' && t.platform === 'youtube') {
    const receiptRow = await first<{ remote_id: string | null }>(env, 'SELECT remote_id FROM provider_receipts WHERE workspace_id = ? AND target_id = ?', t.workspace_id, t.id);
    if (receiptRow?.remote_id && new Date(t.due_at).getTime() > Date.now() + 60_000) {
      const ctx = await refresh(await providerContext(env, t.workspace_id, t.connection_id, `${t.id}:native-cancel`, providerFetch(env)));
      const yt = await import('../providers/youtube.js');
      await yt.cancelNativeSchedule(ctx, { remoteId: receiptRow.remote_id, containerId: null, publishId: null, url: null, state: {} });
      return { kind: 'native_canceled' };
    }
  }
  const receipt = await first(env, 'SELECT 1 FROM provider_receipts WHERE workspace_id = ? AND target_id = ? AND (remote_id IS NOT NULL OR container_id IS NOT NULL OR publish_id IS NOT NULL)', t.workspace_id, t.id);
  if (!receipt) return { kind: 'still_unknown' };
  const r = await executePoll(env, t, refresh);
  if (r.kind === 'processing') return { kind: 'still_unknown' };
  return r;
}

export { ensureFreshTokens };
