// Fixtures for contract/integration tests. These run in workerd with real
// local D1/R2/KV/Queues. Provider and Stripe HTTP are doubles: results here
// are NOT live provider or billing evidence (docs/10-ACCEPTANCE.md).
import { env } from 'cloudflare:test';
import type { Role } from '@ayonix/contracts';
import type { Env } from '../src/lib/env.js';
import type { Actor } from '../src/services/context.js';

export const testEnv = env as unknown as Env;
let n = 0;
const uid = (p: string) => `${p}_${Date.now().toString(36)}${(n++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const now = () => new Date().toISOString();

export async function makeIdentity(email = `${uid('u')}@example.test`) {
  const id = uid('usr');
  await testEnv.DB.batch([
    testEnv.DB.prepare(`INSERT INTO "user"(id, name, email, emailVerified, createdAt, updatedAt) VALUES (?,?,?,?,?,?)`).bind(id, 'Test', email, 1, now(), now()),
    testEnv.DB.prepare('INSERT INTO identities(id, email, display_name, created_at) VALUES (?,?,?,?)').bind(id, email, 'Test', now()),
  ]);
  return { id, email };
}

export interface Fixture {
  workspaceId: string;
  owner: Actor;
  periodId: string;
  productId: string;
  connections: Record<string, string>;
}

export function actorFor(workspaceId: string, identity: { id: string; email: string }, role: Role, via: Actor['via'] = 'web', scopes: Actor['scopes'] = null): Actor {
  return { identityId: identity.id, email: identity.email, workspaceId, role, via, scopes, requestId: uid('req') };
}

/** Workspace with an active Standard-like subscription, a current period and approved product. */
export async function makeWorkspace(opts: { allowance?: number; plan?: string; status?: string } = {}): Promise<Fixture> {
  const owner = await makeIdentity();
  const ws = uid('ws');
  const t = now();
  const start = new Date(Date.now() - 86400_000).toISOString();
  const end = new Date(Date.now() + 20 * 86400_000).toISOString();
  const periodId = uid('qp');
  const productId = uid('prd');
  const stmts = [
    testEnv.DB.prepare('INSERT INTO workspaces(id, name, timezone, created_at, updated_at) VALUES (?,?,?,?,?)').bind(ws, 'Test WS', 'Australia/Melbourne', t, t),
    testEnv.DB.prepare(`INSERT INTO memberships(workspace_id, identity_id, role, created_at, updated_at) VALUES (?,?,?,?,?)`).bind(ws, owner.id, 'owner', t, t),
    testEnv.DB.prepare(`INSERT INTO subscriptions(id, workspace_id, plan, status, current_period_start, current_period_end, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)`).bind(uid('sub'), ws, opts.plan ?? 'standard', opts.status ?? 'active', start, end, t, t),
    testEnv.DB.prepare(`INSERT INTO quota_periods(id, workspace_id, source, starts_at, ends_at, allowance, created_at) VALUES (?,?,?,?,?,?,?)`).bind(periodId, ws, 'subscription', start, end, opts.allowance ?? 60, t),
    testEnv.DB.prepare(`INSERT INTO products(id, workspace_id, name, status, version, approved_version, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)`).bind(productId, ws, 'Ayonix Shoplifter', 'approved', 1, 1, t, t),
  ];
  const connections: Record<string, string> = {};
  for (const p of ['linkedin', 'facebook', 'tiktok'] as const) {
    const id = uid('con');
    connections[p] = id;
    stmts.push(testEnv.DB.prepare(`INSERT INTO connections(id, workspace_id, provider, provider_account_id, account_name, account_type, state, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)`).bind(id, ws, p, uid('acct'), `${p} test account`, 'page', 'connected', t, t));
    for (const f of ['text', 'link', 'image', 'video', 'photo']) {
      stmts.push(testEnv.DB.prepare(`INSERT INTO connection_capabilities(workspace_id, connection_id, capability, status, checked_at) VALUES (?,?,?,?,?)`).bind(ws, id, `publish_${f}`, 'available', t));
    }
  }
  await testEnv.DB.batch(stmts);
  return { workspaceId: ws, owner: actorFor(ws, owner, 'owner'), periodId, productId, connections };
}

export async function storeFakeToken(f: Fixture, connectionId: string) {
  const { seal } = await import('../src/security/crypto.js');
  const s = await seal(testEnv, 'test-access-token', `${f.workspaceId}:${connectionId}:access`);
  await testEnv.DB.prepare(`INSERT INTO encrypted_credentials(id, workspace_id, connection_id, kind, ciphertext, nonce, key_version, expires_at, created_at) VALUES (?,?,?,?,?,?,?,?,?)`)
    .bind(uid('crd'), f.workspaceId, connectionId, 'access', s.ciphertext, s.nonce, s.key_version, new Date(Date.now() + 86400_000).toISOString(), now()).run();
}

export const future = (minutes: number) => new Date(Math.floor((Date.now() + minutes * 60_000) / 60_000) * 60_000).toISOString();
export { uid };

export async function makeAsset(f: Fixture, mime = 'image/png') {
  const id = uid('ast');
  await testEnv.MEDIA.put(`ws/${f.workspaceId}/assets/${id}`, new Uint8Array([1, 2, 3]));
  await testEnv.DB.prepare(`INSERT INTO assets(id, workspace_id, r2_key, filename, mime, bytes, max_bytes, width, height, checksum_sha256, validation_state, source, rights_confirmed, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(id, f.workspaceId, `ws/${f.workspaceId}/assets/${id}`, 'a.png', mime, 3, 3, 1080, 1350, 'abc', 'valid', 'upload', 1, now(), now()).run();
  return id;
}
