// TikTok per-post creator approval on a real hosted page. Creator info is
// fetched live, privacy has no default, and the approval binds the exact
// content hash + chosen settings + creator snapshot. A ChatGPT instruction
// alone can never satisfy it (the MCP surface has no approval tool).
import type { TikTokApprovalContext } from '@ayonix/contracts';
import { hashCanonical } from '@ayonix/domain';
import type { Env } from '../lib/env.js';
import { AppError, invalid, notFound } from '../lib/errors.js';
import { newId, nowIso } from '../lib/ids.js';
import { batchOrConflict, first, guardChanged, stmt } from '../lib/db.js';
import { signToken, verifyToken } from '../security/crypto.js';
import { queryCreatorInfo } from '../providers/tiktok.js';
import type { TikTokCreatorInfo } from '../providers/types.js';
import { ProviderError } from '../providers/types.js';
import { auditStmt } from './audit.js';
import { loadRevision } from './campaigns.js';
import type { Actor } from './context.js';
import { authorize } from './context.js';
import { ensureFreshTokens, markReconnectRequired, providerContext } from './connections.js';
import { releaseAndCancelStatements } from './schedules.js';

interface ApprovalTarget {
  id: string;
  status: string;
  version: number;
  platform: string;
  connection_id: string;
  post_id: string;
  revision: number;
  content_revision_id: string;
  period_id: string;
  due_at: string;
}

async function loadTarget(env: Env, actor: Actor, targetId: string): Promise<ApprovalTarget> {
  const t = await first<ApprovalTarget>(env, 'SELECT id, status, version, platform, connection_id, post_id, revision, content_revision_id, period_id, due_at FROM targets WHERE workspace_id = ? AND id = ?', actor.workspaceId, targetId);
  if (!t) throw notFound('Target');
  if (t.platform !== 'tiktok') throw new AppError('invalid_request', 'Only TikTok targets use creator approval');
  if (t.status !== 'awaiting_approval') throw new AppError('conflict', `This post is ${t.status.replace('_', ' ')}, not awaiting approval.`);
  return t;
}

async function fetchCreator(env: Env, actor: Actor, connectionId: string): Promise<TikTokCreatorInfo> {
  try {
    const { providerFetch } = await import('../jobs/dispatch.js');
    const ctx = await ensureFreshTokens(env, await providerContext(env, actor.workspaceId, connectionId, actor.requestId, providerFetch(env)), actor.requestId);
    return await queryCreatorInfo(ctx);
  } catch (e) {
    if (e instanceof ProviderError && e.kind === 'reconnect_required') {
      await markReconnectRequired(env, actor.workspaceId, connectionId, e.message, actor.requestId);
      throw new AppError('conflict', 'The TikTok account needs reconnecting before approval.');
    }
    if (e instanceof ProviderError) throw new AppError(e.kind === 'rate_limited' ? 'rate_limited' : 'upstream_error', `TikTok creator settings could not be loaded: ${e.message}`, { retryable: true, ...(e.retryAfterSeconds ? { retry_after_seconds: e.retryAfterSeconds } : {}) });
    throw e;
  }
}

export async function approvalContext(env: Env, actor: Actor, targetId: string): Promise<TikTokApprovalContext> {
  authorize(actor, 'schedule');
  if (actor.via !== 'web') throw new AppError('forbidden', 'TikTok approval happens on the hosted Ayonix page');
  const t = await loadTarget(env, actor, targetId);
  const rows = await loadRevision(env, actor.workspaceId, t.post_id, t.revision);
  const cr = rows.find((r) => r.id === t.content_revision_id);
  if (!cr) throw notFound('Content');
  const creator = await fetchCreator(env, actor, t.connection_id);
  const fetchedAt = nowIso();
  const { token } = await signToken(env, 'tiktok-approval', {
    ws: actor.workspaceId,
    sub: actor.identityId,
    target: t.id,
    version: t.version,
    content_hash: cr.content_hash,
    creator_hash: await hashCanonical(creator),
    creator,
    fetched_at: fetchedAt,
  }, 15 * 60);
  return {
    target_id: t.id,
    approval_token: token,
    creator: {
      nickname: creator.creator_nickname,
      username: creator.creator_username,
      avatar_url: creator.creator_avatar_url,
      privacy_level_options: creator.privacy_level_options,
      comment_disabled: creator.comment_disabled,
      duet_disabled: creator.duet_disabled,
      stitch_disabled: creator.stitch_disabled,
      max_video_post_duration_sec: creator.max_video_post_duration_sec,
    },
    content: { caption: cr.caption, title: cr.title, asset_ids: cr.asset_ids, format: cr.format },
    fetched_at: fetchedAt,
  };
}

export interface TikTokApprovalInput {
  approval_token: string;
  privacy_level: string;
  allow_comment: boolean;
  allow_duet: boolean;
  allow_stitch: boolean;
  /** Commercial content disclosure. */
  brand_organic_toggle: boolean;
  brand_content_toggle: boolean;
  title?: string;
  consent: boolean;
}

