// Authenticated MCP endpoint (Streamable HTTP, stateless JSON responses).
// Tool names, schemas, scopes and hints come verbatim from
// packages/contracts/mcp-tools.json. Every call re-validates the OAuth token's
// workspace membership and scopes; the same services back REST and MCP.
// No plans, upsells, checkout or payment tools exist on this surface.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { Validator, type Schema } from '@cfworker/json-schema';
import { insufficientScope, type OAuthResourceAuth } from '@cloudflare/workers-oauth-provider';
import { mcpTools } from '@ayonix/contracts';
import type { Platform, Role } from '@ayonix/contracts';
import type { Env } from '../lib/env.js';
import { mcpResource } from '../lib/env.js';
import { AppError } from '../lib/errors.js';
import { first } from '../lib/db.js';
import { log } from '../security/redact.js';
import type { Actor, McpScope } from '../services/context.js';
import * as ws from '../services/workspace.js';
import * as products from '../services/products.js';
import * as assets from '../services/assets.js';
import * as campaigns from '../services/campaigns.js';
import * as schedules from '../services/schedules.js';
import * as connections from '../services/connections.js';
import * as analytics from '../services/analytics.js';
import * as research from '../services/research.js';
import { approvalLink } from '../services/approvals.js';
import { mutate } from '../jobs/coordinator.js';

export interface McpProps {
  identityId: string;
  workspaceId: string;
}

type ToolContract = (typeof mcpTools.tools)[number];
const TOOLS = new Map<string, ToolContract>(mcpTools.tools.map((t) => [t.name, t]));
const validators = new Map<string, Validator>(mcpTools.tools.map((t) => [t.name, new Validator(t.inputSchema as unknown as Schema, '2020-12', false)]));

type Args = Record<string, unknown>;
type Handler = (env: Env, actor: Actor, args: Args) => Promise<unknown>;

const s = (a: Args, k: string) => (typeof a[k] === 'string' ? (a[k] as string) : undefined);

