// Default (non-MCP) handler: website auth, REST API, provider OAuth
// callbacks, MCP consent page, webhooks, health and signed downloads.
// Static app assets are served by the ASSETS binding.
import { Hono } from 'hono';
import { AuthorizationError, CimdFetchError } from '@cloudflare/workers-oauth-provider';
import type { Env } from './lib/env.js';
import { configProblems, isLocal } from './lib/env.js';
import { AppError } from './lib/errors.js';
import { all, first, run } from './lib/db.js';
import { createAuth } from './auth/better-auth.js';
import { getSessionIdentity } from './auth/session.js';
import { api, errorResponse } from './routes/api.js';
import { completeAuthorization, assertPlatform } from './services/connections.js';
import { serveSignedMedia } from './services/assets.js';
import { serveReport } from './services/reports.js';
import { serveExport } from './services/privacy.js';
import { handleStripeWebhook } from './services/billing.js';
import { b64url, hmacHex, timingSafeEqual, unb64url } from './security/crypto.js';
import { log } from './security/redact.js';
import { nowIso } from './lib/ids.js';
import type { McpProps } from './mcp/server.js';

type Vars = { requestId: string; identity: null };
export const app = new Hono<{ Bindings: Env; Variables: Vars }>();

const SECURITY_HEADERS: Record<string, string> = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
  'strict-transport-security': 'max-age=31536000; includeSubDomains',
};

app.use('*', async (c, next) => {
  const requestId = c.req.header('cf-ray') ?? crypto.randomUUID();
  c.set('requestId', requestId);
  const problems = configProblems(c.env);
  if (problems.length && !c.req.path.startsWith('/health/')) {
    log('error', 'config.invalid', { problems });
    return c.json({ error: { code: 'not_configured', message: 'This deployment is missing required configuration.', request_id: requestId, retryable: false } }, 503);
  }
  await next();
  // Responses from ASSETS.fetch or Response.redirect have immutable headers.
  try {
    c.res.headers.set('x-request-id', requestId);
  } catch {
    c.res = new Response(c.res.body, c.res);
    c.res.headers.set('x-request-id', requestId);
  }
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) c.res.headers.set(k, v);
});

app.onError((err, c) => errorResponse(err, c.get('requestId')));

// Website authentication (Better Auth)
app.on(['GET', 'POST'], '/api/auth/*', (c) => createAuth(c.env).handler(c.req.raw));
app.route('/api/v1', api);

// Social provider OAuth callbacks
app.get('/oauth/:provider/callback', async (c) => {
  const provider = assertPlatform(c.req.param('provider'));
  const identity = await getSessionIdentity(c.env, c.req.raw.headers);
  const path = await completeAuthorization(c.env, provider, { code: c.req.query('code') ?? null, state: c.req.query('state') ?? null, error: c.req.query('error') ?? null }, identity?.id ?? null, c.get('requestId'));
  return c.redirect(path, 302);
});

// Health
app.get('/health/live', (c) => c.json({ status: 'ok' }));
app.get('/health/ready', async (c) => {
  const checks: Record<string, string> = {};
  try {
    await first(c.env, 'SELECT 1');
    const v = await first<{ value: string }>(c.env, `SELECT value FROM schema_meta WHERE key = 'schema_version'`);
    checks.database = `ok (schema ${v?.value ?? '?'})`;
  } catch {
    checks.database = 'error';
  }
  checks.config = configProblems(c.env).length ? 'incomplete' : 'ok';
  const ok = Object.values(checks).every((v) => v.startsWith('ok'));
  return c.json({ status: ok ? 'ready' : 'degraded', checks }, ok ? 200 : 503);
});

// Signed downloads
app.get('/u/media/:token', (c) => serveSignedMedia(c.env, c.req.param('token'), c.req.raw));
app.get('/u/report/:token', (c) => serveReport(c.env, c.req.param('token')));
app.get('/u/export/:token', (c) => serveExport(c.env, c.req.param('token')));

