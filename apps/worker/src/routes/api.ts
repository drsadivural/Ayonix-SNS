// REST API /api/v1. Every route resolves the actor from a verified session +
// membership; mutations require a same-origin Origin header (CSRF) on top of
// SameSite cookies. Errors use the common envelope; failures never return 200.
import { Hono, type Context } from 'hono';
import type { Platform, Role } from '@ayonix/contracts';
import type { Env } from '../lib/env.js';
import { AppError, invalid, toErrorBody } from '../lib/errors.js';
import { log } from '../security/redact.js';
import { getSessionIdentity, isFresh, webActor, type SessionIdentity } from '../auth/session.js';
import type { Actor } from '../services/context.js';
import * as ws from '../services/workspace.js';
import * as products from '../services/products.js';
import * as assets from '../services/assets.js';
import * as campaigns from '../services/campaigns.js';
import * as schedules from '../services/schedules.js';
import * as connections from '../services/connections.js';
import * as billing from '../services/billing.js';
import * as analytics from '../services/analytics.js';
import * as reports from '../services/reports.js';
import * as research from '../services/research.js';
import * as privacy from '../services/privacy.js';
import { listEvents } from '../services/audit.js';
import { approvalLink } from '../services/approvals.js';
import { verifyToken } from '../security/crypto.js';
import { mutate } from '../jobs/coordinator.js';

type Vars = { requestId: string; identity: SessionIdentity | null };
type C = Context<{ Bindings: Env; Variables: Vars }>;

export const api = new Hono<{ Bindings: Env; Variables: Vars }>();

api.use('*', async (c, next) => {
  const method = c.req.method;
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method) && !/^\/api\/v1\/assets\/[^/]+\/content$/.test(c.req.path)) {
    const origin = c.req.header('origin');
    if (origin !== c.env.APP_ORIGIN) throw new AppError('forbidden', 'Cross-site request blocked');
  }
  c.set('identity', await getSessionIdentity(c.env, c.req.raw.headers));
  await next();
});

function identity(c: C): SessionIdentity {
  const i = c.get('identity');
  if (!i) throw new AppError('unauthenticated', 'Sign in to continue');
  return i;
}

async function actor(c: C): Promise<Actor> {
  return webActor(c.env, identity(c), c.req.header('x-workspace-id') ?? null, c.get('requestId'));
}

async function body<T = Record<string, unknown>>(c: C): Promise<T> {
  try {
    const b = await c.req.json();
    if (!b || typeof b !== 'object' || Array.isArray(b)) throw new Error();
    return b as T;
  } catch {
    throw invalid('Request body must be a JSON object');
  }
}

const q = (c: C, k: string) => c.req.query(k) || undefined;
const qNum = (c: C, k: string) => (c.req.query(k) ? Number(c.req.query(k)) : undefined);

// --- identity & workspace -------------------------------------------------
api.get('/me', async (c) => c.json(await ws.getMe(c.env, identity(c))));
api.post('/workspaces', async (c) => {
  const i = identity(c);
  if (!i.emailVerified) throw new AppError('forbidden', 'Verify your email address first.');
  return c.json(await ws.createWorkspace(c.env, i, await body(c), c.get('requestId')), 201);
});
api.get('/workspace', async (c) => c.json(await ws.workspaceSummary(c.env, await actor(c))));
api.patch('/workspace', async (c) => c.json(await ws.updateWorkspace(c.env, await actor(c), await body(c))));
api.post('/workspace/trial', async (c) => c.json(await ws.startTrial(c.env, await actor(c))));
api.get('/members', async (c) => c.json(await ws.listMembers(c.env, await actor(c))));
api.post('/members', async (c) => c.json(await ws.inviteMember(c.env, await actor(c), await body(c)), 201));
api.patch('/members/:id', async (c) => {
  const b = await body<{ role: Role }>(c);
  await ws.changeRole(c.env, await actor(c), c.req.param('id'), b.role);
  return c.json(await ws.listMembers(c.env, await actor(c)));
});
api.delete('/members/:id', async (c) => {
  await ws.removeMember(c.env, await actor(c), c.req.param('id'));
  return c.body(null, 204);
});
api.delete('/invitations/:id', async (c) => {
  await ws.revokeInvitation(c.env, await actor(c), c.req.param('id'));
  return c.body(null, 204);
});
api.post('/invitations/accept', async (c) => c.json(await ws.acceptInvitation(c.env, identity(c), (await body<{ token: string }>(c)).token, c.get('requestId'))));
api.get('/notification-preferences', async (c) => c.json(await ws.getPreferences(c.env, await actor(c))));
api.put('/notification-preferences', async (c) => c.json(await ws.setPreferences(c.env, await actor(c), (await body<{ preferences: never[] }>(c)).preferences ?? [])));
api.get('/events', async (c) => c.json(await listEvents(c.env, await actor(c), q(c, 'cursor'))));

