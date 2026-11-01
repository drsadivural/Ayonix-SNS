import type { Entitlements, Invitation, Me, Member, NotificationPreference, PlanName, QuotaSummary, Role, SubscriptionStatus, WorkspaceSummary } from '@ayonix/contracts';
import { PLATFORMS } from '@ayonix/contracts';
import { STORAGE_BYTES, TRIAL, assertTimezone, entitlementFor, sha256Hex } from '@ayonix/domain';
import type { CustomSelection } from '@ayonix/contracts';
import type { Env } from '../lib/env.js';
import { emailConfigured, providerConfigured, researchConfigured, stripeConfigured } from '../lib/env.js';
import { AppError, forbidden, invalid, notFound } from '../lib/errors.js';
import { newId, nowIso, randomToken } from '../lib/ids.js';
import { all, first, parseJson, run, stmt } from '../lib/db.js';
import { auditStmt } from './audit.js';
import type { Actor } from './context.js';
import { authorize, hasRole } from './context.js';
import { sendEmail } from './email.js';

export interface SubscriptionRow {
  id: string;
  workspace_id: string;
  plan: PlanName | null;
  status: SubscriptionStatus;
  selection_json: string | null;
  unit_amount_cents: number | null;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  current_period_start: string | null;
  current_period_end: string | null;
  cancel_at_period_end: number;
  pending_plan: string | null;
  pending_selection_json: string | null;
  pending_effective_at: string | null;
  trial_ends_at: string | null;
  past_due_since: string | null;
  last_event_created: number;
  entitlement_version: number;
}

export async function getSubscription(env: Env, workspaceId: string): Promise<SubscriptionRow | null> {
  return first<SubscriptionRow>(env, 'SELECT * FROM subscriptions WHERE workspace_id = ?', workspaceId);
}

/** Effective entitlement, server-derived from the subscription record. */
export function entitlementsFrom(sub: SubscriptionRow | null, now = new Date()): Entitlements {
  const none: Entitlements = {
    plan: null,
    status: 'none',
    posts_per_cycle: 0,
    products: 0,
    auto_learn: false,
    competitor_check: false,
    similar_research: false,
    storage_bytes: 0,
    can_confirm_schedules: false,
    restriction: 'This workspace has no active plan.',
  };
  if (!sub || !sub.plan || sub.status === 'none') return none;
  let status = sub.status;
  if (status === 'trialing' && sub.plan === 'trial' && sub.trial_ends_at && new Date(sub.trial_ends_at) <= now) status = 'expired';
  const ent = entitlementFor(sub.plan, sub.plan === 'custom' ? parseJson<CustomSelection | null>(sub.selection_json, null) : null);
  const base: Entitlements = {
    plan: sub.plan,
    status,
    posts_per_cycle: ent.posts,
    products: ent.products,
    auto_learn: ent.autoLearn,
    competitor_check: ent.competitorCheck,
    similar_research: ent.similarResearch,
    storage_bytes: STORAGE_BYTES[sub.plan],
    can_confirm_schedules: false,
    restriction: null,
  };
  switch (status) {
    case 'active':
    case 'trialing':
      return { ...base, can_confirm_schedules: true };
    case 'past_due':
      return { ...base, restriction: 'A payment failed. New schedules are paused and due posts are held until payment recovers.' };
    case 'expired':
      return { ...base, restriction: 'The trial has ended. Drafts are kept; publishing is paused.' };
    case 'incomplete':
      return { ...base, restriction: 'Payment is still being confirmed.' };
    default:
      return { ...base, restriction: 'Publishing is paused for this workspace.' };
  }
}

export async function currentPeriod(env: Env, workspaceId: string, at = nowIso()) {
  return first<{ id: string; starts_at: string; ends_at: string; allowance: number; used: number; reserved: number; version: number }>(
    env,
    'SELECT id, starts_at, ends_at, allowance, used, reserved, version FROM quota_periods WHERE workspace_id = ? AND starts_at <= ? AND ends_at > ? ORDER BY starts_at DESC LIMIT 1',
    workspaceId,
    at,
    at,
  );
}

