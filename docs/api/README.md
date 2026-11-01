# API

- REST: `/api/v1/*` — routes in `apps/worker/src/routes/api.ts`, response types in `packages/contracts/src/api.ts`. Session cookie auth (Better Auth at `/api/auth/*`), `x-workspace-id` selects a workspace among the caller's memberships, mutations require a same-origin `Origin` header.
- Errors: `{ error: { code, message, request_id, field_errors?, retryable, retry_after_seconds?, current_version?, details? } }` with 400/401/403/404/409/422/429/502/503.
- MCP: `POST /mcp` (Streamable HTTP, JSON responses). Tools exactly as `packages/contracts/mcp-tools.json`. OAuth discovery: `/.well-known/oauth-protected-resource/mcp`, `/.well-known/oauth-authorization-server`; endpoints `/authorize`, `/oauth/token`, `/oauth/register`.
- Webhooks: `/webhooks/stripe`, `/webhooks/meta/deauthorize`, `/webhooks/meta/data-deletion`.
- Signed downloads: `/u/media/:token` (provider pull, ≤6h), `/u/report/:token` (15 min), `/u/export/:token` (15 min).