// Stripe webhook: raw body signature verification.
app.post('/webhooks/stripe', async (c) => {
  const raw = await c.req.text();
  const r = await handleStripeWebhook(c.env, raw, c.req.header('stripe-signature') ?? null, c.get('requestId'));
  return c.json(r.body, r.status as 200);
});

/** Meta signed_request: base64url(sig).base64url(payload), HMAC-SHA256 with the app secret. */
async function verifyMetaSignedRequest(env: Env, signed: string): Promise<{ user_id?: string } | null> {
  if (!env.META_APP_SECRET) return null;
  const [sig, payload] = signed.split('.');
  if (!sig || !payload) return null;
  const expected = await hmacHex(env.META_APP_SECRET, payload);
  const got = [...unb64url(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
  if (!timingSafeEqual(expected, got)) return null;
  const data = JSON.parse(new TextDecoder().decode(unb64url(payload))) as { algorithm?: string; user_id?: string };
  return data.algorithm?.toUpperCase() === 'HMAC-SHA256' ? data : null;
}

async function revokeMetaUser(env: Env, userId: string, reason: string, requestId: string) {
  const conns = await all<{ id: string; workspace_id: string }>(env, `SELECT id, workspace_id FROM connections WHERE provider IN ('facebook','instagram') AND json_extract(metadata_json, '$.meta_user_id') = ?`, userId);
  for (const c of conns) {
    await run(env, 'DELETE FROM encrypted_credentials WHERE workspace_id = ? AND connection_id = ?', c.workspace_id, c.id);
    await run(env, `UPDATE connections SET state = 'disconnected', updated_at = ? WHERE workspace_id = ? AND id = ?`, nowIso(), c.workspace_id, c.id);
    await run(env, `UPDATE targets SET status = 'reconnect_required', hold_reason = ?, version = version + 1, updated_at = ? WHERE workspace_id = ? AND connection_id = ? AND status IN ('scheduled','queued','retry_wait')`, reason, nowIso(), c.workspace_id, c.id);
    log('info', 'meta.revoked', { reason, request_id: requestId });
  }
  return conns.length;
}

// Meta deauthorization and data deletion callbacks.
app.post('/webhooks/meta/deauthorize', async (c) => {
  const form = await c.req.formData();
  const data = await verifyMetaSignedRequest(c.env, String(form.get('signed_request') ?? ''));
  if (!data?.user_id) return c.json({ error: 'invalid_signed_request' }, 400);
  await revokeMetaUser(c.env, data.user_id, 'deauthorized', c.get('requestId'));
  return c.json({ received: true });
});
app.post('/webhooks/meta/data-deletion', async (c) => {
  const form = await c.req.formData();
  const data = await verifyMetaSignedRequest(c.env, String(form.get('signed_request') ?? ''));
  if (!data?.user_id) return c.json({ error: 'invalid_signed_request' }, 400);
  await revokeMetaUser(c.env, data.user_id, 'data_deletion', c.get('requestId'));
  const code = b64url(crypto.getRandomValues(new Uint8Array(12)));
  return c.json({ url: `${c.env.APP_ORIGIN}/privacy?deletion=${code}`, confirmation_code: code });
});

// Development-only mailbox: shows locally captured emails (verification/reset links).
app.get('/dev/mailbox', async (c) => {
  if (!isLocal(c.env)) return c.json({ error: 'not_found' }, 404);
  const rows = await all(c.env, `SELECT id, recipient, template, created_at, dev_body FROM sent_notifications WHERE transport = 'dev_mailbox' ORDER BY created_at DESC LIMIT 20`);
  return c.json({ note: 'Development mailbox. Not a delivery transport; deployed environments require EMAIL_API_KEY.', messages: rows });
});

// ---------------------------------------------------------------------------
// MCP OAuth consent (authorization endpoint). Sign in with the existing Ayonix
// account, choose a workspace and scopes. No plans, checkout or purchase.

const esc = (v: string) => v.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
const SCOPE_TEXT: Record<string, string> = {
  'sns:read': 'Read products, connections, schedules and reports',
  'sns:draft': 'Create content drafts and product profiles',
  'sns:schedule': 'Confirm schedules you approve',
  'sns:cancel': 'Cancel schedules',
};

function page(title: string, inner: string, headers?: Headers): Response {
  const h = headers ?? new Headers();
  h.set('content-type', 'text/html; charset=utf-8');
  h.set('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https:; frame-ancestors 'none'; base-uri 'none'");
  h.set('x-frame-options', 'DENY');
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>:root{color-scheme:light dark;--bg:#F5F8FC;--card:#fff;--ink:#10233F;--muted:#5B6B82;--azure:#176BFF;--line:#E3E9F2}
@media (prefers-color-scheme:dark){:root{--bg:#0B1628;--card:#12223A;--ink:#EAF1FB;--muted:#9FB0C8;--line:#22385A}}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 Inter,system-ui,sans-serif}main{max-width:560px;margin:40px auto;padding:0 16px}
.card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:28px}h1{font-size:24px;margin:0 0 4px}p{color:var(--muted)}
label{display:flex;gap:10px;align-items:flex-start;padding:10px 0;min-height:44px}select{width:100%;min-height:44px;border-radius:10px;border:1px solid var(--line);background:var(--card);color:var(--ink);padding:0 10px;font:inherit}
.row{display:flex;gap:12px;margin-top:20px}button{min-height:44px;border-radius:10px;padding:0 18px;font:600 15px Inter,system-ui,sans-serif;border:0;cursor:pointer}
.primary{background:var(--azure);color:#fff}.secondary{background:#EAF2FF;color:var(--azure)}.warn{background:#FFF4E5;color:#7A4B00;border-radius:10px;padding:10px 12px}
.logo{display:inline-grid;place-items:center;width:36px;height:36px;border-radius:10px;background:var(--azure);color:#fff;font-weight:800;margin-right:8px}:focus-visible{outline:3px solid var(--azure);outline-offset:2px}</style></head>
<body><main><p><span class="logo">A</span><strong>Ayonix-SNS</strong></p><div class="card">${inner}</div></main></body></html>`, { status: 200, headers: h });
}

app.get('/authorize', async (c) => {
  const oauth = c.env.OAUTH_PROVIDER;
  try {
    const request = await oauth.parseAuthRequest(c.req.raw);
    const identity = await getSessionIdentity(c.env, c.req.raw.headers);
    if (!identity) return c.redirect(`/login?next=${encodeURIComponent(c.req.url.replace(c.env.APP_ORIGIN, ''))}`, 302);
    if (!identity.emailVerified) return c.redirect('/verify-email', 302);
    const workspaces = await all<{ id: string; name: string; role: string }>(c.env, `SELECT w.id, w.name, m.role FROM memberships m JOIN workspaces w ON w.id = m.workspace_id WHERE m.identity_id = ? AND w.status = 'active' ORDER BY w.created_at`, identity.id);
    const details = await oauth.describeConsent(request);
    const consent = await oauth.beginConsent(request);
    const requested = details.scope.length ? details.scope.filter((s) => SCOPE_TEXT[s]) : Object.keys(SCOPE_TEXT);
    const scopes = requested
      .map((s) => `<label><input type="checkbox" name="scope" value="${esc(s)}" checked> <span><strong>${esc(s)}</strong><br>${esc(SCOPE_TEXT[s]!)}</span></label>`)
      .join('');
    const origin = details.clientDomain ? `Published by <strong>${esc(details.clientDomain)}</strong>.` : 'This app registered itself; its name is not verified.';
    const body = workspaces.length
      ? `<form method="post" action="/authorize"><input type="hidden" name="handle" value="${esc(consent.handle)}">
<label style="display:block">Workspace<br><select name="workspace_id" required>${workspaces.map((w) => `<option value="${esc(w.id)}">${esc(w.name)} (${esc(w.role)})</option>`).join('')}</select></label>
<p>${esc(details.clientName)} requests permission to:</p>${scopes}
<div class="row"><button class="primary" name="decision" value="approve">Approve connection</button><button class="secondary" name="decision" value="deny">Deny</button></div></form>`
      : `<p class="warn">Your account has no workspace yet. Finish setting up your workspace on the Ayonix website, then connect again.</p>
<form method="post" action="/authorize"><input type="hidden" name="handle" value="${esc(consent.handle)}"><button class="secondary" name="decision" value="deny">Cancel</button></form>`;
    return page(`Connect ${details.clientName}`, `<h1>Connect to ${esc(details.clientName)}</h1>
<p>Signed in as ${esc(identity.email)}. ${origin} Access will be sent to <strong>${esc(details.redirectHost)}</strong>.</p>
${details.redirectIsLoopback ? '<p class="warn">This sends access to an app on your computer. Continue only if you just started signing in from it.</p>' : ''}
${body}<p style="font-size:13px">No payment details or social access tokens are shared with ${esc(details.clientName)}. You can revoke access at any time.</p>`, consent.headers);
  } catch (e) {
    if (e instanceof AuthorizationError && e.redirectTo) return Response.redirect(e.redirectTo, 302);
    if (e instanceof AuthorizationError || e instanceof CimdFetchError) {
      return page('Authorization error', `<h1>Cannot connect</h1><p>${esc(e instanceof AuthorizationError ? e.description ?? 'Invalid request' : 'This app could not be verified.')}</p>`);
    }
    throw e;
  }
});

app.post('/authorize', async (c) => {
  const oauth = c.env.OAUTH_PROVIDER;
  try {
    const form = await c.req.formData();
    const handle = String(form.get('handle') ?? '');
    if (form.get('decision') !== 'approve') {
      const denied = await oauth.denyConsent(c.req.raw, handle);
      return new Response(null, { status: 302, headers: denied.headers });
    }
    const identity = await getSessionIdentity(c.env, c.req.raw.headers);
    if (!identity?.emailVerified) throw new AppError('unauthenticated', 'Sign in again to approve.');
    const workspaceId = String(form.get('workspace_id') ?? '');
    const member = await first(c.env, `SELECT 1 FROM memberships m JOIN workspaces w ON w.id = m.workspace_id WHERE m.workspace_id = ? AND m.identity_id = ? AND w.status = 'active'`, workspaceId, identity.id);
    if (!member) return page('Authorization error', '<h1>Cannot connect</h1><p>You are not a member of that workspace.</p>');
    const scope = form.getAll('scope').map(String).filter((s) => SCOPE_TEXT[s]);
    if (!scope.length) return page('Authorization error', '<h1>Choose at least one permission</h1><p>Go back and select what ChatGPT may do.</p>');
    const approved = await oauth.approveConsent(c.req.raw, handle, { scope });
    const props: McpProps = { identityId: identity.id, workspaceId };
    const { redirectTo } = await oauth.completeAuthorization({ request: approved.request, userId: identity.id, metadata: { workspaceId }, scope: approved.request.scope, props });
    await run(c.env, `INSERT INTO audit_events(id, workspace_id, actor_identity_id, actor_type, action, object_type, object_id, detail_json, request_id, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      crypto.randomUUID(), workspaceId, identity.id, 'user', 'mcp.authorized', 'oauth_client', approved.request.clientId, JSON.stringify({ scope: approved.request.scope }), c.get('requestId'), nowIso());
    approved.headers.set('location', redirectTo);
    return new Response(null, { status: 302, headers: approved.headers });
  } catch (e) {
    if (e instanceof AuthorizationError || e instanceof CimdFetchError) {
      return page('Authorization error', `<h1>This page expired</h1><p>Start connecting again from ChatGPT.</p>`);
    }
    throw e;
  }
});

// Everything else: the React app.
app.all('*', async (c) => {
  if (!c.env.ASSETS) return c.json({ error: { code: 'not_found', message: 'Not found', request_id: c.get('requestId'), retryable: false } }, 404);
  return c.env.ASSETS.fetch(c.req.raw);
});
