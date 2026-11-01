// Social connector lifecycle: state+PKCE bound OAuth initiation, callback
// exchange and real account discovery, encrypted token storage, capability
// probes, refresh/reconnect and disconnect (which pauses pending targets).
import type { CapabilityRow, Connection, ConnectionState, Platform, ProviderStatus } from '@ayonix/contracts';
import { PLATFORMS } from '@ayonix/contracts';
import type { Env } from '../lib/env.js';
import { providerConfigured } from '../lib/env.js';
import { AppError, forbidden, invalid, notFound } from '../lib/errors.js';
import { newId, nowIso, randomToken } from '../lib/ids.js';
import { all, first, parseJson, run, stmt } from '../lib/db.js';
import { open, pkcePair, seal } from '../security/crypto.js';
import { log } from '../security/redact.js';
import { adapterFor } from '../providers/registry.js';
import type { ConnectionRecord, FetchLike, ProviderContext, TokenSet } from '../providers/types.js';
import { ProviderError } from '../providers/types.js';
import { auditStmt } from './audit.js';
import type { Actor } from './context.js';
import { authorize } from './context.js';
import { entitlementsFrom, getSubscription, notifyWorkspace } from './workspace.js';

interface ConnectionRow {
  id: string;
  workspace_id: string;
  provider: Platform;
  provider_account_id: string;
  account_name: string;
  account_type: string;
  state: ConnectionState;
  granted_scopes: string;
  token_expires_at: string | null;
  last_verified_at: string | null;
  api_version: string | null;
  metadata_json: string;
}

const EXPIRING_WINDOW_MS = 7 * 86400_000;

function effectiveState(r: ConnectionRow): ConnectionState {
  if (r.state === 'connected' && r.token_expires_at && new Date(r.token_expires_at).getTime() - Date.now() < EXPIRING_WINDOW_MS) return 'expiring';
  return r.state;
}

async function toConnection(env: Env, r: ConnectionRow): Promise<Connection> {
  const caps = await all<CapabilityRow>(env, 'SELECT capability, status, detail FROM connection_capabilities WHERE workspace_id = ? AND connection_id = ? ORDER BY capability', r.workspace_id, r.id);
  return {
    id: r.id,
    provider: r.provider,
    account_name: r.account_name,
    account_type: r.account_type,
    provider_account_id: r.provider_account_id,
    state: effectiveState(r),
    granted_scopes: parseJson<string[]>(r.granted_scopes, []),
    token_expires_at: r.token_expires_at,
    last_verified_at: r.last_verified_at,
    api_version: r.api_version,
    capabilities: caps,
  };
}

function providerRestriction(env: Env, p: Platform): string | null {
  if (providerConfigured(env, p)) return null;
  return 'The Ayonix operator has not configured this network yet, so it cannot be connected.';
}

export async function listConnections(env: Env, actor: Actor): Promise<ProviderStatus[]> {
  authorize(actor, 'read');
  const rows = await all<ConnectionRow>(env, `SELECT * FROM connections WHERE workspace_id = ? AND state <> 'disconnected' ORDER BY provider, account_name`, actor.workspaceId);
  const out: ProviderStatus[] = [];
  for (const p of PLATFORMS) {
    const conns = await Promise.all(rows.filter((r) => r.provider === p).map((r) => toConnection(env, r)));
    out.push({ provider: p, configured: providerConfigured(env, p), restriction: providerRestriction(env, p), connections: conns });
  }
  return out;
}

export const redirectUri = (env: Env, provider: Platform) => `${env.APP_ORIGIN}/oauth/${provider}/callback`;