// --- products & research --------------------------------------------------
api.get('/products', async (c) => c.json(await products.listProducts(c.env, await actor(c), q(c, 'cursor'))));
api.post('/products', async (c) => c.json(await products.saveProduct(c.env, await actor(c), { ...(await body<products.ProductInput>(c)), product_id: undefined }), 201));
api.get('/products/:id', async (c) => c.json(await products.getProduct(c.env, await actor(c), c.req.param('id'))));
api.patch('/products/:id', async (c) => c.json(await products.saveProduct(c.env, await actor(c), { ...(await body<products.ProductInput>(c)), product_id: c.req.param('id') })));
api.post('/products/:id/approve', async (c) => c.json(await products.approveProduct(c.env, await actor(c), c.req.param('id'), Number((await body<{ expected_version: number }>(c)).expected_version))));
api.post('/products/:id/active', async (c) => c.json(await products.setProductActive(c.env, await actor(c), c.req.param('id'), Boolean((await body<{ active: boolean }>(c)).active))));
api.post('/products/:id/claims/:claim', async (c) => c.json(await products.reviewClaim(c.env, await actor(c), c.req.param('id'), c.req.param('claim'), (await body<{ decision: 'approved' | 'rejected' }>(c)).decision)));
for (const [path, kind] of [['learn', 'auto_learn'], ['competitors', 'competitor_check'], ['research', 'similar_research']] as const) {
  api.post(`/products/:id/${path}`, async (c) => {
    const b = await body<{ source_urls?: string[]; question?: string; idempotency_key?: string }>(c);
    return c.json(await research.requestResearch(c.env, await actor(c), { product_id: c.req.param('id'), kind, source_urls: b.source_urls, question: b.question, idempotency_key: b.idempotency_key ?? crypto.randomUUID() }), 202);
  });
}
api.get('/products/:id/research', async (c) => c.json(await research.listResearch(c.env, await actor(c), c.req.param('id'))));
api.get('/research/:id', async (c) => c.json(await research.getResearch(c.env, await actor(c), c.req.param('id'))));

// --- assets ---------------------------------------------------------------
api.post('/assets/upload-intent', async (c) => c.json(await assets.createUploadIntent(c.env, await actor(c), await body(c)), 201));
api.put('/assets/:id/content', async (c) => {
  const token = c.req.query('token');
  if (!token) throw new AppError('unauthenticated', 'Upload token required');
  return c.json(await assets.receiveUpload(c.env, c.req.param('id'), token, c.req.raw));
});
api.post('/assets/:id/complete', async (c) => c.json(await assets.completeAsset(c.env, await actor(c), c.req.param('id'))));
api.post('/assets/:id/page-intent', async (c) => {
  const b = await body<{ token: string; mime: string; bytes: number }>(c);
  return c.json(await assets.uploadIntentFromPage(c.env, await actor(c), c.req.param('id'), b.token, b));
});
api.post('/assets/ingest', async (c) => c.json(await assets.ingestAsset(c.env, await actor(c), await body(c)), 201));
api.get('/assets', async (c) => c.json(await assets.listAssets(c.env, await actor(c), { product_id: q(c, 'product_id'), cursor: q(c, 'cursor'), limit: qNum(c, 'limit') })));
api.get('/assets/:id', async (c) => c.json(await assets.getAsset(c.env, await actor(c), c.req.param('id'))));
api.get('/assets/:id/preview', async (c) => {
  const a = await actor(c);
  await assets.getAsset(c.env, a, c.req.param('id'));
  return c.json({ url: await assets.signedMediaUrl(c.env, a.workspaceId, c.req.param('id'), 600) });
});