const HANDLERS: Record<string, Handler> = {
  get_workspace_status: async (env, actor) => {
    const w = await ws.workspaceSummary(env, actor);
    const conns = await connections.listConnections(env, actor);
    // Neutral entitlement summary. No pricing, no plan comparison, no purchase links.
    return {
      workspace: { id: w.id, name: w.name, timezone: w.timezone, role: w.role },
      entitlement: {
        active: w.entitlements.can_confirm_schedules,
        status: w.entitlements.status,
        publications_per_cycle: w.entitlements.posts_per_cycle,
        active_products: w.entitlements.products,
        auto_learn: w.entitlements.auto_learn,
        competitor_check: w.entitlements.competitor_check,
        similar_research: w.entitlements.similar_research,
        restriction: w.entitlements.can_confirm_schedules ? null : 'Scheduling is not available for this workspace right now.',
      },
      quota: w.quota,
      networks: conns.map((p) => ({ provider: p.provider, available_on_deployment: p.configured, connected_accounts: p.connections.filter((c) => ['connected', 'expiring'].includes(c.state)).length })),
    };
  },
  list_products: async (env, actor, a) => {
    const r = await products.listProducts(env, actor, s(a, 'cursor'));
    return {
      items: r.items.map((p) => ({
        id: p.id,
        name: p.name,
        status: p.status,
        version: p.version,
        approved_version: p.approved_version,
        audience: p.audience,
        language: p.language,
        tone: p.tone,
        approved_claims: p.claims.filter((c) => c.status === 'approved' && c.kind === 'claim').map((c) => c.text),
        prohibited_claims: p.claims.filter((c) => c.kind === 'prohibited').map((c) => c.text),
        proposed_claims_awaiting_review: p.claims.filter((c) => c.status === 'proposed').length,
      })),
      next_cursor: r.next_cursor,
    };
  },
  list_connections: async (env, actor) => {
    const list = await connections.listConnections(env, actor);
    return {
      networks: list.map((p) => ({
        provider: p.provider,
        available_on_deployment: p.configured,
        restriction: p.restriction,
        accounts: p.connections.map((c) => ({
          connection_id: c.id,
          account_name: c.account_name,
          account_type: c.account_type,
          state: c.state,
          token_expires_at: c.token_expires_at,
          capabilities: c.capabilities,
          next_action: ['reconnect_required', 'expiring'].includes(c.state) ? 'Reconnect this account in Ayonix Connectors.' : null,
        })),
      })),
    };
  },
  create_campaign_draft: (env, actor, a) => campaigns.createCampaign(env, actor, a as never),
  prepare_post: async (env, actor, a) => {
    const r = await campaigns.preparePost(env, actor, a as never);
    return { post_id: r.post_id, revision: r.revision, destinations: (r.destinations as campaigns.PreparedDestination[]).map((d) => ({ platform: d.platform, connection_id: d.connection_id, format: d.format, content_hash: d.content_hash, problems: d.problems })) };
  },
  preview_schedule: async (env, actor, a) => {
    const p = await schedules.previewSchedule(env, actor, a.entries as schedules.PreviewEntry[]);
    return {
      preview_token: p.preview_token,
      expires_at: p.expires_at,
      quota_cost: p.quota_cost,
      quota_available: p.quota.available,
      revisions: [...new Set(p.targets.map((t) => `${t.post_id}@${t.revision}`))],
      local_and_utc_times: p.targets.map((t) => ({ platform: t.platform, account: t.account_name, local: `${t.local_time} ${t.timezone} (UTC${t.utc_offset})`, utc: t.scheduled_at_utc })),
      targets: p.targets,
      approval_requirements: p.approval_requirements,
      blocking_problems: p.blocking_problems,
      confirm_instructions: p.preview_token ? 'Show the user these exact times, destinations and content, then call confirm_schedule with confirmed=true only after they agree.' : 'Fix the blocking problems, then preview again.',
    };
  },
  confirm_schedule: async (env, actor, a) => {
    const r = await mutate<{ schedule_id: string; version: number; target_ids: string[]; states: Record<string, string> }>(env, actor.workspaceId, { op: 'confirm', actor, input: a as never });
    const approvals: Record<string, string> = {};
    for (const [id, state] of Object.entries(r.states)) if (state === 'awaiting_approval') approvals[id] = await approvalLink(env, actor.workspaceId, id);
    return { ...r, approval_urls: approvals, note: Object.keys(approvals).length ? 'TikTok targets stay awaiting_approval until the creator completes the hosted approval page.' : 'Ayonix will publish at the scheduled times even after this conversation ends.' };
  },
  list_schedule: (env, actor, a) => schedules.listSchedule(env, actor, { cursor: s(a, 'cursor'), product_id: s(a, 'product_id'), status: s(a, 'status'), from_utc: s(a, 'from_utc'), to_utc: s(a, 'to_utc') }),
  cancel_schedule: (env, actor, a) => mutate(env, actor.workspaceId, { op: 'cancel', actor, input: a as never }),
  get_post_status: async (env, actor, a) => {
    const r = await schedules.getPostStatus(env, actor, s(a, 'post_id')!);
    return {
      post_id: r.post_id,
      targets: r.targets.map((t) => ({
        target_id: t.id,
        platform: t.platform,
        account: t.account_name,
        status: t.status,
        published: t.status === 'published',
        due_at: t.due_at,
        receipt: t.receipt ? { provider_id: t.receipt.remote_id, verified_at: t.receipt.verified_at } : null,
        verified_url: t.status === 'published' ? t.receipt?.url ?? null : null,
        error: t.error,
        next_action: t.next_action,
      })),
    };
  },
  get_report: async (env, actor, a) => {
    const r = await analytics.analytics(env, actor, { from_utc: s(a, 'from_utc')!, to_utc: s(a, 'to_utc')!, ...(s(a, 'product_id') ? { product_id: s(a, 'product_id')! } : {}), ...(Array.isArray(a.platforms) && a.platforms.length ? { platforms: a.platforms as Platform[] } : {}) });
    return {
      period: r.period,
      metrics: r.totals,
      by_channel: r.by_channel,
      top_posts: r.top_posts,
      source_names: r.by_channel.filter((c) => c.available).map((c) => c.platform),
      retrieved_at: r.freshness,
      definitions: r.definitions,
      unavailable_fields: r.by_channel.filter((c) => !c.available).map((c) => `${c.platform}: all metrics`),
    };
  },
  save_product_profile: (env, actor, a) => products.saveProduct(env, actor, a as never, s(a, 'idempotency_key')),
  approve_product_profile: (env, actor, a) => {
    if (a.confirmed !== true) throw new AppError('invalid_request', 'confirmed must be true');
    return products.approveProduct(env, actor, s(a, 'product_id')!, a.expected_version as number, s(a, 'idempotency_key'));
  },
  ingest_media: (env, actor, a) => assets.ingestAsset(env, actor, a as never),
  list_assets: (env, actor, a) => assets.listAssets(env, actor, { product_id: s(a, 'product_id'), cursor: s(a, 'cursor') }),
  request_product_research: (env, actor, a) => research.requestResearch(env, actor, a as never),
  get_research_status: (env, actor, a) => research.getResearch(env, actor, s(a, 'job_id')!),
};

export function toolDescriptors() {
  return mcpTools.tools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
    annotations: t.annotations,
    securitySchemes: t.securitySchemes,
    _meta: { securitySchemes: t.securitySchemes },
  }));
}

