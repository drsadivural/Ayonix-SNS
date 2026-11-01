import type { AuditEvent } from '@ayonix/contracts';
import type { Env } from '../lib/env.js';
import { newId, nowIso } from '../lib/ids.js';
import { all, decodeCursor, encodeCursor, parseJson, stmt } from '../lib/db.js';
import { redact } from '../security/redact.js';
import type { Actor } from './context.js';
import { authorize } from './context.js';

export function auditStmt(
  env: Env,
  actor: Pick<Actor, 'identityId' | 'workspaceId' | 'via' | 'requestId'> | { workspaceId: string; actorType: 'system' | 'stripe' | 'provider' | 'staff'; requestId?: string },
  action: string,
  objectType: string,
  objectId: string | null,
  detail: Record<string, unknown> = {},
  revision: number | null = null,
) {
  const isUser = 'identityId' in actor;
  const actorType = isUser ? (actor.via === 'mcp' ? 'mcp' : actor.via === 'system' ? 'system' : 'user') : actor.actorType;
  return stmt(
    env,
    `INSERT INTO audit_events(id, workspace_id, actor_identity_id, actor_type, action, object_type, object_id, revision, detail_json, request_id, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    newId('evt'),
    actor.workspaceId,
    isUser && actor.identityId !== 'system' ? actor.identityId : null,
    actorType,
    action,
    objectType,
    objectId,
    revision,
    JSON.stringify(redact(detail)),
    actor.requestId ?? null,
    nowIso(),
  );
}

export async function listEvents(env: Env, actor: Actor, cursor?: string, limit = 50): Promise<{ items: AuditEvent[]; next_cursor: string | null }> {
  authorize(actor, 'audit');
  const c = decodeCursor(cursor);
  const rows = await all<Record<string, string | null>>(
    env,
    `SELECT a.*, i.email AS actor_email FROM audit_events a LEFT JOIN identities i ON i.id = a.actor_identity_id
     WHERE a.workspace_id = ? ${c ? 'AND (a.created_at, a.id) < (?, ?)' : ''}
     ORDER BY a.created_at DESC, a.id DESC LIMIT ?`,
    ...(c ? [actor.workspaceId, c[0], c[1], limit + 1] : [actor.workspaceId, limit + 1]),
  );
  const page = rows.slice(0, limit);
  return {
    items: page.map((r) => ({
      id: r.id!,
      actor: r.actor_email ?? r.actor_type ?? null,
      action: r.action!,
      object_type: r.object_type!,
      object_id: r.object_id ?? null,
      detail: parseJson(r.detail_json, {}),
      created_at: r.created_at!,
    })),
    next_cursor: rows.length > limit ? encodeCursor(page.at(-1)!.created_at!, page.at(-1)!.id!) : null,
  };
}
