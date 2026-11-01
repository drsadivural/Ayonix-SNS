// Preview → confirm → durable schedule. A server-minted preview token binds
// tenant, identity, exact content hashes, targets, times, policy and
// entitlement versions for 10 minutes. Confirmation reserves quota for every
// target atomically (CHECK used+reserved<=allowance aborts the D1 batch) and
// writes targets + ledger + outbox in the same transaction.
import type { PreviewTarget, ScheduleConfirmation, SchedulePreview, Target, TargetState } from '@ayonix/contracts';
import { SAFE_CANCEL_STATES, ScheduleError, describeInstant, destinationProblems, hashCanonical, validateSchedule } from '@ayonix/domain';
import type { Env } from '../lib/env.js';
import { AppError, invalid, notFound } from '../lib/errors.js';
import { newId, nowIso } from '../lib/ids.js';
import { all, batchOrConflict, decodeCursor, encodeCursor, first, guardChanged, isConstraintError, parseJson, stmt } from '../lib/db.js';
import { signToken, verifyToken } from '../security/crypto.js';
import { auditStmt } from './audit.js';
import { loadRevision } from './campaigns.js';
import type { Actor } from './context.js';
import { authorize } from './context.js';
import { idempotencyInsert, lookupIdempotent } from './idempotency.js';
import { currentPeriod, entitlementsFrom, getSubscription, quotaSummary } from './workspace.js';

const PREVIEW_TTL_SECONDS = 600;
/** Earliest bookable time: dispatch needs a little lead time to stay honest. */
const MIN_LEAD_SECONDS = 120;
const PUBLISHABLE_CONNECTION_STATES = ['connected', 'expiring'];

export interface PreviewEntry {
  post_id: string;
  revision: number;
  scheduled_at_utc: string;
  timezone: string;
}

interface BoundTarget {
  cr: string;
  hash: string;
  post: string;
  rev: number;
  product: string;
  conn: string;
  platform: string;
  format: string;
  due: string;
  local: string;
  offset: string;
  tz: string;
  approval: 'tiktok_creator_consent' | null;
  owner: 'ayonix' | 'provider_native';
}

interface PreviewClaims {
  ws: string;
  sub: string;
  period: string;
  ent: number;
  policy: number;
  targets: BoundTarget[];
  hash: string;
}

