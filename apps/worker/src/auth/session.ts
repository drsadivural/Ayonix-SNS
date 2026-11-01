import type { Role } from '@ayonix/contracts';
import type { Env } from '../lib/env.js';
import { AppError } from '../lib/errors.js';
import { first } from '../lib/db.js';
import type { Actor } from '../services/context.js';
import { createAuth } from './better-auth.js';

export interface SessionIdentity {
  id: string;
  email: string;
  name: string;
  emailVerified: boolean;
  sessionCreatedAt: string;
}

export async function getSessionIdentity(env: Env, headers: Headers): Promise<SessionIdentity | null> {
  const auth = createAuth(env);
  const s = await auth.api.getSession({ headers });
  if (!s) return null;
  return {
    id: s.user.id,
    email: s.user.email,
    name: s.user.name ?? '',
    emailVerified: Boolean(s.user.emailVerified),
    sessionCreatedAt: new Date(s.session.createdAt).toISOString(),
  };
}

/** Sessions created within the last 15 minutes count as freshly authenticated. */
export const isFresh = (identity: SessionIdentity) => Date.now() - new Date(identity.sessionCreatedAt).getTime() < 15 * 60_000;

/** Resolve the actor for a web request. Workspace comes from membership, never from the parameter alone. */
export async function webActor(env: Env, identity: SessionIdentity, requestedWorkspace: string | null, requestId: string): Promise<Actor> {
  if (!identity.emailVerified) throw new AppError('forbidden', 'Verify your email address first.', { details: { verify_email: true } });
  const m = requestedWorkspace
    ? await first<{ workspace_id: string; role: Role }>(
        env,
        `SELECT m.workspace_id, m.role FROM memberships m JOIN workspaces w ON w.id = m.workspace_id WHERE m.identity_id = ? AND m.workspace_id = ? AND w.status IN ('active','suspended')`,
        identity.id,
        requestedWorkspace,
      )
    : await first<{ workspace_id: string; role: Role }>(
        env,
        `SELECT m.workspace_id, m.role FROM memberships m JOIN workspaces w ON w.id = m.workspace_id WHERE m.identity_id = ? AND w.status IN ('active','suspended') ORDER BY w.created_at LIMIT 1`,
        identity.id,
      );
  if (!m) throw new AppError(requestedWorkspace ? 'not_found' : 'conflict', requestedWorkspace ? 'Workspace not found' : 'Create a workspace first.', requestedWorkspace ? {} : { details: { onboarding: true } });
  return { identityId: identity.id, email: identity.email, workspaceId: m.workspace_id, role: m.role, via: 'web', scopes: null, requestId };
}
