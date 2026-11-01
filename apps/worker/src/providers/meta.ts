// Shared Meta Graph API plumbing for the Facebook Pages and Instagram
// (Facebook Login path) adapters: Facebook Login, long-lived token exchange,
// granted-permission lookup, appsecret_proof and Graph error classification.
// Verified against developers.facebook.com on 2026-11-01 (examples use v26.0);
// the deployment's version comes from META_GRAPH_VERSION. See SOURCES.md.
import type { Env } from '../lib/env.js';
import { iso } from './http.js';
import { hmacSha256Hex, parseScopes, readJson, request, requireConfig, type Classifier } from './common.js';
import { ProviderError, type FetchLike, type TokenSet } from './types.js';

export const GRAPH = 'https://graph.facebook.com';
export const GRAPH_VIDEO = 'https://graph-video.facebook.com';
export const RUPLOAD = 'https://rupload.facebook.com/video-upload';

/** Meta throttling codes: app (4), user (17), page (32), custom (613), BUC (80001–80014). */
const RATE_CODES = new Set([4, 17, 32, 613]);

export function graphVersion(env: Env): string {
  const v = requireConfig(env.META_GRAPH_VERSION, 'META_GRAPH_VERSION');
  if (!/^v\d+\.\d+$/.test(v)) throw new ProviderError('capability', 'invalid_api_version', 'META_GRAPH_VERSION must look like v26.0.');
  return v;
}

export const graphMajor = (env: Env) => Number(graphVersion(env).slice(1).split('.')[0]);

export const metaClassify: Classifier = (err, body, status, creates) => {
  const e = body && typeof body === 'object' ? ((body as Record<string, unknown>).error as Record<string, unknown> | undefined) : undefined;
  if (!e) return err;
  const code = typeof e.code === 'number' ? e.code : Number(e.code);
  const sub = typeof e.error_subcode === 'number' ? e.error_subcode : null;
  const codeStr = String(Number.isFinite(code) ? code : err.code);
  const mk = (kind: ProviderError['kind'], retry: number | null = err.retryAfterSeconds) => new ProviderError(kind, sub ? `${codeStr}.${sub}` : codeStr, err.message, retry, status);
  if (code === 190 || code === 102 || code === 463 || code === 467) return mk('reconnect_required');
  if (RATE_CODES.has(code) || (code >= 80001 && code <= 80014)) return mk('rate_limited', err.retryAfterSeconds ?? 3600);
  if (code === 10 || (code >= 200 && code <= 299)) return mk('capability');
  if (code === 368) return mk('validation'); // blocked as abusive/spam
  if ((code === 1 || code === 2) && e.is_transient !== false) return mk(creates ? 'ambiguous' : 'transient');
  return err;
};

/** appsecret_proof = hex HMAC-SHA256(access_token, app_secret). */
export async function proof(env: Env, token: string): Promise<string> {
  return hmacSha256Hex(requireConfig(env.META_APP_SECRET, 'META_APP_SECRET'), token);
}

export interface GraphCall {
  env: Env;
  fetch: FetchLike;
  token: string;
  correlationId: string;
  provider: string;
}

/**
 * Graph request. The token travels in the Authorization header (never in a
 * URL); appsecret_proof is added to the query (GET/DELETE) or form body (POST).
 */
export async function graph<T>(
  c: GraphCall,
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  params: Record<string, string> = {},
  opts: { operation: string; creates?: boolean; host?: string; timeoutMs?: number } = { operation: 'graph' },
): Promise<T> {
  const appsecret_proof = await proof(c.env, c.token);
  const base = `${opts.host ?? GRAPH}/${graphVersion(c.env)}/${path.replace(/^\//, '')}`;
  const headers: Record<string, string> = { Authorization: `Bearer ${c.token}` };
  let url = base;
  let body: URLSearchParams | undefined;
  if (method === 'POST') {
    body = new URLSearchParams({ ...params, appsecret_proof });
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
  } else {
    const q = new URLSearchParams({ ...params, appsecret_proof });
    url = `${base}${base.includes('?') ? '&' : '?'}${q.toString()}`;
  }
  const res = await request(c.fetch, url, { method, headers, ...(body ? { body } : {}) }, {
    provider: c.provider,
    operation: opts.operation,
    correlationId: c.correlationId,
    creates: opts.creates ?? false,
    timeoutMs: opts.timeoutMs ?? 30_000,
    classify: metaClassify,
  });
  return readJson<T>(res);
}

export function facebookAuthorizeUrl(env: Env, input: { state: string; redirectUri: string }, scopes: string[]): string {
  // Facebook Login (manual flow) uses state + app secret on the server; PKCE is not used here.
  const q = new URLSearchParams({
    client_id: requireConfig(env.META_APP_ID, 'META_APP_ID'),
    redirect_uri: input.redirectUri,
    state: input.state,
    response_type: 'code',
    scope: scopes.join(','),
  });
  return `https://www.facebook.com/${graphVersion(env)}/dialog/oauth?${q.toString()}`;
}