// --- campaigns, posts & schedules -----------------------------------------
api.get('/campaigns', async (c) => c.json(await campaigns.listCampaigns(c.env, await actor(c), q(c, 'product_id'))));
api.post('/campaigns', async (c) => c.json(await campaigns.createCampaign(c.env, await actor(c), await body(c)), 201));
api.post('/posts', async (c) => c.json(await campaigns.preparePost(c.env, await actor(c), await body(c)), 201));
api.get('/posts/:id', async (c) => c.json(await campaigns.getPost(c.env, await actor(c), c.req.param('id'))));
api.get('/posts/:id/status', async (c) => c.json(await schedules.getPostStatus(c.env, await actor(c), c.req.param('id'))));
api.post('/schedules/preview', async (c) => c.json(await schedules.previewSchedule(c.env, await actor(c), (await body<{ entries: schedules.PreviewEntry[] }>(c)).entries)));
api.post('/schedules/confirm', async (c) => {
  const a = await actor(c);
  return c.json(await mutate(c.env, a.workspaceId, { op: 'confirm', actor: a, input: await body(c) }), 201);
});
api.get('/schedules', async (c) =>
  c.json(await schedules.listSchedule(c.env, await actor(c), { cursor: q(c, 'cursor'), product_id: q(c, 'product_id'), status: q(c, 'status'), platform: q(c, 'platform'), from_utc: q(c, 'from'), to_utc: q(c, 'to'), limit: qNum(c, 'limit') })),
);
api.post('/schedules/:id/cancel', async (c) => {
  const a = await actor(c);
  const b = await body<{ expected_version: number; idempotency_key: string }>(c);
  return c.json(await mutate(c.env, a.workspaceId, { op: 'cancel', actor: a, input: { schedule_id: c.req.param('id'), expected_version: Number(b.expected_version), idempotency_key: b.idempotency_key } }));
});
api.get('/targets/:id', async (c) => c.json(await schedules.getTarget(c.env, await actor(c), c.req.param('id'))));
api.get('/targets/:id/events', async (c) => c.json(await schedules.targetEvents(c.env, await actor(c), c.req.param('id'))));
api.patch('/targets/:id', async (c) => {
  const a = await actor(c);
  return c.json(await mutate(c.env, a.workspaceId, { op: 'reschedule', actor: a, targetId: c.req.param('id'), input: await body(c) }));
});
api.post('/targets/:id/resolve', async (c) => {
  const a = await actor(c);
  return c.json(await mutate(c.env, a.workspaceId, { op: 'resolve', actor: a, targetId: c.req.param('id'), input: await body(c) }));
});
// TikTok hosted approval (requires a signed-in member; optional signed handoff link)
api.get('/targets/:id/tiktok-approval', async (c) => {
  const a = await actor(c);
  const handoff = c.req.query('handoff');
  if (handoff) {
    const h = await verifyToken<{ ws: string; target: string }>(c.env, 'approval-link', handoff);
    if (h.ws !== a.workspaceId || h.target !== c.req.param('id')) throw new AppError('forbidden', 'This approval link belongs to a different workspace.');
  }
  return c.json(await mutate(c.env, a.workspaceId, { op: 'approval_context', actor: a, targetId: c.req.param('id') }));
});
api.post('/targets/:id/tiktok-approval', async (c) => {
  const a = await actor(c);
  return c.json(await mutate(c.env, a.workspaceId, { op: 'approve', actor: a, targetId: c.req.param('id'), input: await body(c) }));
});
api.post('/targets/:id/return-to-draft', async (c) => {
  const a = await actor(c);
  return c.json(await mutate(c.env, a.workspaceId, { op: 'return_to_draft', actor: a, targetId: c.req.param('id') }));
});
api.get('/targets/:id/approval-link', async (c) => {
  const a = await actor(c);
  await schedules.getTarget(c.env, a, c.req.param('id'));
  return c.json({ url: await approvalLink(c.env, a.workspaceId, c.req.param('id')) });
});