function buildServer(env: Env, actor: Actor) {
  const server = new Server({ name: 'ayonix-sns', version: mcpTools.contractVersion }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: toolDescriptors() as never }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name;
    const contract = TOOLS.get(name);
    const handler = HANDLERS[name];
    if (!contract || !handler) return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: { code: 'unknown_tool', message: `Unknown tool ${name}` } }) }] };
    const args = (req.params.arguments ?? {}) as Args;
    const v = validators.get(name)!.validate(args);
    if (!v.valid) {
      const fields = v.errors.slice(0, 10).map((e) => `${e.instanceLocation}: ${e.error}`);
      return { isError: true, content: [{ type: 'text', text: JSON.stringify({ request_id: actor.requestId, error: { code: 'invalid_request', message: 'Arguments do not match the tool schema', field_errors: fields } }) }] };
    }
    try {
      const result = await handler(env, actor, args);
      const payload = { request_id: actor.requestId, status: 'ok', workspace_id: actor.workspaceId, result };
      return { content: [{ type: 'text', text: JSON.stringify(payload) }], structuredContent: payload };
    } catch (e) {
      if (e instanceof AppError) {
        const payload = { request_id: actor.requestId, status: 'error', workspace_id: actor.workspaceId, error: { code: e.code, message: e.message, retryable: e.extra.retryable ?? e.status >= 500, ...(e.extra.field_errors ? { field_errors: e.extra.field_errors } : {}), ...(e.extra.current_version !== undefined ? { current_version: e.extra.current_version } : {}) } };
        return { isError: true, content: [{ type: 'text', text: JSON.stringify(payload) }], structuredContent: payload };
      }
      log('error', 'mcp.tool_error', { tool: name, request_id: actor.requestId, error: e instanceof Error ? e.message : String(e) });
      const payload = { request_id: actor.requestId, status: 'error', error: { code: 'internal', message: 'Something went wrong. Nothing was confirmed by this call.', retryable: true } };
      return { isError: true, content: [{ type: 'text', text: JSON.stringify(payload) }], structuredContent: payload };
    }
  });
  return server;
}

const ALL_SCOPES: McpScope[] = ['sns:read', 'sns:draft', 'sns:schedule', 'sns:cancel'];

function invalidToken(env: Env, description: string): Response {
  return new Response(JSON.stringify({ error: 'invalid_token', error_description: description }), {
    status: 401,
    headers: {
      'content-type': 'application/json',
      'www-authenticate': `Bearer error="invalid_token", error_description="${description}", resource_metadata="${env.APP_ORIGIN}/.well-known/oauth-protected-resource/mcp"`,
    },
  });
}

/** apiHandler for OAuthProvider: token is already verified for this resource. */
export async function handleMcp(request: Request, env: Env, ctx: ExecutionContext & { props?: McpProps; auth?: OAuthResourceAuth }): Promise<Response> {
  const requestId = request.headers.get('x-request-id') ?? crypto.randomUUID();
  const props = ctx.props;
  const auth = ctx.auth;
  if (!props?.identityId || !props.workspaceId || !auth) return invalidToken(env, 'Token is missing workspace context');
  if (auth.audience && !(Array.isArray(auth.audience) ? auth.audience : [auth.audience]).includes(mcpResource(env))) return invalidToken(env, 'Token audience mismatch');
  const origin = request.headers.get('origin');
  if (origin && !/^https:\/\/([a-z0-9-]+\.)*(chatgpt\.com|openai\.com)$/.test(origin) && origin !== env.APP_ORIGIN) {
    return new Response(JSON.stringify({ error: 'forbidden_origin' }), { status: 403, headers: { 'content-type': 'application/json' } });
  }
  // Membership is re-checked on every request: a removed member loses access immediately.
  const m = await first<{ role: Role; email: string; status: string }>(
    env,
    `SELECT m.role, i.email, w.status FROM memberships m JOIN identities i ON i.id = m.identity_id JOIN workspaces w ON w.id = m.workspace_id WHERE m.workspace_id = ? AND m.identity_id = ?`,
    props.workspaceId, props.identityId,
  );
  if (!m || !['active', 'suspended'].includes(m.status)) return invalidToken(env, 'Workspace access was revoked');
  const scopes = (auth.scope ?? []).filter((x): x is McpScope => (ALL_SCOPES as string[]).includes(x));

  // Peek at a tools/call to enforce the contract's required scope with a proper step-up challenge.
  if (request.method === 'POST') {
    const body = (await request.clone().json().catch(() => null)) as { method?: string; params?: { name?: string } } | Array<unknown> | null;
    const calls = Array.isArray(body) ? body : body ? [body] : [];
    for (const call of calls as Array<{ method?: string; params?: { name?: string } }>) {
      if (call?.method === 'tools/call' && call.params?.name) {
        const required = TOOLS.get(call.params.name)?.requiredScope as McpScope | undefined;
        if (required && !scopes.includes(required)) return insufficientScope(auth, [...new Set(['sns:read', required])], `This tool needs ${required}`);
      }
    }
  }
  const actor: Actor = { identityId: props.identityId, email: m.email, workspaceId: props.workspaceId, role: m.role, via: 'mcp', scopes, requestId };
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  const server = buildServer(env, actor);
  await server.connect(transport);
  const res = await transport.handleRequest(request);
  ctx.waitUntil(server.close());
  return res;
}