export async function startAuthorization(env: Env, actor: Actor, provider: Platform, reconnectConnectionId?: string): Promise<{ authorize_url: string }> {
  authorize(actor, 'manage_connections');
  if (actor.via !== 'web') throw forbidden('Connect accounts on the Ayonix website');
  if (!PLATFORMS.includes(provider)) throw notFound('Provider');
  if (!providerConfigured(env, provider)) throw new AppError('not_configured', providerRestriction(env, provider)!);
  const ent = entitlementsFrom(await getSubscription(env, actor.workspaceId));
  if (!ent.plan || ['canceled', 'expired', 'none'].includes(ent.status)) throw new AppError('entitlement_required', 'Connecting accounts requires an active plan or trial.');
  if (reconnectConnectionId) {
    const c = await first(env, 'SELECT id FROM connections WHERE workspace_id = ? AND id = ? AND provider = ?', actor.workspaceId, reconnectConnectionId, provider);
    if (!c) throw notFound('Connection');
  }
  const state = randomToken(24);
  const { verifier, challenge } = await pkcePair();
  const sealed = await seal(env, verifier, `oauth_state:${state}`);
  await run(env, `INSERT INTO oauth_states(id, workspace_id, identity_id, provider, verifier_ciphertext, verifier_nonce, key_version, reconnect_connection_id, expires_at, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`, state, actor.workspaceId, actor.identityId, provider, sealed.ciphertext, sealed.nonce, sealed.key_version, reconnectConnectionId ?? null, new Date(Date.now() + 10 * 60_000).toISOString(), nowIso());
  const url = adapterFor(provider).authorizeUrl(env, { state, codeChallenge: challenge, redirectUri: redirectUri(env, provider) });
  await auditStmt(env, actor, 'connection.authorize_started', 'provider', provider).run();
  return { authorize_url: url };
}

async function storeToken(env: Env, workspaceId: string, connectionId: string, kind: 'access' | 'refresh' | 'page_access', value: string | null | undefined, expiresAt: string | null | undefined) {
  if (!value) return stmt(env, 'DELETE FROM encrypted_credentials WHERE workspace_id = ? AND connection_id = ? AND kind = ?', workspaceId, connectionId, kind);
  const s = await seal(env, value, `${workspaceId}:${connectionId}:${kind}`);
  return stmt(env, `INSERT INTO encrypted_credentials(id, workspace_id, connection_id, kind, ciphertext, nonce, key_version, expires_at, created_at) VALUES (?,?,?,?,?,?,?,?,?)
    ON CONFLICT(workspace_id, connection_id, kind) DO UPDATE SET ciphertext = excluded.ciphertext, nonce = excluded.nonce, key_version = excluded.key_version, expires_at = excluded.expires_at, created_at = excluded.created_at`,
    newId('crd'), workspaceId, connectionId, kind, s.ciphertext, s.nonce, s.key_version, expiresAt ?? null, nowIso());
}