export async function previewSchedule(env: Env, actor: Actor, entries: PreviewEntry[]): Promise<SchedulePreview> {
  authorize(actor, 'schedule');
  if (!Array.isArray(entries) || entries.length < 1 || entries.length > 100) throw invalid('Provide 1–100 schedule entries');
  const sub = await getSubscription(env, actor.workspaceId);
  const ent = entitlementsFrom(sub);
  const ws = await first<{ policy_version: number; status: string }>(env, 'SELECT policy_version, status FROM workspaces WHERE id = ?', actor.workspaceId);
  const period = await currentPeriod(env, actor.workspaceId);
  const blocking: string[] = [];
  if (!ent.can_confirm_schedules) blocking.push(ent.restriction ?? 'Scheduling is unavailable for this workspace.');
  if (ws?.status !== 'active') blocking.push('This workspace is not active.');
  if (!period) blocking.push('There is no active publication allowance for the current billing cycle.');

  const targets: PreviewTarget[] = [];
  const bound: BoundTarget[] = [];
  const now = new Date();
  const seenTargets = new Set<string>();
  for (const [i, e] of entries.entries()) {
    const problems: string[] = [];
    let utc = e.scheduled_at_utc;
    try {
      utc = validateSchedule({ utc: e.scheduled_at_utc, timezone: e.timezone }, new Date(now.getTime() + MIN_LEAD_SECONDS * 1000)).utc;
    } catch (err) {
      if (err instanceof ScheduleError && err.code === 'past_time') problems.push(`Entry ${i + 1}: choose a time at least ${MIN_LEAD_SECONDS / 60} minutes from now.`);
      else throw invalid(`Entry ${i + 1}: ${(err as Error).message}`, { [`entries.${i}.scheduled_at_utc`]: (err as Error).message });
    }
    if (period && utc >= period.ends_at) {
      problems.push(`Entry ${i + 1}: this time is after the current billing cycle ends (${period.ends_at}). Schedule it after renewal; future allowance cannot be reserved yet.`);
    }
    const post = await first<{ current_revision: number; campaign_id: string }>(env, 'SELECT current_revision, campaign_id FROM posts WHERE workspace_id = ? AND id = ?', actor.workspaceId, e.post_id);
    if (!post) throw notFound('Post');
    if (post.current_revision !== e.revision) {
      throw new AppError('version_conflict', `Post ${e.post_id} has a newer revision (${post.current_revision}). Preview the latest content.`, { current_version: post.current_revision });
    }
    const campaign = await first<{ product_id: string }>(env, 'SELECT product_id FROM campaigns WHERE workspace_id = ? AND id = ?', actor.workspaceId, post.campaign_id);
    const product = await first<{ approved_version: number | null; active: number; name: string }>(env, 'SELECT approved_version, active, name FROM products WHERE workspace_id = ? AND id = ?', actor.workspaceId, campaign!.product_id);
    if (!product?.approved_version) problems.push(`Approve the product profile "${product?.name ?? ''}" before scheduling.`);
    if (product && !product.active) problems.push(`The product "${product.name}" is paused.`);
    const local = describeInstant(utc, e.timezone);
    const rows = await loadRevision(env, actor.workspaceId, e.post_id, e.revision);
    if (!rows.length) throw invalid(`Post ${e.post_id} has no destinations`);
    for (const r of rows) {
      const destProblems = [...problems];
      const key = `${r.id}@${utc}`;
      if (seenTargets.has(key)) throw invalid('The same post revision is listed twice for the same time');
      seenTargets.add(key);
      const conn = await first<{ state: string; account_name: string; provider: string }>(env, 'SELECT state, account_name, provider FROM connections WHERE workspace_id = ? AND id = ?', actor.workspaceId, r.connection_id);
      if (!conn) throw notFound('Connection');
      if (!PUBLISHABLE_CONNECTION_STATES.includes(conn.state)) destProblems.push(`${conn.account_name || r.platform}: the account is ${conn.state.replace('_', ' ')}. Reconnect it in Connectors.`);
      const capability = await first<{ status: string; detail: string | null }>(
        env, 'SELECT status, detail FROM connection_capabilities WHERE workspace_id = ? AND connection_id = ? AND capability = ?', actor.workspaceId, r.connection_id, `publish_${r.format}`);
      if (!capability || capability.status !== 'available') {
        destProblems.push(`${conn.account_name || r.platform}: publishing ${r.format} posts is ${capability?.status === 'pending_review' ? 'pending platform review' : 'not available for this account'}${capability?.detail ? ` (${capability.detail})` : ''}.`);
      }
      const assets = [];
      for (const id of r.asset_ids) {
        const a = await first<{ mime: string; validation_state: string; duration_ms: number | null; width: number | null; height: number | null }>(env, 'SELECT mime, validation_state, duration_ms, width, height FROM assets WHERE workspace_id = ? AND id = ?', actor.workspaceId, id);
        if (!a) throw notFound('Asset');
        assets.push(a);
      }
      destProblems.push(...destinationProblems({ platform: r.platform, format: r.format, caption: r.caption, title: r.title ?? undefined, link_url: r.link_url ?? undefined, assets }));
      const approval = r.platform === 'tiktok' ? ('tiktok_creator_consent' as const) : null;
      const owner = r.platform === 'youtube' && r.options.native_schedule === true ? ('provider_native' as const) : ('ayonix' as const);
      targets.push({
        post_id: e.post_id,
        revision: e.revision,
        platform: r.platform,
        connection_id: r.connection_id,
        account_name: conn.account_name,
        format: r.format,
        caption_preview: r.caption.slice(0, 280),
        asset_ids: r.asset_ids,
        scheduled_at_utc: utc,
        local_time: local.local,
        utc_offset: local.offset,
        timezone: e.timezone,
        quota_cost: 1,
        approval_required: approval,
        scheduling_owner: owner,
        problems: [...new Set(destProblems)],
      });
      bound.push({ cr: r.id, hash: r.content_hash, post: e.post_id, rev: e.revision, product: campaign!.product_id, conn: r.connection_id, platform: r.platform, format: r.format, due: utc, local: local.local, offset: local.offset, tz: e.timezone, approval, owner });
    }
  }
  const quota = await quotaSummary(env, actor.workspaceId);
  const cost = targets.length;
  if (period && cost > quota.available) blocking.push(`This needs ${cost} publication(s) but only ${quota.available} remain this cycle.`);
  const targetProblems = targets.flatMap((t) => t.problems);
  const approvalRequirements = targets.some((t) => t.approval_required)
    ? ['TikTok requires the creator to choose privacy, interaction and disclosure settings on the hosted approval page before each post can be dispatched.']
    : [];
  if (blocking.length || targetProblems.length) {
    return { preview_token: null, expires_at: null, quota_cost: cost, quota, targets, approval_requirements: approvalRequirements, blocking_problems: [...new Set([...blocking, ...targetProblems])] };
  }
  const hash = await hashCanonical(bound);
  const claims: PreviewClaims = { ws: actor.workspaceId, sub: actor.identityId, period: period!.id, ent: sub!.entitlement_version, policy: ws!.policy_version, targets: bound, hash };
  const { token, expires_at } = await signToken(env, 'schedule-preview', claims as unknown as Record<string, unknown>, PREVIEW_TTL_SECONDS);
  return { preview_token: token, expires_at, quota_cost: cost, quota, targets, approval_requirements: approvalRequirements, blocking_problems: [] };
}