export async function submitApproval(env: Env, actor: Actor, targetId: string, input: TikTokApprovalInput) {
  authorize(actor, 'schedule');
  if (actor.via !== 'web') throw new AppError('forbidden', 'TikTok approval happens on the hosted Ayonix page');
  const claims = await verifyToken<{ ws: string; sub: string; target: string; version: number; content_hash: string; creator_hash: string; creator: TikTokCreatorInfo }>(env, 'tiktok-approval', input.approval_token);
  if (claims.ws !== actor.workspaceId || claims.target !== targetId) throw notFound('Approval');
  if (claims.sub !== actor.identityId) throw new AppError('forbidden', 'Open the approval page yourself to approve.');
  const t = await loadTarget(env, actor, targetId);
  if (t.version !== claims.version) throw new AppError('version_conflict', 'This post changed after the approval page loaded. Reload it.', { current_version: t.version });
  const rows = await loadRevision(env, actor.workspaceId, t.post_id, t.revision);
  const cr = rows.find((r) => r.id === t.content_revision_id);
  if (!cr || cr.content_hash !== claims.content_hash) throw new AppError('version_conflict', 'The content changed after the approval page loaded. Reload it.');
  const errors: Record<string, string> = {};
  if (input.consent !== true) errors.consent = 'Consent to TikTok publishing is required';
  if (!input.privacy_level || !claims.creator.privacy_level_options.includes(input.privacy_level)) errors.privacy_level = 'Choose one of the privacy options offered for this creator';
  for (const [k, disabled] of [['allow_comment', claims.creator.comment_disabled], ['allow_duet', claims.creator.duet_disabled], ['allow_stitch', claims.creator.stitch_disabled]] as const) {
    if (typeof input[k] !== 'boolean') errors[k] = 'Choose on or off';
    else if (input[k] && disabled) errors[k] = 'This interaction is turned off in the creator’s TikTok settings';
  }
  if (cr.format === 'photo' && (input.allow_duet || input.allow_stitch)) errors.allow_duet = 'Duet and Stitch are not available for photo posts';
  if (typeof input.brand_organic_toggle !== 'boolean' || typeof input.brand_content_toggle !== 'boolean') errors.disclosure = 'Choose the commercial content disclosure';
  if (input.brand_content_toggle && input.privacy_level === 'SELF_ONLY') errors.privacy_level = 'Branded content cannot be private (SELF_ONLY)';
  if (input.title !== undefined && (typeof input.title !== 'string' || input.title.length > 2200)) errors.title = 'Title up to 2,200 characters';
  if (Object.keys(errors).length) throw invalid('Complete the required TikTok settings', errors);

  // Revalidate against freshly fetched creator constraints; stale approvals are rejected.
  const fresh = await fetchCreator(env, actor, t.connection_id);
  if ((await hashCanonical(fresh)) !== claims.creator_hash) {
    throw new AppError('conflict', 'The creator’s TikTok settings changed while you were reviewing. Reload the page and choose again.');
  }
  const settings = {
    privacy_level: input.privacy_level,
    disable_comment: !input.allow_comment,
    disable_duet: !input.allow_duet,
    disable_stitch: !input.allow_stitch,
    brand_organic_toggle: input.brand_organic_toggle,
    brand_content_toggle: input.brand_content_toggle,
    ...(input.title !== undefined ? { title: input.title } : {}),
  };
  const approvalId = newId('apr');
  const now = nowIso();
  await batchOrConflict(env, [
    stmt(env, `INSERT INTO approvals(id, workspace_id, target_id, kind, content_hash, settings_json, settings_hash, creator_snapshot_json, decision, decided_by, decided_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      approvalId, actor.workspaceId, targetId, 'tiktok_creator_consent', cr.content_hash, JSON.stringify(settings), await hashCanonical(settings), JSON.stringify(fresh), 'approved', actor.identityId, now),
    stmt(env, `UPDATE targets SET status = 'scheduled', approval_id = ?, version = version + 1, updated_at = ? WHERE workspace_id = ? AND id = ? AND version = ? AND status = 'awaiting_approval'`, approvalId, now, actor.workspaceId, targetId, t.version),
    guardChanged(env),
    stmt(env, `INSERT INTO outbox(id, workspace_id, target_id, revision, kind, state, next_attempt_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)
      ON CONFLICT(workspace_id, target_id, revision, kind) DO UPDATE SET state = 'pending', next_attempt_at = excluded.next_attempt_at, updated_at = excluded.updated_at`,
      newId('obx'), actor.workspaceId, targetId, 1, 'dispatch', 'pending', t.due_at, now, now),
    auditStmt(env, actor, 'target.tiktok_approved', 'target', targetId, { privacy_level: input.privacy_level, branded: input.brand_content_toggle }),
  ], () => new AppError('version_conflict', 'This post changed while approving. Reload the page.'));
  return { target_id: targetId, status: 'scheduled' as const, approval_id: approvalId };
}

/** "Return to draft": releases the reservation; the content must be previewed again to schedule. */
export async function returnToDraft(env: Env, actor: Actor, targetId: string) {
  authorize(actor, 'schedule');
  const t = await loadTarget(env, actor, targetId);
  await batchOrConflict(env, [
    ...releaseAndCancelStatements(env, actor.workspaceId, targetId, t.version, t.period_id, 'draft', null, null),
    auditStmt(env, actor, 'target.returned_to_draft', 'target', targetId),
  ], () => new AppError('version_conflict', 'This post changed. Reload the page.'));
  return { target_id: targetId, status: 'draft' as const };
}

/** Signed short-lived handoff link for MCP responses; the page still requires a signed-in member. */
export async function approvalLink(env: Env, workspaceId: string, targetId: string): Promise<string> {
  const { token } = await signToken(env, 'approval-link', { ws: workspaceId, target: targetId }, 24 * 3600);
  return `${env.APP_ORIGIN}/approve/tiktok/${targetId}?handoff=${encodeURIComponent(token)}`;
}