/** OAuth callback: validate state + session identity, exchange, discover, persist. Returns a redirect path. */
export async function completeAuthorization(
  env: Env,
  provider: Platform,
  params: { code: string | null; state: string | null; error: string | null },
  sessionIdentityId: string | null,
  requestId: string,
  fetchImpl: FetchLike = fetch,
): Promise<string> {
  if (!params.state) return `/connectors?error=${encodeURIComponent('Missing OAuth state')}`;
  const st = await first<{ workspace_id: string; identity_id: string; provider: string; verifier_ciphertext: string; verifier_nonce: string; key_version: number; reconnect_connection_id: string | null; expires_at: string; consumed_at: string | null }>(
    env, 'SELECT * FROM oauth_states WHERE id = ?', params.state);
  if (!st || st.provider !== provider) return `/connectors?error=${encodeURIComponent('Unknown or mismatched authorization request')}`;
  const consumed = await run(env, 'UPDATE oauth_states SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL', nowIso(), params.state);
  if (!consumed.meta.changes || st.expires_at < nowIso()) return `/connectors?error=${encodeURIComponent('This authorization link expired. Try connecting again.')}`;
  if (!sessionIdentityId || sessionIdentityId !== st.identity_id) return `/connectors?error=${encodeURIComponent('Sign in with the account that started the connection.')}`;
  const membership = await first<{ role: string }>(env, 'SELECT role FROM memberships WHERE workspace_id = ? AND identity_id = ?', st.workspace_id, st.identity_id);
  if (!membership || !['owner', 'admin'].includes(membership.role)) return `/connectors?error=${encodeURIComponent('You no longer manage connections in this workspace.')}`;
  const actorLike = { identityId: st.identity_id, workspaceId: st.workspace_id, via: 'web' as const, requestId };
  if (params.error || !params.code) {
    await auditStmt(env, actorLike, 'connection.authorize_denied', 'provider', provider, { error: params.error ?? 'no_code' }).run();
    return `/connectors?error=${encodeURIComponent(`${provider} authorization was not granted.`)}`;
  }
  const adapter = adapterFor(provider);
  const verifier = await open(env, { ciphertext: st.verifier_ciphertext, nonce: st.verifier_nonce, key_version: st.key_version }, `oauth_state:${params.state}`);
  let tokens: TokenSet;
  let accounts;
  try {
    tokens = await adapter.exchangeCode(env, params.code, verifier, redirectUri(env, provider), fetchImpl);
    accounts = await adapter.discoverAccounts(env, tokens, fetchImpl);
  } catch (e) {
    const msg = e instanceof ProviderError ? e.message : 'The provider could not complete the connection.';
    log('warn', 'connection.callback_failed', { provider, request_id: requestId, kind: e instanceof ProviderError ? e.kind : 'unknown' });
    await auditStmt(env, actorLike, 'connection.failed', 'provider', provider, { message: msg }).run();
    return `/connectors?error=${encodeURIComponent(msg)}`;
  }
  if (!accounts.length) {
    await auditStmt(env, actorLike, 'connection.no_accounts', 'provider', provider).run();
    return `/connectors?error=${encodeURIComponent(`No eligible ${provider} accounts were found for this login.`)}`;
  }
  const ent = entitlementsFrom(await getSubscription(env, st.workspace_id));
  const perNetwork = Math.max(ent.products, 1);
  let activeCount = (await first<{ n: number }>(env, `SELECT COUNT(*) AS n FROM connections WHERE workspace_id = ? AND provider = ? AND state IN ('connected','expiring','reconnect_required','pending_review')`, st.workspace_id, provider))?.n ?? 0;
  const now = nowIso();
  for (const acct of accounts) {
    const existing = await first<{ id: string; state: string }>(env, 'SELECT id, state FROM connections WHERE workspace_id = ? AND provider = ? AND provider_account_id = ?', st.workspace_id, provider, acct.providerAccountId);
    const id = existing?.id ?? newId('con');
    const wasActive = existing && ['connected', 'expiring', 'reconnect_required', 'pending_review'].includes(existing.state);
    let state: ConnectionState = acct.capabilities.some((c) => c.status === 'available') ? 'connected' : acct.capabilities.some((c) => c.status === 'pending_review') ? 'pending_review' : 'restricted';
    let limited = false;
    if (!wasActive) {
      if (activeCount >= perNetwork) {
        limited = true;
        state = 'restricted';
      } else activeCount++;
    }
    const statements = [
      stmt(env, `INSERT INTO connections(id, workspace_id, provider, provider_account_id, account_name, account_type, state, granted_scopes, token_expires_at, last_verified_at, api_version, metadata_json, created_by, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(workspace_id, provider, provider_account_id) DO UPDATE SET account_name = excluded.account_name, account_type = excluded.account_type, state = excluded.state,
          granted_scopes = excluded.granted_scopes, token_expires_at = excluded.token_expires_at, last_verified_at = excluded.last_verified_at, api_version = excluded.api_version,
          metadata_json = excluded.metadata_json, updated_at = excluded.updated_at`,
        id, st.workspace_id, provider, acct.providerAccountId, acct.name.slice(0, 200), acct.type, state, JSON.stringify(tokens.scopes), tokens.expiresAt ?? null, now,
        provider === 'linkedin' ? env.LINKEDIN_API_VERSION ?? null : provider === 'facebook' || provider === 'instagram' ? env.META_GRAPH_VERSION ?? null : null,
        JSON.stringify(acct.metadata ?? {}), st.identity_id, now, now),
      stmt(env, 'DELETE FROM connection_capabilities WHERE workspace_id = ? AND connection_id = ?', st.workspace_id, id),
      ...acct.capabilities.map((c) => stmt(env, 'INSERT INTO connection_capabilities(workspace_id, connection_id, capability, status, detail, checked_at) VALUES (?,?,?,?,?,?)', st.workspace_id, id,
        c.capability, limited ? 'unavailable' : c.status,
        limited ? `Your plan includes ${perNetwork} ${provider} account(s) per network.` : c.detail, now)),
      await storeToken(env, st.workspace_id, id, 'access', tokens.accessToken, tokens.expiresAt),
      await storeToken(env, st.workspace_id, id, 'refresh', tokens.refreshToken, tokens.refreshExpiresAt),
      await storeToken(env, st.workspace_id, id, 'page_access', acct.accountAccessToken, null),
      auditStmt(env, actorLike, existing ? 'connection.reconnected' : 'connection.connected', 'connection', id, { provider, account_type: acct.type, scopes: tokens.scopes, state }),
    ];
    // A reconnect revives targets that were paused for reconnection; they still need an explicit reschedule
    // if their time passed, which the dispatcher enforces via the missed-window rule.
    if (existing && state === 'connected') {
      statements.push(stmt(env, `UPDATE targets SET status = 'scheduled', hold_reason = NULL, version = version + 1, updated_at = ? WHERE workspace_id = ? AND connection_id = ? AND status = 'reconnect_required' AND approval_required IS NULL`, now, st.workspace_id, id));
      statements.push(stmt(env, `UPDATE targets SET status = 'awaiting_approval', approval_id = NULL, hold_reason = NULL, version = version + 1, updated_at = ? WHERE workspace_id = ? AND connection_id = ? AND status = 'reconnect_required' AND approval_required IS NOT NULL`, now, st.workspace_id, id));
      statements.push(stmt(env, `INSERT INTO outbox(id, workspace_id, target_id, revision, kind, state, next_attempt_at, created_at, updated_at)
        SELECT 'obx_' || lower(hex(randomblob(10))), workspace_id, id, 1, 'dispatch', 'pending', due_at, ?, ? FROM targets WHERE workspace_id = ? AND connection_id = ? AND status = 'scheduled'
        ON CONFLICT(workspace_id, target_id, revision, kind) DO UPDATE SET state = 'pending', next_attempt_at = excluded.next_attempt_at, updated_at = excluded.updated_at`, now, now, st.workspace_id, id));
    }
    await env.DB.batch(statements);
  }
  return `/connectors?connected=${provider}`;
}