async function oauthToken(env: Env, params: Record<string, string>, fetchImpl: FetchLike, provider: string, operation: string) {
  const res = await request(
    fetchImpl,
    `${GRAPH}/${graphVersion(env)}/oauth/access_token`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ ...params, client_id: requireConfig(env.META_APP_ID, 'META_APP_ID'), client_secret: requireConfig(env.META_APP_SECRET, 'META_APP_SECRET') }),
    },
    { provider, operation, correlationId: 'oauth', classify: (e, b, s, cr) => (e.status === 400 ? new ProviderError('reconnect_required', e.code, e.message, null, s) : metaClassify(e, b, s, cr)) },
  );
  const t = await readJson<{ access_token?: string; expires_in?: number }>(res);
  if (!t.access_token) throw new ProviderError('transient', 'invalid_token_response', 'Meta did not return an access token.');
  return t;
}

/** Granted permissions, read from the API rather than assumed. */
export async function grantedPermissions(env: Env, token: string, fetchImpl: FetchLike, provider: string): Promise<string[]> {
  const r = await graph<{ data?: Array<{ permission?: string; status?: string }> }>({ env, fetch: fetchImpl, token, correlationId: 'oauth', provider }, 'GET', 'me/permissions', {}, { operation: 'me.permissions' });
  return parseScopes((r.data ?? []).filter((p) => p.status === 'granted').map((p) => p.permission ?? ''));
}

/**
 * Code → short-lived user token → long-lived user token (fb_exchange_token,
 * about 60 days, no refresh grant). Scopes come from /me/permissions.
 */
export async function metaExchangeCode(env: Env, code: string, redirectUri: string, fetchImpl: FetchLike, provider: string): Promise<TokenSet> {
  const short = await oauthToken(env, { code, redirect_uri: redirectUri }, fetchImpl, provider, 'oauth.code');
  const long = await oauthToken(env, { grant_type: 'fb_exchange_token', fb_exchange_token: short.access_token! }, fetchImpl, provider, 'oauth.long_lived');
  const token = long.access_token!;
  const scopes = await grantedPermissions(env, token, fetchImpl, provider);
  const me = await graph<{ id?: string }>({ env, fetch: fetchImpl, token, correlationId: 'oauth', provider }, 'GET', 'me', { fields: 'id' }, { operation: 'me' });
  return { accessToken: token, refreshToken: null, expiresAt: iso(long.expires_in), refreshExpiresAt: null, scopes, subject: me.id ?? null };
}

const RECONNECT_WINDOW_MS = 7 * 24 * 3600 * 1000;

/**
 * Meta long-lived tokens cannot be refreshed server-side. Near expiry the user
 * must log in again; otherwise the current token is validated with /me.
 */
export async function metaRefreshOrReconnect(
  ctx: { env: Env; fetch: FetchLike; correlationId: string; tokens: { access: string; account: string | null; expiresAt: string | null }; connection: { granted_scopes: string[] } },
  provider: string,
): Promise<{ kind: 'refreshed'; tokens: TokenSet } | { kind: 'reconnect_required'; reason: string }> {
  const exp = ctx.tokens.expiresAt ? Date.parse(ctx.tokens.expiresAt) : NaN;
  if (Number.isFinite(exp) && exp - Date.now() < RECONNECT_WINDOW_MS) {
    return { kind: 'reconnect_required', reason: 'The Meta long-lived token expires within 7 days and cannot be refreshed; log in with Facebook again.' };
  }
  try {
    await graph({ env: ctx.env, fetch: ctx.fetch, token: ctx.tokens.access, correlationId: ctx.correlationId, provider }, 'GET', 'me', { fields: 'id' }, { operation: 'me.validate' });
  } catch (e) {
    if (e instanceof ProviderError && (e.kind === 'reconnect_required' || e.kind === 'capability')) return { kind: 'reconnect_required', reason: 'Meta rejected the stored token; log in with Facebook again.' };
    throw e;
  }
  // Not a new token: the existing long-lived token was validated and is returned unchanged.
  return { kind: 'refreshed', tokens: { accessToken: ctx.tokens.access, refreshToken: null, expiresAt: ctx.tokens.expiresAt, scopes: ctx.connection.granted_scopes, subject: null } };
}

/** DELETE /me/permissions revokes the app's grant (affects every Meta connection using that user token). */
export async function metaDisconnect(c: GraphCall): Promise<{ revoked: boolean }> {
  const r = await graph<unknown>(c, 'DELETE', 'me/permissions', {}, { operation: 'me.permissions.delete' });
  const ok = r === true || (typeof r === 'object' && r !== null && (r as { success?: unknown }).success === true);
  return { revoked: ok };
}

export const pageAccessToken = (t: { account: string | null }): string => {
  if (!t.account) throw new ProviderError('reconnect_required', 'missing_page_token', 'The Page access token is missing; reconnect the Page.');
  return t.account;
};
