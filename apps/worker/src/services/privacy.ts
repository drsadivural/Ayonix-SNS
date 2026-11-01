// Owner export and workspace deletion. Deletion revokes provider access,
// cancels future publication, erases tokens and media, and keeps only legally
// required billing records and minimal audit data.
import type { Env } from '../lib/env.js';
import { AppError, forbidden, notFound } from '../lib/errors.js';
import { newId, nowIso } from '../lib/ids.js';
import { all, first, run, stmt } from '../lib/db.js';
import { signToken, verifyToken } from '../security/crypto.js';
import { log } from '../security/redact.js';
import { adapterFor } from '../providers/registry.js';
import { auditStmt } from './audit.js';
import type { Actor } from './context.js';
import { providerContext } from './connections.js';
import { stripeClient } from './billing.js';
import { stripeConfigured } from '../lib/env.js';

export async function requestPrivacyJob(env: Env, actor: Actor, kind: 'export' | 'delete', sessionFresh: boolean) {
  if (actor.role !== 'owner') throw forbidden('Only an owner can export or delete the workspace');
  if (actor.via !== 'web') throw forbidden();
  if (!sessionFresh) throw new AppError('unauthenticated', 'Sign in again to confirm this request.', { details: { reauthenticate: true } });
  const id = newId('prv');
  await env.DB.batch([
    stmt(env, `INSERT INTO privacy_jobs(id, workspace_id, kind, status, requested_by, created_at) VALUES (?,?,?,?,?,?)`, id, actor.workspaceId, kind, 'queued', actor.identityId, nowIso()),
    ...(kind === 'delete' ? [stmt(env, `UPDATE workspaces SET status = 'deleting', updated_at = ? WHERE id = ?`, nowIso(), actor.workspaceId)] : []),
    auditStmt(env, actor, `privacy.${kind}_requested`, 'privacy_job', id),
  ]);
  try {
    await env.JOBS_QUEUE.send({ kind: 'privacy', workspace_id: actor.workspaceId, job_id: id });
  } catch {
    await env.DB.batch([
      stmt(env, `UPDATE privacy_jobs SET status = 'failed', error = 'Could not queue the request' WHERE id = ?`, id),
      ...(kind === 'delete' ? [stmt(env, `UPDATE workspaces SET status = 'active', updated_at = ? WHERE id = ? AND status = 'deleting'`, nowIso(), actor.workspaceId)] : []),
    ]);
    throw new AppError('unavailable', 'The request could not be queued. Try again.', { retryable: true });
  }
  return { id, kind, status: 'queued' as const };
}

export async function getPrivacyJob(env: Env, actor: Actor, id: string) {
  if (actor.role !== 'owner') throw forbidden();
  const j = await first<{ id: string; kind: string; status: string; r2_key: string | null; error: string | null; created_at: string; completed_at: string | null }>(env, 'SELECT id, kind, status, r2_key, error, created_at, completed_at FROM privacy_jobs WHERE workspace_id = ? AND id = ?', actor.workspaceId, id);
  if (!j) throw notFound('Request');
  let download_url: string | null = null;
  if (j.kind === 'export' && j.status === 'ready' && j.r2_key) {
    const { token } = await signToken(env, 'export', { ws: actor.workspaceId, job: id }, 15 * 60);
    download_url = `${env.APP_ORIGIN}/u/export/${encodeURIComponent(token)}`;
  }
  return { ...j, r2_key: undefined, download_url };
}

const EXPORT_TABLES = ['workspaces', 'memberships', 'products', 'product_revisions', 'product_claims', 'product_sources', 'connections', 'connection_capabilities', 'assets', 'campaigns', 'posts', 'content_revisions', 'post_assets', 'schedules', 'targets', 'approvals', 'provider_receipts', 'quota_periods', 'subscriptions', 'invoices', 'metric_snapshots', 'report_jobs', 'research_jobs', 'research_sources', 'audit_events'];

