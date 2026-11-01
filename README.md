# Ayonix-SNS

Plan in ChatGPT. Publish with Ayonix. A Cloudflare Workers SaaS that lets a business register on the Ayonix website, subscribe, connect LinkedIn / Facebook Pages / Instagram Professional / TikTok / YouTube, and schedule posts — from the web app or from ChatGPT through an authenticated MCP connector. Ayonix's own durable scheduler publishes at the chosen time, even after the conversation closes.

> **Status: PARTIAL.** The application is implemented and its automated tests pass locally. Live provider publishing, Stripe sandbox billing, real email, staging deployment and the ChatGPT directory are **BLOCKED** on operator credentials and external approvals. See [evidence/STATUS.md](evidence/STATUS.md) for PASS/FAIL/BLOCKED per acceptance requirement.

## Layout
```
apps/web/          React + Vite app (five menus + auth, onboarding, composer, approvals)
apps/worker/       Worker: REST /api/v1, MCP /mcp, OAuth, webhooks, scheduler, queues
  src/services/    business services shared by REST and MCP
  src/providers/   LinkedIn, Facebook, Instagram, TikTok, YouTube adapters (official APIs)
  src/jobs/        coordinator Durable Object, outbox cron, queue consumers, dispatcher
  test/            workerd contract/integration tests (real local D1/R2/KV/Queues/DO)
packages/domain/   pricing, quotas, scheduling/DST, validation (ported from handoff reference)
packages/contracts/ pricing.json, mcp-tools.json, shared API types
migrations/        D1 migrations
tests/             unit (provider contract tests), integration (migrations on SQLite)
scripts/           preflight, gen-secrets, provision, release, restore, verify-live
handoff/           the original delivery package (design, docs, contracts, reference tests)
docs/              decisions, runbooks, API notes
evidence/          acceptance matrix and run evidence
```

## Quick start (local)
```bash
npm ci
node scripts/gen-secrets.mjs
npm run db:migrate:local
npm run build -w @ayonix/web
npm run dev            # http://localhost:8787
```
Verification emails appear at `http://localhost:8787/dev/mailbox` until EMAIL_API_KEY is set.

## Verify
```bash
npm run typecheck && npm run lint && npm test && npm run build
```

## Deploy
See [docs/runbooks/operations.md](docs/runbooks/operations.md) and [handoff/docs/09-OPERATOR-SETUP.md](handoff/docs/09-OPERATOR-SETUP.md). Production deploys, real charges and live customer posts require operator authorization.

## Commercial constraint
Subscriptions are sold only on the independent website. The ChatGPT connector serves existing entitled accounts and contains no plans, upsells or checkout, per the OpenAI plugin policy researched in the handoff. The originally requested install→subscribe-in-ChatGPT flow is recorded as an external policy BLOCKER.