export async function quotaSummary(env: Env, workspaceId: string): Promise<QuotaSummary> {
  const p = await currentPeriod(env, workspaceId);
  if (!p) return { period_id: null, starts_at: null, ends_at: null, allowance: 0, used: 0, reserved: 0, available: 0 };
  return { period_id: p.id, starts_at: p.starts_at, ends_at: p.ends_at, allowance: p.allowance, used: p.used, reserved: p.reserved, available: p.allowance - p.used - p.reserved };
}

export async function getMe(env: Env, identity: { id: string; email: string; name: string; emailVerified: boolean }): Promise<Me> {
  const rows = await all<{ id: string; name: string; role: Role }>(
    env,
    `SELECT w.id, w.name, m.role FROM memberships m JOIN workspaces w ON w.id = m.workspace_id
     WHERE m.identity_id = ? AND w.status IN ('active','suspended') ORDER BY w.created_at`,
    identity.id,
  );
  return { identity: { id: identity.id, email: identity.email, name: identity.name, email_verified: identity.emailVerified }, workspaces: rows };
}

export async function workspaceSummary(env: Env, actor: Actor): Promise<WorkspaceSummary> {
  authorize(actor, 'read');
  const ws = await first<{ id: string; name: string; timezone: string; locale: string }>(env, 'SELECT id, name, timezone, locale FROM workspaces WHERE id = ?', actor.workspaceId);
  if (!ws) throw notFound('Workspace');
  const sub = await getSubscription(env, actor.workspaceId);
  const integrations = {
    email: emailConfigured(env),
    stripe: stripeConfigured(env),
    research: researchConfigured(env),
    ai: Boolean(env.AI_PROVIDER_API_KEY),
    ...Object.fromEntries(PLATFORMS.map((p) => [p, providerConfigured(env, p)])),
  } as WorkspaceSummary['integrations'];
  return { ...ws, role: actor.role, entitlements: entitlementsFrom(sub), quota: await quotaSummary(env, actor.workspaceId), integrations };
}

export async function createWorkspace(env: Env, identity: { id: string; email: string }, input: { name: string; timezone?: string }, requestId: string) {
  const name = input.name?.trim();
  if (!name || name.length > 120) throw invalid('Workspace name is required', { name: 'Enter a workspace name' });
  const timezone = assertTimezone(input.timezone || env.DEFAULT_TIMEZONE);
  const id = newId('ws');
  const now = nowIso();
  await env.DB.batch([
    stmt(env, 'INSERT INTO workspaces(id, name, timezone, created_at, updated_at) VALUES (?,?,?,?,?)', id, name, timezone, now, now),
    stmt(env, 'INSERT INTO memberships(workspace_id, identity_id, role, created_at, updated_at) VALUES (?,?,?,?,?)', id, identity.id, 'owner', now, now),
    stmt(env, `INSERT INTO subscriptions(id, workspace_id, status, created_at, updated_at) VALUES (?,?,'none',?,?)`, newId('sub'), id, now, now),
    auditStmt(env, { identityId: identity.id, workspaceId: id, via: 'web', requestId }, 'workspace.created', 'workspace', id, { name }),
  ]);
  return { id, name, timezone };
}

export async function updateWorkspace(env: Env, actor: Actor, input: { name?: string; timezone?: string; locale?: string }) {
  authorize(actor, 'manage_workspace');
  const sets: string[] = [];
  const binds: unknown[] = [];
  if (input.name !== undefined) {
    const n = input.name.trim();
    if (!n || n.length > 120) throw invalid('Workspace name is required', { name: 'Enter a workspace name' });
    sets.push('name = ?');
    binds.push(n);
  }
  if (input.timezone !== undefined) {
    sets.push('timezone = ?');
    binds.push(assertTimezone(input.timezone));
  }
  if (input.locale !== undefined) {
    if (!/^[a-z]{2,3}(-[A-Z]{2})?$/.test(input.locale)) throw invalid('Unsupported locale', { locale: 'Use a locale like en-AU' });
    sets.push('locale = ?');
    binds.push(input.locale);
  }
  if (!sets.length) return workspaceSummary(env, actor);
  await env.DB.batch([
    stmt(env, `UPDATE workspaces SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`, ...binds, nowIso(), actor.workspaceId),
    auditStmt(env, actor, 'workspace.updated', 'workspace', actor.workspaceId, { fields: Object.keys(input) }),
  ]);
  return workspaceSummary(env, actor);
}

