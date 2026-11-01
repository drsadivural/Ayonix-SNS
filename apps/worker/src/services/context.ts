import type { Role } from '@ayonix/contracts';
import { AppError } from '../lib/errors.js';

export type McpScope = 'sns:read' | 'sns:draft' | 'sns:schedule' | 'sns:cancel';

/** Authenticated caller. Workspace and role always come from a validated membership. */
export interface Actor {
  identityId: string;
  email: string;
  workspaceId: string;
  role: Role;
  via: 'web' | 'mcp' | 'system';
  scopes: McpScope[] | null;
  requestId: string;
}

const RANK: Record<Role, number> = { viewer: 0, editor: 1, admin: 2, owner: 3 };

export type Permission = 'read' | 'draft' | 'schedule' | 'cancel' | 'manage_connections' | 'manage_members' | 'manage_billing' | 'manage_workspace' | 'audit';

const MIN_ROLE: Record<Permission, Role> = {
  read: 'viewer',
  draft: 'editor',
  schedule: 'editor',
  cancel: 'editor',
  manage_connections: 'admin',
  manage_members: 'admin',
  manage_billing: 'owner',
  manage_workspace: 'admin',
  audit: 'admin',
};

const SCOPE_FOR: Partial<Record<Permission, McpScope>> = {
  read: 'sns:read',
  draft: 'sns:draft',
  schedule: 'sns:schedule',
  cancel: 'sns:cancel',
};

export function hasRole(role: Role, min: Role): boolean {
  return RANK[role] >= RANK[min];
}

export function authorize(actor: Actor, permission: Permission): void {
  if (!hasRole(actor.role, MIN_ROLE[permission])) {
    throw new AppError('forbidden', `Your ${actor.role} role cannot perform this action`);
  }
  if (actor.via === 'mcp') {
    const scope = SCOPE_FOR[permission];
    if (!scope) throw new AppError('forbidden', 'This action is only available on the Ayonix website');
    if (!actor.scopes?.includes(scope)) throw new AppError('forbidden', `Missing OAuth scope ${scope}`, { details: { required_scope: scope } });
  }
}

export function systemActor(workspaceId: string, requestId: string): Actor {
  return { identityId: 'system', email: '', workspaceId, role: 'owner', via: 'system', scopes: null, requestId };
}