/**
 * Confirm a reviewed preview. Must run inside the workspace coordinator so
 * schedule changes are serialized; D1 constraints are the final guard.
 */
export async function confirmSchedule(env: Env, actor: Actor, input: { preview_token: string; confirmed: boolean; idempotency_key: string }): Promise<ScheduleConfirmation> {
  authorize(actor, 'schedule');
  if (input.confirmed !== true) throw invalid('Explicit confirmation is required', { confirmed: 'Must be true' });
  const idem = await lookupIdempotent<ScheduleConfirmation>(env, actor.workspaceId, 'confirm_schedule', input.idempotency_key, { preview_token: input.preview_token });
  if (idem.stored) return idem.stored;

  const claims = await verifyToken<PreviewClaims & { exp: number } & Record<string, unknown>>(env, 'schedule-preview', input.preview_token);
  if (claims.ws !== actor.workspaceId) throw notFound('Preview');
  if (claims.sub !== actor.identityId) throw new AppError('forbidden', 'Only the person who reviewed this preview can confirm it.');
  if ((await hashCanonical(claims.targets)) !== claims.hash) throw new AppError('invalid_request', 'Preview integrity check failed');

  const sub = await getSubscription(env, actor.workspaceId);
  const ent = entitlementsFrom(sub);
  if (!ent.can_confirm_schedules) throw new AppError('entitlement_required', ent.restriction ?? 'Scheduling is unavailable.');
  if (sub!.entitlement_version !== claims.ent) throw new AppError('conflict', 'The plan changed after this preview. Preview again.');
  const ws = await first<{ policy_version: number }>(env, 'SELECT policy_version FROM workspaces WHERE id = ?', actor.workspaceId);
  if (ws?.policy_version !== claims.policy) throw new AppError('conflict', 'Workspace policy changed after this preview. Preview again.');
  const period = await currentPeriod(env, actor.workspaceId);
  if (!period || period.id !== claims.period) throw new AppError('conflict', 'The billing cycle changed after this preview. Preview again.');

  // Re-verify every bound revision is still current and unchanged.
  for (const t of claims.targets) {
    const row = await first<{ content_hash: string; current_revision: number }>(
      env,
      `SELECT cr.content_hash, p.current_revision FROM content_revisions cr JOIN posts p ON p.workspace_id = cr.workspace_id AND p.id = cr.post_id
       WHERE cr.workspace_id = ? AND cr.id = ?`, actor.workspaceId, t.cr);
    if (!row || row.content_hash !== t.hash || row.current_revision !== t.rev) throw new AppError('version_conflict', 'Content changed after this preview. Preview again.');
    const conn = await first<{ state: string }>(env, 'SELECT state FROM connections WHERE workspace_id = ? AND id = ?', actor.workspaceId, t.conn);
    if (!conn || !PUBLISHABLE_CONNECTION_STATES.includes(conn.state)) throw new AppError('conflict', 'A destination account needs reconnecting. Preview again after reconnecting.');
    if (t.due <= new Date(Date.now() + 30_000).toISOString()) throw new AppError('conflict', 'A scheduled time is now in the past. Preview again.');
  }

  const scheduleId = newId('sch');
  const now = nowIso();
  const n = claims.targets.length;
  const opKey = `confirm:${input.idempotency_key}`;
  const states: Record<string, TargetState> = {};
  const statements: D1PreparedStatement[] = [
    // Atomic reservation: the CHECK(used+reserved<=allowance) aborts the batch on overspend.
    stmt(env, 'UPDATE quota_periods SET reserved = reserved + ?, version = version + 1 WHERE workspace_id = ? AND id = ?', n, actor.workspaceId, period.id),
    guardChanged(env),
    stmt(env, 'INSERT INTO schedules(id, workspace_id, version, status, preview_hash, created_by, created_via, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)',
      scheduleId, actor.workspaceId, 1, 'active', claims.hash, actor.identityId, actor.via === 'mcp' ? 'mcp' : 'web', now, now),
  ];
  for (const t of claims.targets) {
    const targetId = newId('tgt');
    const status: TargetState = t.approval ? 'awaiting_approval' : 'scheduled';
    states[targetId] = status;
    statements.push(
      stmt(env, `INSERT INTO targets(id, workspace_id, schedule_id, post_id, revision, content_revision_id, product_id, connection_id, period_id, platform, format, status, due_at, local_time, timezone, utc_offset, scheduling_owner, approval_required, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        targetId, actor.workspaceId, scheduleId, t.post, t.rev, t.cr, t.product, t.conn, period.id, t.platform, t.format, status, t.due, t.local, t.tz, t.offset, t.owner, t.approval, now, now),
      stmt(env, 'INSERT INTO quota_ledger(id, workspace_id, target_id, period_id, state, operation_key, created_at) VALUES (?,?,?,?,?,?,?)', newId('qlg'), actor.workspaceId, targetId, period.id, 'reserved', opKey, now),
    );
    if (status === 'scheduled') {
      // Native YouTube scheduling uploads ahead of time with publishAt; Ayonix dispatches at due time otherwise.
      const nextAt = t.owner === 'provider_native' ? now : t.due;
      statements.push(stmt(env, 'INSERT INTO outbox(id, workspace_id, target_id, revision, kind, state, next_attempt_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)', newId('obx'), actor.workspaceId, targetId, 1, 'dispatch', 'pending', nextAt, now, now));
    }
  }
  const result: ScheduleConfirmation = { schedule_id: scheduleId, version: 1, target_ids: Object.keys(states), states };
  const previewMarker = await hashCanonical({ preview: claims.hash, exp: claims.exp });
  statements.push(
    // A preview can be confirmed once, whatever idempotency key a retry uses.
    idempotencyInsert(env, actor.workspaceId, 'preview_consumed', previewMarker, previewMarker, { schedule_id: scheduleId }),
    idempotencyInsert(env, actor.workspaceId, 'confirm_schedule', input.idempotency_key, idem.hash, result),
    auditStmt(env, actor, 'schedule.confirmed', 'schedule', scheduleId, { targets: n, via: actor.via }, 1),
  );
  try {
    await env.DB.batch(statements);
  } catch (e) {
    if (isConstraintError(e, 'CHECK')) {
      throw new AppError('quota_exceeded', 'Not enough publications remain this cycle for every destination. Nothing was scheduled.');
    }
    if (isConstraintError(e, 'UNIQUE')) {
      const again = await lookupIdempotent<ScheduleConfirmation>(env, actor.workspaceId, 'confirm_schedule', input.idempotency_key, { preview_token: input.preview_token });
      if (again.stored) return again.stored;
      throw new AppError('conflict', 'This preview was already confirmed. Use list_schedule to see the existing schedule.');
    }
    throw e;
  }
  return result;
}

// ---------------------------------------------------------------------------

interface TargetRow {
  id: string;
  schedule_id: string;
  schedule_version: number;
  version: number;
  post_id: string;
  revision: number;
  product_id: string;
  platform: Target['platform'];
  connection_id: string;
  account_name: string | null;
  format: Target['format'];
  caption: string | null;
  status: TargetState;
  due_at: string;
  local_time: string;
  timezone: string;
  approval_required: Target['approval_required'];
  last_error_code: string | null;
  last_error_message: string | null;
  hold_reason: string | null;
  attempt_count: number;
  updated_at: string;
  r_remote_id: string | null;
  r_container_id: string | null;
  r_url: string | null;
  r_verified_at: string | null;
  r_status: string | null;
}

const TARGET_SELECT = `SELECT t.id, t.schedule_id, s.version AS schedule_version, t.version, t.post_id, t.revision, t.product_id, t.platform, t.connection_id, c.account_name,
  t.format, cr.caption, t.status, t.due_at, t.local_time, t.timezone, t.approval_required, t.last_error_code, t.last_error_message, t.hold_reason, t.attempt_count, t.updated_at,
  r.remote_id AS r_remote_id, r.container_id AS r_container_id, r.url AS r_url, r.verified_at AS r_verified_at, r.status AS r_status
  FROM targets t
  JOIN schedules s ON s.workspace_id = t.workspace_id AND s.id = t.schedule_id
  JOIN content_revisions cr ON cr.workspace_id = t.workspace_id AND cr.id = t.content_revision_id
  LEFT JOIN connections c ON c.workspace_id = t.workspace_id AND c.id = t.connection_id
  LEFT JOIN provider_receipts r ON r.workspace_id = t.workspace_id AND r.target_id = t.id`;

export function nextAction(status: TargetState, platform: string, holdReason: string | null): string | null {
  switch (status) {
    case 'awaiting_approval':
      return platform === 'tiktok' ? 'Open the TikTok approval page and choose the creator settings.' : 'Approval required.';
    case 'reconnect_required':
      return 'Reconnect the account in Connectors, then reschedule.';
    case 'outcome_unknown':
      return 'The provider may have published this. Check the account, then mark the result in post details.';
    case 'retry_wait':
      return 'Ayonix will retry automatically.';
    case 'failed':
      return holdReason === 'missed_window' ? 'The publishing window was missed. Schedule it again.' : 'Fix the reported problem and schedule again.';
    case 'scheduled':
      return holdReason === 'payment_past_due' ? 'Held until payment recovers.' : null;
    case 'processing':
      return 'The provider is processing the upload. Processing is not published.';
    default:
      return null;
  }
}

function toTarget(r: TargetRow): Target {
  return {
    id: r.id,
    schedule_id: r.schedule_id,
    schedule_version: r.schedule_version,
    version: r.version,
    post_id: r.post_id,
    revision: r.revision,
    product_id: r.product_id,
    platform: r.platform,
    connection_id: r.connection_id,
    account_name: r.account_name ?? '',
    format: r.format,
    caption_preview: (r.caption ?? '').slice(0, 280),
    status: r.status,
    due_at: r.due_at,
    local_time: r.local_time,
    timezone: r.timezone,
    approval_required: r.status === 'awaiting_approval' ? r.approval_required : null,
    next_action: nextAction(r.status, r.platform, r.hold_reason),
    error: r.last_error_code ? { code: r.last_error_code, message: r.last_error_message ?? '' } : null,
    receipt: r.r_status ? { remote_id: r.r_remote_id, container_id: r.r_container_id, url: r.r_url, verified_at: r.r_verified_at, status: r.r_status } : null,
    attempts: r.attempt_count,
    updated_at: r.updated_at,
  };
}

export async function listSchedule(
  env: Env,
  actor: Actor,
  q: { cursor?: string; product_id?: string; status?: string; platform?: string; from_utc?: string; to_utc?: string; limit?: number },
): Promise<{ items: Target[]; next_cursor: string | null }> {
  authorize(actor, 'read');
  const limit = Math.min(Math.max(q.limit ?? 50, 1), 200);
  const where = ['t.workspace_id = ?'];
  const binds: unknown[] = [actor.workspaceId];
  if (q.product_id) {
    where.push('t.product_id = ?');
    binds.push(q.product_id);
  }
  if (q.status) {
    const statuses = q.status.split(',').filter(Boolean);
    where.push(`t.status IN (${statuses.map(() => '?').join(',')})`);
    binds.push(...statuses);
  }
  if (q.platform) {
    where.push('t.platform = ?');
    binds.push(q.platform);
  }
  if (q.from_utc) {
    where.push('t.due_at >= ?');
    binds.push(q.from_utc);
  }
  if (q.to_utc) {
    where.push('t.due_at < ?');
    binds.push(q.to_utc);
  }
  const c = decodeCursor(q.cursor);
  if (c) {
    where.push('(t.due_at, t.id) > (?, ?)');
    binds.push(c[0], c[1]);
  }
  const rows = await all<TargetRow>(env, `${TARGET_SELECT} WHERE ${where.join(' AND ')} ORDER BY t.due_at, t.id LIMIT ?`, ...binds, limit + 1);
  const page = rows.slice(0, limit);
  return { items: page.map(toTarget), next_cursor: rows.length > limit ? encodeCursor(page.at(-1)!.due_at, page.at(-1)!.id) : null };
}

export async function getTarget(env: Env, actor: Actor, targetId: string): Promise<Target> {
  authorize(actor, 'read');
  const row = await first<TargetRow>(env, `${TARGET_SELECT} WHERE t.workspace_id = ? AND t.id = ?`, actor.workspaceId, targetId);
  if (!row) throw notFound('Target');
  return toTarget(row);
}

export async function getPostStatus(env: Env, actor: Actor, postId: string) {
  authorize(actor, 'read');
  const post = await first(env, 'SELECT id FROM posts WHERE workspace_id = ? AND id = ?', actor.workspaceId, postId);
  if (!post) throw notFound('Post');
  const rows = await all<TargetRow>(env, `${TARGET_SELECT} WHERE t.workspace_id = ? AND t.post_id = ? ORDER BY t.due_at, t.id`, actor.workspaceId, postId);
  return { post_id: postId, targets: rows.map(toTarget) };
}

export async function targetEvents(env: Env, actor: Actor, targetId: string) {
  authorize(actor, 'read');
  await getTarget(env, actor, targetId);
  const attempts = await all(env, 'SELECT attempt_no, phase, started_at, finished_at, outcome, error_code, error_message, retry_after_seconds, correlation_id FROM attempts WHERE workspace_id = ? AND target_id = ? ORDER BY started_at', actor.workspaceId, targetId);
  const events = await all<{ action: string; created_at: string; detail_json: string }>(env, `SELECT action, created_at, detail_json FROM audit_events WHERE workspace_id = ? AND object_type = 'target' AND object_id = ? ORDER BY created_at`, actor.workspaceId, targetId);
  return { attempts, events: events.map((e) => ({ action: e.action, created_at: e.created_at, detail: parseJson(e.detail_json, {}) })) };
}

// ---------------------------------------------------------------------------
// Cancellation and rescheduling (coordinator-serialized).

export type CancelOutcome = 'canceled' | 'already_published' | 'already_terminal' | 'submitted_reconciling' | 'native_cancel_requested';

export async function cancelSchedule(env: Env, actor: Actor, input: { schedule_id: string; expected_version: number; idempotency_key: string }) {
  authorize(actor, 'cancel');
  const idem = await lookupIdempotent<unknown>(env, actor.workspaceId, 'cancel_schedule', input.idempotency_key, { schedule_id: input.schedule_id, expected_version: input.expected_version });
  if (idem.stored) return idem.stored as { schedule_id: string; version: number; outcomes: Record<string, CancelOutcome> };
  const sched = await first<{ version: number; status: string }>(env, 'SELECT version, status FROM schedules WHERE workspace_id = ? AND id = ?', actor.workspaceId, input.schedule_id);
  if (!sched) throw notFound('Schedule');
  if (sched.version !== input.expected_version) throw new AppError('version_conflict', 'The schedule changed. Reload it before cancelling.', { current_version: sched.version });
  const targets = await all<{ id: string; status: TargetState; version: number; period_id: string; scheduling_owner: string; platform: string }>(
    env, 'SELECT id, status, version, period_id, scheduling_owner, platform FROM targets WHERE workspace_id = ? AND schedule_id = ?', actor.workspaceId, input.schedule_id);
  const now = nowIso();
  const outcomes: Record<string, CancelOutcome> = {};
  const statements: D1PreparedStatement[] = [
    stmt(env, 'UPDATE schedules SET version = version + 1, updated_at = ? WHERE workspace_id = ? AND id = ? AND version = ?', now, actor.workspaceId, input.schedule_id, input.expected_version),
    guardChanged(env),
  ];
  for (const t of targets) {
    if (t.status === 'published') {
      outcomes[t.id] = 'already_published';
    } else if (t.status === 'failed' || t.status === 'canceled') {
      outcomes[t.id] = 'already_terminal';
    } else if (SAFE_CANCEL_STATES.includes(t.status)) {
      outcomes[t.id] = 'canceled';
      statements.push(...releaseAndCancelStatements(env, actor.workspaceId, t.id, t.version, t.period_id, 'canceled', null, null));
      statements.push(auditStmt(env, actor, 'target.canceled', 'target', t.id, { from: t.status }));
    } else if (t.scheduling_owner === 'provider_native' && t.status === 'processing') {
      // Uploaded with a native publishAt: ask the reconciler to remove it before it goes public.
      outcomes[t.id] = 'native_cancel_requested';
      statements.push(
        stmt(env, `UPDATE targets SET hold_reason = 'cancel_requested', version = version + 1, updated_at = ? WHERE workspace_id = ? AND id = ? AND version = ?`, now, actor.workspaceId, t.id, t.version),
        guardChanged(env),
        stmt(env, `INSERT INTO outbox(id, workspace_id, target_id, revision, kind, state, next_attempt_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)
          ON CONFLICT(workspace_id, target_id, revision, kind) DO UPDATE SET state = 'pending', next_attempt_at = excluded.next_attempt_at, updated_at = excluded.updated_at`,
          newId('obx'), actor.workspaceId, t.id, 1, 'reconcile', 'pending', now, now, now),
        auditStmt(env, actor, 'target.native_cancel_requested', 'target', t.id),
      );
    } else {
      // submitting / processing / outcome_unknown: the provider may already hold the content.
      outcomes[t.id] = 'submitted_reconciling';
      statements.push(auditStmt(env, actor, 'target.cancel_after_submission', 'target', t.id, { status: t.status }));
    }
  }
  const allTerminal = Object.values(outcomes).every((o) => o !== 'submitted_reconciling' && o !== 'native_cancel_requested');
  if (allTerminal) statements.push(stmt(env, `UPDATE schedules SET status = 'canceled' WHERE workspace_id = ? AND id = ?`, actor.workspaceId, input.schedule_id));
  const result = { schedule_id: input.schedule_id, version: input.expected_version + 1, outcomes };
  statements.push(idempotencyInsert(env, actor.workspaceId, 'cancel_schedule', input.idempotency_key, idem.hash, result));
  statements.push(auditStmt(env, actor, 'schedule.cancel_requested', 'schedule', input.schedule_id, { outcomes }, input.expected_version + 1));
  await batchOrConflict(env, statements, () => new AppError('version_conflict', 'The schedule changed while cancelling. Reload and try again.'));
  return result;
}

/** Statements to move a target to a terminal non-published state and release its reservation exactly once. */
export function releaseAndCancelStatements(env: Env, workspaceId: string, targetId: string, expectedVersion: number, periodId: string, status: 'canceled' | 'failed' | 'draft', errorCode: string | null, errorMessage: string | null) {
  const now = nowIso();
  return [
    stmt(env, `UPDATE targets SET status = ?, version = version + 1, last_error_code = COALESCE(?, last_error_code), last_error_message = COALESCE(?, last_error_message), claim_owner = NULL, claim_expires_at = NULL, updated_at = ?
      WHERE workspace_id = ? AND id = ? AND version = ?`, status, errorCode, errorMessage, now, workspaceId, targetId, expectedVersion),
    guardChanged(env),
    stmt(env, `UPDATE quota_ledger SET state = 'released', settled_at = ? WHERE workspace_id = ? AND target_id = ? AND state = 'reserved'`, now, workspaceId, targetId),
    // Decrement only when the ledger row actually moved (changes() of the previous statement).
    stmt(env, `UPDATE quota_periods SET reserved = reserved - 1, version = version + 1 WHERE workspace_id = ? AND id = ? AND changes() = 1`, workspaceId, periodId),
    stmt(env, `UPDATE outbox SET state = 'done', updated_at = ? WHERE workspace_id = ? AND target_id = ? AND state IN ('pending','leased','enqueued')`, now, workspaceId, targetId),
  ];
}

/** Reschedule a not-yet-submitted target. Invalidates TikTok approval. */
export async function rescheduleTarget(env: Env, actor: Actor, targetId: string, input: { expected_version: number; scheduled_at_utc: string; timezone: string }) {
  authorize(actor, 'schedule');
  const t = await first<{ status: TargetState; version: number; period_id: string; schedule_id: string; approval_required: string | null; scheduling_owner: string }>(
    env, 'SELECT status, version, period_id, schedule_id, approval_required, scheduling_owner FROM targets WHERE workspace_id = ? AND id = ?', actor.workspaceId, targetId);
  if (!t) throw notFound('Target');
  if (t.version !== input.expected_version) throw new AppError('version_conflict', 'The target changed. Reload before rescheduling.', { current_version: t.version });
  if (!['scheduled', 'queued', 'awaiting_approval', 'retry_wait', 'reconnect_required'].includes(t.status)) {
    throw new AppError('conflict', `A ${t.status.replace('_', ' ')} target cannot be rescheduled.`);
  }
  const { utc } = validateSchedule({ utc: input.scheduled_at_utc, timezone: input.timezone }, new Date(Date.now() + MIN_LEAD_SECONDS * 1000));
  const period = await first<{ ends_at: string }>(env, 'SELECT ends_at FROM quota_periods WHERE workspace_id = ? AND id = ?', actor.workspaceId, t.period_id);
  if (!period || utc >= period.ends_at) throw new AppError('unprocessable', 'The new time is outside the billing cycle that holds this reservation. Cancel and schedule again after renewal.');
  const ent = entitlementsFrom(await getSubscription(env, actor.workspaceId));
  if (!ent.can_confirm_schedules) throw new AppError('entitlement_required', ent.restriction ?? 'Scheduling is unavailable.');
  const local = describeInstant(utc, input.timezone);
  const now = nowIso();
  const needsApproval = t.approval_required === 'tiktok_creator_consent';
  const newStatus: TargetState = needsApproval ? 'awaiting_approval' : 'scheduled';
  await batchOrConflict(env, [
    stmt(env, `UPDATE targets SET status = ?, due_at = ?, local_time = ?, timezone = ?, utc_offset = ?, approval_id = NULL, hold_reason = NULL, attempt_count = 0, next_attempt_at = NULL, version = version + 1, updated_at = ?
      WHERE workspace_id = ? AND id = ? AND version = ?`, newStatus, utc, local.local, input.timezone, local.offset, now, actor.workspaceId, targetId, input.expected_version),
    guardChanged(env),
    stmt(env, `UPDATE outbox SET state = 'done', updated_at = ? WHERE workspace_id = ? AND target_id = ? AND state IN ('pending','leased','enqueued')`, now, actor.workspaceId, targetId),
    ...(needsApproval
      ? []
      : [stmt(env, `INSERT INTO outbox(id, workspace_id, target_id, revision, kind, state, next_attempt_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)
          ON CONFLICT(workspace_id, target_id, revision, kind) DO UPDATE SET state = 'pending', next_attempt_at = excluded.next_attempt_at, updated_at = excluded.updated_at`,
          newId('obx'), actor.workspaceId, targetId, 1, 'dispatch', 'pending', t.scheduling_owner === 'provider_native' ? now : utc, now, now)]),
    stmt(env, 'UPDATE schedules SET version = version + 1, updated_at = ? WHERE workspace_id = ? AND id = ?', now, actor.workspaceId, t.schedule_id),
    auditStmt(env, actor, 'target.rescheduled', 'target', targetId, { due_at: utc, approval_reset: needsApproval }),
  ], () => new AppError('version_conflict', 'The target changed while rescheduling.'));
  return getTarget(env, actor, targetId);
}

/**
 * Owner/admin resolution of an outcome_unknown target after checking the
 * account. 'not_published' releases the reservation; 'published' needs the
 * provider URL and is recorded as manually verified.
 */
export async function resolveUnknown(env: Env, actor: Actor, targetId: string, input: { expected_version: number; outcome: 'not_published' | 'published'; provider_url?: string; provider_post_id?: string }) {
  authorize(actor, 'manage_connections');
  const t = await first<{ status: TargetState; version: number; period_id: string; platform: string }>(env, 'SELECT status, version, period_id, platform FROM targets WHERE workspace_id = ? AND id = ?', actor.workspaceId, targetId);
  if (!t) throw notFound('Target');
  if (t.status !== 'outcome_unknown') throw new AppError('conflict', 'Only targets with an unknown outcome can be resolved manually.');
  if (t.version !== input.expected_version) throw new AppError('version_conflict', 'The target changed.', { current_version: t.version });
  if (input.outcome === 'not_published') {
    await batchOrConflict(env, [
      ...releaseAndCancelStatements(env, actor.workspaceId, targetId, t.version, t.period_id, 'failed', 'resolved_not_published', 'Marked as not published after manual verification.'),
      auditStmt(env, actor, 'target.resolved_not_published', 'target', targetId),
    ], () => new AppError('version_conflict', 'The target changed.'));
  } else {
    const url = String(input.provider_url ?? '');
    const remote = String(input.provider_post_id ?? '').trim();
    if (!/^https:\/\//.test(url) || !remote) throw invalid('Provide the provider post ID and its https URL', { provider_url: 'Required' });
    const now = nowIso();
    await batchOrConflict(env, [
      stmt(env, `UPDATE targets SET status = 'published', provider_post_id = ?, provider_url = ?, version = version + 1, updated_at = ? WHERE workspace_id = ? AND id = ? AND version = ?`, remote, url, now, actor.workspaceId, targetId, t.version),
      guardChanged(env),
      stmt(env, `INSERT INTO provider_receipts(id, workspace_id, target_id, provider, remote_id, url, status, raw_status, verified_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(workspace_id, target_id) DO UPDATE SET remote_id = excluded.remote_id, url = excluded.url, status = 'published', raw_status = 'manual_verification', verified_at = excluded.verified_at, updated_at = excluded.updated_at`,
        newId('rcp'), actor.workspaceId, targetId, t.platform, remote, url, 'published', 'manual_verification', now, now, now),
      stmt(env, `UPDATE quota_ledger SET state = 'committed', settled_at = ? WHERE workspace_id = ? AND target_id = ? AND state = 'reserved'`, now, actor.workspaceId, targetId),
      stmt(env, `UPDATE quota_periods SET reserved = reserved - 1, used = used + 1, version = version + 1 WHERE workspace_id = ? AND id = ? AND changes() = 1`, actor.workspaceId, t.period_id),
      stmt(env, `UPDATE outbox SET state = 'done', updated_at = ? WHERE workspace_id = ? AND target_id = ? AND state <> 'done'`, now, actor.workspaceId, targetId),
      auditStmt(env, actor, 'target.resolved_published', 'target', targetId, { manual: true }),
    ], () => new AppError('version_conflict', 'The target changed.'));
  }
  return getTarget(env, actor, targetId);
}