/** Website-only 7-day trial: one per workspace owner identity, no card, 5 publications. */
export async function startTrial(env: Env, actor: Actor) {
  authorize(actor, 'manage_billing');
  if (actor.via !== 'web') throw forbidden('Trials are only available on the Ayonix website');
  const prior = await first<{ n: number }>(
    env,
    `SELECT COUNT(*) AS n FROM workspaces w JOIN memberships m ON m.workspace_id = w.id
     WHERE m.identity_id = ? AND m.role = 'owner' AND w.trial_used = 1`,
    actor.identityId,
  );
  if ((prior?.n ?? 0) > 0) throw new AppError('conflict', 'A trial has already been used by this account.');
  const sub = await getSubscription(env, actor.workspaceId);
  if (sub && sub.status !== 'none') throw new AppError('conflict', 'This workspace already has a plan.');
  const now = new Date();
  const ends = new Date(now.getTime() + TRIAL.days * 86400_000).toISOString();
  const start = now.toISOString();
  await env.DB.batch([
    stmt(env, `UPDATE subscriptions SET plan='trial', status='trialing', trial_ends_at=?, current_period_start=?, current_period_end=?, entitlement_version=entitlement_version+1, updated_at=? WHERE workspace_id=? AND status='none'`, ends, start, ends, start, actor.workspaceId),
    stmt(env, 'UPDATE workspaces SET trial_used = 1, updated_at = ? WHERE id = ?', start, actor.workspaceId),
    stmt(env, `INSERT INTO quota_periods(id, workspace_id, source, starts_at, ends_at, allowance, created_at) VALUES (?,?,?,?,?,?,?)`, newId('qp'), actor.workspaceId, 'trial', start, ends, TRIAL.posts, start),
    auditStmt(env, actor, 'billing.trial_started', 'subscription', actor.workspaceId, { ends_at: ends }),
  ]);
  return workspaceSummary(env, actor);
}

// ---------------------------------------------------------------------------
// Members and invitations

export async function listMembers(env: Env, actor: Actor): Promise<{ members: Member[]; invitations: Invitation[] }> {
  authorize(actor, 'read');
  const members = await all<Member>(
    env,
    `SELECT m.identity_id, i.email, i.display_name AS name, m.role, m.created_at AS joined_at
     FROM memberships m JOIN identities i ON i.id = m.identity_id WHERE m.workspace_id = ? ORDER BY m.created_at`,
    actor.workspaceId,
  );
  const invitations = hasRole(actor.role, 'admin')
    ? await all<Invitation>(env, `SELECT id, email, role, expires_at, accepted_at FROM invitations WHERE workspace_id = ? AND revoked_at IS NULL AND accepted_at IS NULL ORDER BY created_at DESC`, actor.workspaceId)
    : [];
  return { members, invitations };
}

export async function inviteMember(env: Env, actor: Actor, input: { email: string; role: Role }) {
  authorize(actor, 'manage_members');
  const email = input.email?.trim().toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw invalid('Enter a valid email', { email: 'Enter a valid email' });
  if (!['admin', 'editor', 'viewer'].includes(input.role)) throw invalid('Invalid role', { role: 'Choose admin, editor or viewer' });
  if (input.role === 'admin' && actor.role !== 'owner') throw forbidden('Only an owner can invite admins');
  const token = randomToken(32);
  const id = newId('inv');
  const expires = new Date(Date.now() + 7 * 86400_000).toISOString();
  await env.DB.batch([
    stmt(env, `INSERT INTO invitations(id, workspace_id, email, role, token_hash, invited_by, expires_at, created_at) VALUES (?,?,?,?,?,?,?,?)`, id, actor.workspaceId, email, input.role, await sha256Hex(token), actor.identityId, expires, nowIso()),
    auditStmt(env, actor, 'member.invited', 'invitation', id, { role: input.role }),
  ]);
  const ws = await first<{ name: string }>(env, 'SELECT name FROM workspaces WHERE id = ?', actor.workspaceId);
  await sendEmail(env, {
    to: email,
    template: 'invitation',
    subject: `You are invited to ${ws?.name ?? 'an Ayonix-SNS workspace'}`,
    text: `${actor.email} invited you to join ${ws?.name ?? 'a workspace'} on Ayonix-SNS as ${input.role}.\n\nAccept within 7 days: ${env.APP_ORIGIN}/invite?token=${encodeURIComponent(token)}`,
    workspaceId: actor.workspaceId,
  });
  return { id, email, role: input.role, expires_at: expires, accepted_at: null };
}

