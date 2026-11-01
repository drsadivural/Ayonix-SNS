# Operations runbook

## Local development
```bash
npm ci
node scripts/gen-secrets.mjs        # writes .dev.vars (never commit)
npm run db:migrate:local
npm run build -w @ayonix/web
npm run dev                         # wrangler dev on http://localhost:8787
```
Without EMAIL_API_KEY, verification/reset emails land in the development mailbox: `GET /dev/mailbox` (local/test only; deployed environments refuse to start without email).

## Staging / production
- Provision: `scripts/provision-staging.sh` (needs Cloudflare access + domain decision).
- Release: `scripts/release.sh staging|production` — tests, D1 export backup, forward-compatible migrations, deploy.
- Smoke: `node scripts/verify-live.mjs https://<origin>`.
- Rollback code: `npx wrangler rollback [--env staging]`. Schema migrations are additive; never roll the database back destructively.
- Restore exercise: `scripts/restore.sh <backup.sql>` into an isolated database; check counts, `PRAGMA foreign_key_check`, quota invariant, and decrypt one credential with the current key.

## Provider callbacks to register
- OAuth redirect: `${APP_ORIGIN}/oauth/{linkedin|facebook|instagram|tiktok|youtube}/callback`
- Stripe webhook: `${APP_ORIGIN}/webhooks/stripe` (events: checkout.session.*, customer.subscription.*, invoice.*)
- Meta deauthorize: `${APP_ORIGIN}/webhooks/meta/deauthorize`; data deletion: `${APP_ORIGIN}/webhooks/meta/data-deletion`
- MCP server URL for ChatGPT: `${APP_ORIGIN}/mcp`

## Alerts (structured log events)
`alert.outcome_unknown`, `alert.unknown_outcomes` (>15 min), `alert.dispatch_lag` (>5 min late), `alert.publish_dlq`, `alert.unknown_requires_operator`, `email.failed`, `stripe.apply_failed`, `billing.unknown_price`. Route Workers Logs / Logpush to the paging tool; delivery must be tested (OPS-03 is BLOCKED until then).

## Outcome unknown
1. Open the target in Dashboard → details; check the account on the network.
2. Owner/admin records the result (“not published” releases quota; “published” needs the provider post ID + URL).
3. Never re-queue manually; the dispatcher refuses to resubmit unknown targets by design.

## Dead-letter redrive
DLQ messages are logged and acknowledged, not replayed. Durable state lives in the outbox; an operator fixes the cause and re-arms the outbox row (`state='pending'`) only after checking target state, reservation, consent freshness and the real provider outcome. Record the reason in audit events.

## Token key rotation
1. Generate a new 32-byte key; set `TOKEN_ENCRYPTION_PREVIOUS_KEYS` to `{"<old version>":"<old key>"}` and `TOKEN_ENCRYPTION_KEY`/`_VERSION` to the new one.
2. New writes use the new version; reads fall back by `key_version`. Re-encrypt by refreshing tokens (refresh flow rewrites credentials) or a one-off job; remove the old key when no rows reference it.

## Retention (proposed defaults; approve before publishing privacy terms)
Raw research 90 days, reports 30 days, OAuth states 1 day, idempotency records 30 days, dev mailbox bodies 7 days. Implemented in the daily cron.