export async function runPrivacyJob(env: Env, workspaceId: string, jobId: string) {
  const job = await first<{ kind: string; status: string }>(env, 'SELECT kind, status FROM privacy_jobs WHERE workspace_id = ? AND id = ?', workspaceId, jobId);
  if (!job || !['queued', 'running'].includes(job.status)) return;
  await run(env, `UPDATE privacy_jobs SET status = 'running' WHERE id = ?`, jobId);
  try {
    if (job.kind === 'export') {
      const out: Record<string, unknown[]> = {};
      for (const t of EXPORT_TABLES) {
        const col = t === 'workspaces' ? 'id' : 'workspace_id';
        out[t] = await all(env, `SELECT * FROM ${t} WHERE ${col} = ?`, workspaceId);
      }
      const key = `ws/${workspaceId}/exports/${jobId}.json`;
      await env.MEDIA.put(key, JSON.stringify({ exported_at: nowIso(), note: 'Provider tokens and secrets are never exported.', data: out }, null, 2), { httpMetadata: { contentType: 'application/json' } });
      await run(env, `UPDATE privacy_jobs SET status = 'ready', r2_key = ?, completed_at = ? WHERE id = ?`, key, nowIso(), jobId);
      return;
    }
    // delete
    const conns = await all<{ id: string; provider: string }>(env, `SELECT id, provider FROM connections WHERE workspace_id = ? AND state <> 'disconnected'`, workspaceId);
    for (const c of conns) {
      try {
        const ctx = await providerContext(env, workspaceId, c.id, `delete:${jobId}`);
        await adapterFor(ctx.connection.provider).disconnect(ctx);
      } catch {
        log('warn', 'privacy.revoke_failed', { provider: c.provider });
      }
    }
    const sub = await first<{ stripe_subscription_id: string | null; status: string }>(env, 'SELECT stripe_subscription_id, status FROM subscriptions WHERE workspace_id = ?', workspaceId);
    if (sub?.stripe_subscription_id && stripeConfigured(env) && !['canceled', 'expired'].includes(sub.status)) {
      await stripeClient(env).subscriptions.cancel(sub.stripe_subscription_id, {}, { idempotencyKey: `delete-${jobId}` });
    }
    const now = nowIso();
    await env.DB.batch([
      stmt(env, `UPDATE targets SET status = 'canceled', version = version + 1, updated_at = ? WHERE workspace_id = ? AND status IN ('draft','awaiting_approval','scheduled','queued','retry_wait','reconnect_required')`, now, workspaceId),
      stmt(env, `UPDATE outbox SET state = 'done', updated_at = ? WHERE workspace_id = ? AND state <> 'done'`, now, workspaceId),
      stmt(env, 'DELETE FROM encrypted_credentials WHERE workspace_id = ?', workspaceId),
      stmt(env, `UPDATE connections SET state = 'disconnected', metadata_json = '{}', updated_at = ? WHERE workspace_id = ?`, now, workspaceId),
      stmt(env, `UPDATE content_revisions SET caption = '', title = NULL, link_url = NULL, options_json = '{}' WHERE workspace_id = ?`, workspaceId),
      stmt(env, `UPDATE assets SET validation_state = 'rejected', validation_error = 'deleted', filename = 'deleted', bytes = 0 WHERE workspace_id = ?`, workspaceId),
      stmt(env, 'DELETE FROM memberships WHERE workspace_id = ?', workspaceId),
      stmt(env, 'DELETE FROM invitations WHERE workspace_id = ?', workspaceId),
      stmt(env, `UPDATE workspaces SET status = 'deleted', name = 'Deleted workspace', deleted_at = ?, updated_at = ? WHERE id = ?`, now, now, workspaceId),
      auditStmt(env, { workspaceId, actorType: 'system', requestId: `delete:${jobId}` }, 'privacy.workspace_deleted', 'workspace', workspaceId),
    ]);
    let cursor: string | undefined;
    do {
      const listed = await env.MEDIA.list({ prefix: `ws/${workspaceId}/`, cursor });
      if (listed.objects.length) await env.MEDIA.delete(listed.objects.map((o) => o.key));
      cursor = listed.truncated ? listed.cursor : undefined;
    } while (cursor);
    await run(env, `UPDATE privacy_jobs SET status = 'completed', completed_at = ? WHERE id = ?`, nowIso(), jobId);
  } catch (e) {
    await run(env, `UPDATE privacy_jobs SET status = 'failed', error = ? WHERE id = ?`, e instanceof Error ? e.message.slice(0, 300) : 'failed', jobId);
    throw e;
  }
}

export async function serveExport(env: Env, token: string): Promise<Response> {
  const c = await verifyToken<{ ws: string; job: string }>(env, 'export', token);
  const j = await first<{ r2_key: string | null }>(env, `SELECT r2_key FROM privacy_jobs WHERE workspace_id = ? AND id = ? AND status = 'ready'`, c.ws, c.job);
  const obj = j?.r2_key ? await env.MEDIA.get(j.r2_key) : null;
  if (!obj) throw notFound('Export');
  return new Response(obj.body, { headers: { 'content-type': 'application/json', 'content-disposition': `attachment; filename="ayonix-export-${c.job}.json"`, 'cache-control': 'no-store' } });
}