export async function acceptInvitation(env: Env, identity: { id: string; email: string }, token: string, requestId: string) {
  const inv = await first<{ id: string; workspace_id: string; email: string; role: Role; expires_at: string; accepted_at: string | null; revoked_at: string | null }>(
    env,
    'SELECT * FROM invitations WHERE token_hash = ?',
    await sha256Hex(token ?? ''),
  );
  if (!inv || inv.revoked_at || inv.accepted_at || inv.expires_at < nowIso()) throw new AppError('not_found', 'This invitation is invalid or has expired.');
  if (inv.email !== identity.email.toLowerCase()) throw forbidden('This invitation was sent to a different email address.');
  const now = nowIso();
  await env.DB.batch([
    stmt(env, 'UPDATE invitations SET accepted_at = ? WHERE id = ? AND accepted_at IS NULL', now, inv.id),
    stmt(env, `INSERT INTO memberships(workspace_id, identity_id, role, created_at, updated_at) VALUES (?,?,?,?,?) ON CONFLICT(workspace_id, identity_id) DO NOTHING`, inv.workspace_id, identity.id, inv.role, now, now),
    auditStmt(env, { identityId: identity.id, workspaceId: inv.workspace_id, via: 'web', requestId }, 'member.joined', 'membership', identity.id, { role: inv.role }),
  ]);
  return { workspace_id: inv.workspace_id };
}

export async function revokeInvitation(env: Env, actor: Actor, id: string) {
  authorize(actor, 'manage_members');
  const r = await run(env, 'UPDATE invitations SET revoked_at = ? WHERE id = ? AND workspace_id = ? AND accepted_at IS NULL AND revoked_at IS NULL', nowIso(), id, actor.workspaceId);
  if (!r.meta.changes) throw notFound('Invitation');
  await auditStmt(env, actor, 'member.invitation_revoked', 'invitation', id).run();
}

export async function changeRole(env: Env, actor: Actor, identityId: string, role: Role) {
  authorize(actor, 'manage_members');
  if (!['owner', 'admin', 'editor', 'viewer'].includes(role)) throw invalid('Invalid role');
  const target = await first<{ role: Role }>(env, 'SELECT role FROM memberships WHERE workspace_id = ? AND identity_id = ?', actor.workspaceId, identityId);
  if (!target) throw notFound('Member');
  if ((role === 'owner' || target.role === 'owner' || role === 'admin' || target.role === 'admin') && actor.role !== 'owner') throw forbidden('Only an owner can change owner or admin roles');
  if (target.role === 'owner' && role !== 'owner') {
    // Conditional update guards the last-owner invariant against concurrent demotions.
    const r = await run(
      env,
      `UPDATE memberships SET role = ?, updated_at = ? WHERE workspace_id = ? AND identity_id = ?
       AND (SELECT COUNT(*) FROM memberships WHERE workspace_id = ? AND role = 'owner') > 1`,
      role, nowIso(), actor.workspaceId, identityId, actor.workspaceId,
    );
    if (!r.meta.changes) throw new AppError('conflict', 'A workspace must keep at least one owner.');
  } else {
    await run(env, 'UPDATE memberships SET role = ?, updated_at = ? WHERE workspace_id = ? AND identity_id = ?', role, nowIso(), actor.workspaceId, identityId);
  }
  await auditStmt(env, actor, 'member.role_changed', 'membership', identityId, { from: target.role, to: role }).run();
}