export async function loadConnectionRecord(env: Env, workspaceId: string, connectionId: string): Promise<{ record: ConnectionRecord; state: ConnectionState }> {
  const r = await first<ConnectionRow>(env, 'SELECT * FROM connections WHERE workspace_id = ? AND id = ?', workspaceId, connectionId);
  if (!r) throw notFound('Connection');
  return {
    state: r.state,
    record: {
      id: r.id,
      workspace_id: r.workspace_id,
      provider: r.provider,
      provider_account_id: r.provider_account_id,
      account_name: r.account_name,
      account_type: r.account_type,
      granted_scopes: parseJson<string[]>(r.granted_scopes, []),
      api_version: r.api_version,
      metadata: parseJson<Record<string, unknown>>(r.metadata_json, {}),
    },
  };
}

async function readToken(env: Env, workspaceId: string, connectionId: string, kind: 'access' | 'refresh' | 'page_access') {
  const row = await first<{ ciphertext: string; nonce: string; key_version: number; expires_at: string | null }>(env, 'SELECT ciphertext, nonce, key_version, expires_at FROM encrypted_credentials WHERE workspace_id = ? AND connection_id = ? AND kind = ?', workspaceId, connectionId, kind);
  if (!row) return null;
  return { value: await open(env, row, `${workspaceId}:${connectionId}:${kind}`), expires_at: row.expires_at };
}