// --- connections ----------------------------------------------------------
api.get('/connections', async (c) => c.json(await connections.listConnections(c.env, await actor(c))));
api.post('/connections/:provider/authorize', async (c) => {
  const b = await c.req.json().catch(() => ({})) as { reconnect_connection_id?: string };
  return c.json(await connections.startAuthorization(c.env, await actor(c), connections.assertPlatform(c.req.param('provider')) as Platform, b.reconnect_connection_id));
});
api.delete('/connections/:id', async (c) => c.json(await connections.disconnect(c.env, await actor(c), c.req.param('id'))));
api.post('/connections/:id/probe', async (c) => c.json(await connections.refreshCapabilities(c.env, await actor(c), c.req.param('id'))));

// --- analytics & reports --------------------------------------------------
function analyticsQuery(c: C) {
  const to = q(c, 'to') ?? new Date().toISOString();
  const from = q(c, 'from') ?? new Date(new Date(to).getTime() - 30 * 86400_000).toISOString();
  const platforms = q(c, 'platforms')?.split(',').filter(Boolean) as Platform[] | undefined;
  return { from_utc: from, to_utc: to, ...(q(c, 'product_id') ? { product_id: q(c, 'product_id')! } : {}), ...(platforms ? { platforms } : {}) };
}
api.get('/analytics', async (c) => c.json(await analytics.analytics(c.env, await actor(c), analyticsQuery(c))));
api.get('/reports', async (c) => c.json(await reports.listReports(c.env, await actor(c))));
api.post('/reports', async (c) => c.json(await reports.requestReport(c.env, await actor(c), await body(c)), 202));
api.get('/reports/:id', async (c) => c.json(await reports.getReport(c.env, await actor(c), c.req.param('id'))));

// --- billing (website only) -----------------------------------------------
api.get('/billing/catalog', async (c) => {
  identity(c);
  return c.json(billing.catalog());
});
api.get('/billing/subscription', async (c) => c.json(await billing.subscriptionView(c.env, await actor(c))));
api.get('/billing/invoices', async (c) => c.json(await billing.listInvoices(c.env, await actor(c))));
api.post('/billing/quote', async (c) => c.json(await billing.createQuote(c.env, await actor(c), await body(c))));
api.post('/billing/checkout', async (c) => c.json(await billing.checkout(c.env, await actor(c), await body(c))));
api.post('/billing/portal', async (c) => c.json(await billing.portal(c.env, await actor(c))));

// --- privacy --------------------------------------------------------------
api.post('/privacy/export', async (c) => c.json(await privacy.requestPrivacyJob(c.env, await actor(c), 'export', isFresh(identity(c))), 202));
api.post('/privacy/delete', async (c) => {
  const b = await body<{ confirm_workspace_name?: string }>(c);
  const a = await actor(c);
  const w = await ws.workspaceSummary(c.env, a);
  if (b.confirm_workspace_name !== w.name) throw invalid('Type the workspace name to confirm deletion', { confirm_workspace_name: 'Does not match' });
  return c.json(await privacy.requestPrivacyJob(c.env, a, 'delete', isFresh(identity(c))), 202);
});
api.get('/privacy/:id', async (c) => c.json(await privacy.getPrivacyJob(c.env, await actor(c), c.req.param('id'))));

api.notFound((c) => c.json(toErrorBody(new AppError('not_found', 'Not found'), c.get('requestId')), 404));

export function errorResponse(err: unknown, requestId: string): Response {
  if (err instanceof AppError) {
    const headers: Record<string, string> = { 'content-type': 'application/json', 'x-request-id': requestId };
    if (err.extra.retry_after_seconds) headers['retry-after'] = String(err.extra.retry_after_seconds);
    return new Response(JSON.stringify(toErrorBody(err, requestId)), { status: err.status, headers });
  }
  log('error', 'api.unhandled', { request_id: requestId, error: err instanceof Error ? err.message : String(err) });
  return new Response(JSON.stringify(toErrorBody(new AppError('internal', 'Something went wrong. Try again.'), requestId)), { status: 500, headers: { 'content-type': 'application/json', 'x-request-id': requestId } });
}
api.onError((err, c) => errorResponse(err, c.get('requestId')));