export async function removeMember(env: Env, actor: Actor, identityId: string) {
  if (identityId !== actor.identityId) authorize(actor, 'manage_members');
  const target = await first<{ role: Role }>(env, 'SELECT role FROM memberships WHERE workspace_id = ? AND identity_id = ?', actor.workspaceId, identityId);
  if (!target) throw notFound('Member');
  if (target.role === 'owner' && identityId !== actor.identityId && actor.role !== 'owner') throw forbidden('Only an owner can remove an owner');
  if (target.role === 'owner') {
    const r = await run(
      env,
      `DELETE FROM memberships WHERE workspace_id = ? AND identity_id = ?
       AND (SELECT COUNT(*) FROM memberships WHERE workspace_id = ? AND role = 'owner') > 1`,
      actor.workspaceId, identityId, actor.workspaceId,
    );
    if (!r.meta.changes) throw new AppError('conflict', 'The last owner cannot be removed.');
  } else {
    await run(env, 'DELETE FROM memberships WHERE workspace_id = ? AND identity_id = ?', actor.workspaceId, identityId);
  }
  await auditStmt(env, actor, 'member.removed', 'membership', identityId, { role: target.role }).run();
}

// ---------------------------------------------------------------------------
// Notification preferences

const EVENTS: NotificationPreference['event'][] = ['publish_failed', 'approval_needed', 'reconnect_required', 'payment_failed', 'weekly_report'];

export async function getPreferences(env: Env, actor: Actor): Promise<NotificationPreference[]> {
  authorize(actor, 'read');
  const rows = await all<{ event: NotificationPreference['event']; email: number }>(env, 'SELECT event, email FROM notification_preferences WHERE workspace_id = ? AND identity_id = ?', actor.workspaceId, actor.identityId);
  const map = new Map(rows.map((r) => [r.event, r.email === 1]));
  return EVENTS.map((event) => ({ event, email: map.get(event) ?? event !== 'weekly_report' }));
}

export async function setPreferences(env: Env, actor: Actor, prefs: NotificationPreference[]) {
  authorize(actor, 'read');
  if (actor.via !== 'web') throw forbidden();
  const now = nowIso();
  const stmts = [];
  for (const p of prefs) {
    if (!EVENTS.includes(p.event) || typeof p.email !== 'boolean') throw invalid('Invalid preference');
    stmts.push(
      stmt(env, `INSERT INTO notification_preferences(workspace_id, identity_id, event, email, updated_at) VALUES (?,?,?,?,?)
        ON CONFLICT(workspace_id, identity_id, event) DO UPDATE SET email = excluded.email, updated_at = excluded.updated_at`, actor.workspaceId, actor.identityId, p.event, p.email ? 1 : 0, now),
    );
  }
  if (stmts.length) await env.DB.batch(stmts);
  return getPreferences(env, actor);
}

/** Recipients (owners/admins, or all members for approvals) honoring preferences. */
export async function notifyWorkspace(env: Env, workspaceId: string, event: NotificationPreference['event'], subject: string, text: string, dedupeKey: string) {
  const roles = event === 'approval_needed' ? ['owner', 'admin', 'editor'] : ['owner', 'admin'];
  const recipients = await all<{ id: string; email: string; pref: number | null }>(
    env,
    `SELECT i.id, i.email, np.email AS pref FROM memberships m JOIN identities i ON i.id = m.identity_id
     LEFT JOIN notification_preferences np ON np.workspace_id = m.workspace_id AND np.identity_id = i.id AND np.event = ?
     WHERE m.workspace_id = ? AND m.role IN (${roles.map(() => '?').join(',')})`,
    event, workspaceId, ...roles,
  );
  for (const r of recipients) {
    const enabled = r.pref === null ? event !== 'weekly_report' : r.pref === 1;
    if (!enabled) continue;
    try {
      await sendEmail(env, { to: r.email, template: event, subject, text, workspaceId, identityId: r.id, dedupeKey: `${dedupeKey}:${r.id}` });
    } catch {
      /* recorded as failed in sent_notifications; alerting reads that table */
    }
  }
}
