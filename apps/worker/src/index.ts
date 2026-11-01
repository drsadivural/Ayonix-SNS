// Worker entry: OAuth 2.1 authorization server + protected MCP resource
// (workers-oauth-provider), the default app handler, queue consumers and the
// cron-driven durable scheduler.
import { OAuthProvider } from '@cloudflare/workers-oauth-provider';
import type { Env } from './lib/env.js';
import { app } from './app.js';
import { handleMcp } from './mcp/server.js';
import { handleQueueBatch } from './jobs/queue.js';
import { handleScheduled } from './jobs/cron.js';

export { WorkspaceCoordinator } from './jobs/coordinator.js';

function provider(env: Env) {
  return new OAuthProvider<Env>({
    apiRoute: '/mcp',
    apiHandler: { fetch: handleMcp as never },
    defaultHandler: { fetch: (req: Request, e: Env, ctx: ExecutionContext) => app.fetch(req, e, ctx) } as never,
    authorizeEndpoint: '/authorize',
    tokenEndpoint: '/oauth/token',
    clientRegistrationEndpoint: '/oauth/register',
    clientIdMetadataDocumentEnabled: true,
    scopesSupported: ['sns:read', 'sns:draft', 'sns:schedule', 'sns:cancel'],
    requiredScopes: ['sns:read'],
    resourceMetadata: { resource: `${env.APP_ORIGIN}/mcp`, authorization_servers: [env.APP_ORIGIN], resource_name: 'Ayonix-SNS' },
    accessTokenTTL: 3600,
    refreshTokenTTL: 30 * 86400,
  } as never);
}

let cached: { origin: string; p: OAuthProvider<Env> } | null = null;

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    if (!cached || cached.origin !== env.APP_ORIGIN) cached = { origin: env.APP_ORIGIN, p: provider(env) };
    return cached.p.fetch(request, env, ctx);
  },
  queue: handleQueueBatch,
  scheduled: handleScheduled,
} satisfies ExportedHandler<Env>;
