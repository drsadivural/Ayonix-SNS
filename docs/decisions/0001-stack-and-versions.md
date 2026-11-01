# 0001 — Stack, versions and integration decisions

Date: 2026-11-01. Status: accepted for implementation; external gates open.

## Runtime and hosting
- Cloudflare Workers (`compatibility_date` 2026-10-01, `nodejs_compat`, `global_fetch_strictly_public`), D1 (system of record), R2 (media/reports/exports, `ws/{workspace}/` prefixes), KV (OAuth grants/tokens of the MCP authorization server, stored hashed/encrypted by the library), Queues (publish + jobs, each with DLQ), one Durable Object per workspace (`WorkspaceCoordinator`) serializing schedule mutations and dispatch claims, Cron every minute (outbox scan, lease sweep, lag alerts) and daily (metrics, retention).
- Resource IDs are not committed. `wrangler deploy` auto-provisions D1/R2/KV and writes IDs back; queues are created by `scripts/provision.sh`.

## Pinned versions (package-lock.json is authoritative)
wrangler 4.156.0 · hono 4.13.16 · better-auth 1.7.14 · @cloudflare/workers-oauth-provider 1.2.4 · @modelcontextprotocol/sdk 1.32.2 · @cfworker/json-schema 4.1.4 · stripe 23.1.0 (API 2026-10-28.endive) · @anthropic-ai/sdk 1.3.0 · zod 4.4.3 · typescript 6.0.3 (typescript-eslint 8.72.1 does not support TS 7 yet) · vitest 4.1.12 · @cloudflare/vitest-plugin 1.4.11 (successor of the deprecated vitest-pool-workers) · React 19.3.1 · Vite 8.3.5.

## Auth: two separate flows
- Website: Better Auth (email + password, mandatory email verification, reset, D1 sessions, optional Google OIDC). No custom password crypto.
- MCP: `@cloudflare/workers-oauth-provider` as OAuth 2.1 authorization server + protected resource: PKCE S256 only, RFC 8707 resource-bound tokens (audience `${APP_ORIGIN}/mcp`), RFC 9728 metadata, CIMD enabled (ChatGPT's preferred registration) with DCR at `/oauth/register` for compatibility. The consent page requires a Better Auth session, shows workspace choice and scopes, and contains no plans or checkout. Grant props carry `{identityId, workspaceId}`; membership and scopes are re-validated on every MCP request.
- The exact ChatGPT redirect URI is validated from the client's CIMD/DCR metadata, never hardcoded.

## Billing
Stripe Checkout + Customer Portal on the website only. Server quotes from `packages/contracts/pricing.json` (byte-identical to the handoff copy, enforced by tests and preflight). Custom plans get server-created recurring Prices keyed by canonical configuration hash. Entitlements change only from signature-verified webhooks reconciled against canonical Stripe objects (order-independent). Upgrades: `always_invoice` + `error_if_incomplete`, allowance difference only. Downgrades: price change with `proration_behavior: none`, entitlement change at next period. Automatic tax is not enabled — needs Ayonix tax registration decision.

## Policy finding (OpenAI) — BLOCKER recorded
The handoff's research (handoff/docs/03-CHATGPT.md, 30 Oct 2026) says current plugin guidelines prohibit selling digital subscriptions from the plugin. Implemented: independent website acquisition/billing; ChatGPT connector for existing entitled accounts; no purchase tool, plan text or checkout in OAuth. The original install→register→pay flow remains **BLOCKED** (MCP-04) pending written OpenAI enablement or a policy change. I did not re-fetch the OpenAI guidelines in this run; re-verify before submission.

## Providers
Direct official APIs only (see `apps/worker/src/providers/SOURCES.md` for what was verified on 2026-11-01 and what was not). Notable decisions: LinkedIn organization scopes behind `LINKEDIN_ENABLE_ORGANIZATIONS`; Instagram via the Facebook Login path; TikTok video via FILE_UPLOAD (no verified-domain requirement), photos via PULL_FROM_URL (media domain must be verified with TikTok); YouTube native `publishAt` scheduling off by default (needs `youtube.force-ssl` to cancel).

## Research
Brave Search API (RESEARCH_API_KEY) + Anthropic Messages API (`claude-opus-5-5`, structured JSON output, server-side refusal fallback `fallbacks: "default"`). Untrusted page text is delimited, the model has no tools, citations are verified server-side against fetched text, results stay proposed until human review. Caps from docs/01-PRODUCT.md.

## Scheduling semantics
- Preview token: HMAC-signed, 10 min, binds workspace, identity, content hashes, targets, times, period, entitlement and policy versions.
- Confirm: one D1 batch = quota reservation (CHECK aborts overspend) + targets + ledger + outbox + idempotency record. `batch_guards` makes conditional updates abort the batch (compare-and-swap).
- Future billing cycles cannot be reserved: times beyond the current period are rejected with an explanation (simplest honest form of "tentative"; promotion after renewal is a follow-up).
- Posts missed by more than 6 hours (outage, payment hold) fail with `missed_window` instead of burst-publishing.
- Crash after submission start → lease expiry → `outcome_unknown` → reconciliation from provider receipts or owner resolution. Never re-submitted.