export async function providerContext(env: Env, workspaceId: string, connectionId: string, correlationId: string, fetchImpl: FetchLike = fetch): Promise<ProviderContext> {
  const { record } = await loadConnectionRecord(env, workspaceId, connectionId);
  const access = await readToken(env, workspaceId, connectionId, 'access');
  if (!access) throw new ProviderError('reconnect_required', 'no_token', 'This account has no stored access. Reconnect it.');
  const refresh = await readToken(env, workspaceId, connectionId, 'refresh');
  const account = await readToken(env, workspaceId, connectionId, 'page_access');
  return { env, connection: record, tokens: { access: access.value, refresh: refresh?.value ?? null, account: account?.value ?? null, expiresAt: access.expires_at }, correlationId, fetch: fetchImpl };
}

/** Refresh tokens close to expiry. Must run under the workspace coordinator (single flight). */
export async function ensureFreshTokens(env: Env, ctx: ProviderContext, requestId: string): Promise<ProviderContext> {
  if (!ctx.tokens.expiresAt || new Date(ctx.tokens.expiresAt).getTime() - Date.now() > 10 * 60_000) return ctx;
  const result = await adapterFor(ctx.connection.provider).refreshOrReconnect(ctx);
  if (result.kind === 'reconnect_required') {
    await markReconnectRequired(env, ctx.connection.workspace_id, ctx.connection.id, result.reason, requestId);
    throw new ProviderError('reconnect_required', 'token_expired', result.reason);
  }
  const t = result.tokens;
  await env.DB.batch([
    await storeToken(env, ctx.connection.workspace_id, ctx.connection.id, 'access', t.accessToken, t.expiresAt),
    ...(t.refreshToken ? [await storeToken(env, ctx.connection.workspace_id, ctx.connection.id, 'refresh', t.refreshToken, t.refreshExpiresAt)] : []),
    stmt(env, `UPDATE connections SET token_expires_at = ?, last_verified_at = ?, state = CASE WHEN state IN ('expiring','connected') THEN 'connected' ELSE state END, updated_at = ? WHERE workspace_id = ? AND id = ?`,
      t.expiresAt ?? null, nowIso(), nowIso(), ctx.connection.workspace_id, ctx.connection.id),
    auditStmt(env, { workspaceId: ctx.connection.workspace_id, actorType: 'system', requestId }, 'connection.token_refreshed', 'connection', ctx.connection.id),
  ]);
  return { ...ctx, tokens: { ...ctx.tokens, access: t.accessToken, refresh: t.refreshToken ?? ctx.tokens.refresh, expiresAt: t.expiresAt ?? null } };
}

export async function markReconnectRequired(env: Env, workspaceId: string, connectionId: string, reason: string, requestId: string) {
  const now = nowIso();
  const r = await run(env, `UPDATE connections SET state = 'reconnect_required', updated_at = ? WHERE workspace_id = ? AND id = ? AND state <> 'reconnect_required'`, now, workspaceId, connectionId);
  if (r.meta.changes) {
    await auditStmt(env, { workspaceId, actorType: 'system', requestId }, 'connection.reconnect_required', 'connection', connectionId, { reason }).run();
    const c = await first<{ provider: string; account_name: string }>(env, 'SELECT provider, account_name FROM connections WHERE workspace_id = ? AND id = ?', workspaceId, connectionId);
    await notifyWorkspace(env, workspaceId, 'reconnect_required', `Reconnect ${c?.provider ?? 'an account'} in Ayonix-SNS`,
      `Ayonix-SNS lost access to ${c?.account_name ?? 'an account'} (${c?.provider ?? ''}). Scheduled posts for it are paused.\n\nReconnect: ${env.APP_ORIGIN}/connectors`, `reconnect:${connectionId}:${now.slice(0, 10)}`);
  }
}

export async function disconnect(env: Env, actor: Actor, connectionId: string) {
  authorize(actor, 'manage_connections');
  if (actor.via !== 'web') throw forbidden('Disconnect accounts on the Ayonix website');
  const { record } = await loadConnectionRecord(env, actor.workspaceId, connectionId);
  let revoked = false;
  try {
    const ctx = await providerContext(env, actor.workspaceId, connectionId, actor.requestId);
    revoked = (await adapterFor(record.provider).disconnect(ctx)).revoked;
  } catch (e) {
    log('warn', 'connection.revoke_failed', { provider: record.provider, request_id: actor.requestId, kind: e instanceof ProviderError ? e.kind : 'unknown' });
  }
  const now = nowIso();
  await env.DB.batch([
    stmt(env, 'DELETE FROM encrypted_credentials WHERE workspace_id = ? AND connection_id = ?', actor.workspaceId, connectionId),
    stmt(env, `UPDATE connections SET state = 'disconnected', token_expires_at = NULL, updated_at = ? WHERE workspace_id = ? AND id = ?`, now, actor.workspaceId, connectionId),
    stmt(env, `UPDATE connection_capabilities SET status = 'unavailable', detail = 'Disconnected', checked_at = ? WHERE workspace_id = ? AND connection_id = ?`, now, actor.workspaceId, connectionId),
    // Pending targets pause; published posts stay public (deleting them is a separate request).
    stmt(env, `UPDATE targets SET status = 'reconnect_required', hold_reason = 'disconnected', version = version + 1, updated_at = ? WHERE workspace_id = ? AND connection_id = ? AND status IN ('scheduled','queued','retry_wait','awaiting_approval')`, now, actor.workspaceId, connectionId),
    stmt(env, `UPDATE outbox SET state = 'done', updated_at = ? WHERE workspace_id = ? AND kind = 'dispatch' AND state IN ('pending','leased','enqueued') AND target_id IN (SELECT id FROM targets WHERE workspace_id = ? AND connection_id = ? AND status = 'reconnect_required')`, now, actor.workspaceId, actor.workspaceId, connectionId),
    auditStmt(env, actor, 'connection.disconnected', 'connection', connectionId, { provider: record.provider, revoked }),
  ]);
  return { connection_id: connectionId, revoked };
}

export async function refreshCapabilities(env: Env, actor: Actor, connectionId: string) {
  authorize(actor, 'manage_connections');
  const ctx = await providerContext(env, actor.workspaceId, connectionId, actor.requestId);
  let caps: CapabilityRow[];
  try {
    caps = await adapterFor(ctx.connection.provider).probeCapabilities(ctx);
  } catch (e) {
    if (e instanceof ProviderError && e.kind === 'reconnect_required') {
      await markReconnectRequired(env, actor.workspaceId, connectionId, e.message, actor.requestId);
      throw new AppError('conflict', 'The account needs reconnecting.');
    }
    throw new AppError('upstream_error', e instanceof ProviderError ? e.message : 'Capability check failed', { retryable: true });
  }
  const now = nowIso();
  await env.DB.batch([
    stmt(env, 'DELETE FROM connection_capabilities WHERE workspace_id = ? AND connection_id = ?', actor.workspaceId, connectionId),
    ...caps.map((c) => stmt(env, 'INSERT INTO connection_capabilities(workspace_id, connection_id, capability, status, detail, checked_at) VALUES (?,?,?,?,?,?)', actor.workspaceId, connectionId, c.capability, c.status, c.detail, now)),
    stmt(env, 'UPDATE connections SET last_verified_at = ?, updated_at = ? WHERE workspace_id = ? AND id = ?', now, now, actor.workspaceId, connectionId),
    auditStmt(env, actor, 'connection.capabilities_checked', 'connection', connectionId),
  ]);
  const row = await first<ConnectionRow>(env, 'SELECT * FROM connections WHERE workspace_id = ? AND id = ?', actor.workspaceId, connectionId);
  return toConnection(env, row!);
}

export function assertPlatform(p: string): Platform {
  if (!(PLATFORMS as readonly string[]).includes(p)) throw invalid('Unknown provider');
  return p as Platform;
}
