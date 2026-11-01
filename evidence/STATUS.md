# Verification status

Generated 2026-11-01T06:14:19.940Z at commit 4f96e15ca9884c3b614cba9c1763874d5c62ef2f by `node scripts/evidence.mjs`.

**Overall: PARTIAL.** The application is implemented and verified locally (workerd with real local D1/R2/KV/Queues/Durable Objects). No staging deployment, social provider app, Stripe sandbox, email sender, research/model credential or ChatGPT test workspace was available in this run, so every live gate is BLOCKED. The original ChatGPT install→subscribe flow is an external policy BLOCKER (MCP-04).

Counts: BLOCKED 34, PASS 4 (of 38).

## Commands
| Check | Command | Exit | Tests passed |
|---|---|---:|---:|
| typecheck | `npm run typecheck` | 0 |  |
| lint | `npm run lint` | 0 |  |
| unit + provider contract + migration tests | `npx vitest run --project unit` | 0 | 117 |
| workerd contract/integration tests | `npm run test -w @ayonix/worker` | 0 | 46 |
| handoff reference tests | `npm run test:reference` | 0 |  |
| web tests | `npm run test -w @ayonix/web` | 0 | 22 |
| web build | `npm run build -w @ayonix/web` | 0 |  |
| worker bundle (dry run) | `npx wrangler deploy --dry-run --outdir /tmp/ayonix-worker-dryrun` | 0 |  |

## Requirements
| ID | Status | Environment | Evidence / blocker |
|---|---|---|---|
| AUTH-01 | BLOCKED | not-provisioned | Local contract evidence only: apps/worker/test/http.test.ts runs register → verify (dev mailbox) → sign in → workspace through the real Worker; reset/logout not yet exercised end-to-end. **Blocker:** Verified email sender (EMAIL_API_KEY/EMAIL_FROM) and Staging deployment, scoped Cloudflare access and domain (docs/09-OPERATOR-SETUP.md) |
| AUTH-02 | BLOCKED | not-provisioned | Local contract evidence only: scheduling.test.ts, assets-products.test.ts and http.test.ts (MCP access revoked immediately after membership removal) pass locally. **Blocker:** Staging deployment, scoped Cloudflare access and domain (docs/09-OPERATOR-SETUP.md) |
| TEN-01 | BLOCKED | not-provisioned | Local contract evidence only: scheduling.test.ts tenancy cases and approvals-reports.test.ts (foreign report ID) pass locally; signed URL tamper test passes. **Blocker:** Staging deployment, scoped Cloudflare access and domain (docs/09-OPERATOR-SETUP.md) |
| BILL-01 | BLOCKED | not-provisioned | Local contract evidence only: Quote amounts and webhook-driven entitlements verified with a Stripe API double (billing.test.ts). **Blocker:** Stripe account, sandbox keys, Price IDs, webhook secret; approved tax/refund policy |
| BILL-02 | PASS | local-workerd (Miniflare D1/R2/KV/Queues/DO) | Min 4900, max exactly 100000 cents, 27800 example, tampered fields/Price IDs rejected; MCP actors cannot quote (packages/domain/test/pricing.test.ts; apps/worker/test/billing.test.ts) |
| BILL-03 | BLOCKED | not-provisioned | Not executed: requires staging and external accounts. **Blocker:** Stripe sandbox configuration and authorized test cards |
| BILL-04 | BLOCKED | not-provisioned | Local contract evidence only: Forged signature rejected; duplicate event idempotent; stale event cannot restore canceled access (billing.test.ts with test-signed events). **Blocker:** Stripe sandbox webhook endpoint on staging |
| QUOTA-01 | PASS | local-workerd (Miniflare D1/R2/KV/Queues/DO) | 6 parallel confirmations for 1 unit → exactly 1 reservation (direct D1 and via coordinator DO); failing multi-target batch leaves no rows (apps/worker/test/scheduling.test.ts) |
| QUOTA-02 | PASS | local-workerd (Miniflare D1/R2/KV/Queues/DO) | Retry after 429 commits once; validation failure releases; ambiguous keeps reservation; cancel before submit releases exactly once (apps/worker/test/dispatch.test.ts; scheduling.test.ts) |
| QUOTA-03 | BLOCKED | not-provisioned | Local contract evidence only: Upgrade grants difference only and downgrade waits for renewal (billing.test.ts double); trial 5 publications once (http.test.ts); future-cycle times rejected. **Blocker:** Stripe sandbox renewal cycle on staging |
| CONN-01 | BLOCKED | not-provisioned | Local contract evidence only: Adapter OAuth URL/exchange contract tests with fetch doubles (tests/unit/providers). **Blocker:** Developer apps and approvals for LinkedIn, Meta, TikTok, Google; callback URLs on staging |
| LI-01 | BLOCKED | not-provisioned | Not executed: requires staging and external accounts. **Blocker:** LinkedIn app with approved products, test member/Page |
| FB-01 | BLOCKED | not-provisioned | Not executed: requires staging and external accounts. **Blocker:** Meta app review, test Page |
| IG-01 | BLOCKED | not-provisioned | Not executed: requires staging and external accounts. **Blocker:** Meta app review, Instagram professional test account |
| TT-01 | BLOCKED | not-provisioned | Local contract evidence only: Hosted approval rules (no default privacy, disabled interactions, stale creator settings rejected) pass with a TikTok API double (approvals-reports.test.ts). **Blocker:** TikTok Content Posting API approval/audit, test creator |
| YT-01 | BLOCKED | not-provisioned | Not executed: requires staging and external accounts. **Blocker:** Google Cloud project with YouTube Data API + OAuth verification, test channel |
| MEDIA-01 | BLOCKED | not-provisioned | Local contract evidence only: Content-based validation, token binding, SSRF guard and signed-URL tamper checks pass locally (assets-products.test.ts). **Blocker:** Staging deployment, scoped Cloudflare access and domain (docs/09-OPERATOR-SETUP.md) |
| SCH-01 | BLOCKED | not-provisioned | Local contract evidence only: Duplicate queue delivery submits once; cron leases and enqueues outbox (dispatch.test.ts, provider double). **Blocker:** Staging deployment, scoped Cloudflare access and domain (docs/09-OPERATOR-SETUP.md) and authorized provider account |
| SCH-02 | BLOCKED | not-provisioned | Local contract evidence only: Claim-lease expiry → outcome_unknown, never resubmitted; fencing rejects stale settlement (dispatch.test.ts, failure injection). **Blocker:** Live provider account on staging |
| SCH-03 | PASS | local-workerd (Miniflare D1/R2/KV/Queues/DO) | Nonexistent 2026-10-04 02:30 rejected; ambiguous 2026-04-05 02:30 needs a choice; AEST/AEDT offsets correct (packages/domain/test/rules.test.ts) |
| SCH-04 | BLOCKED | not-provisioned | Local contract evidence only: Revision change invalidates preview; reschedule resets TikTok approval; post-submission cancel is honest (scheduling.test.ts). **Blocker:** Staging deployment, scoped Cloudflare access and domain (docs/09-OPERATOR-SETUP.md) |
| SCH-05 | BLOCKED | not-provisioned | Local contract evidence only: Retry-After honored; revocation → reconnect_required (dispatch.test.ts). **Blocker:** Live provider accounts and alert transport on staging |
| MCP-01 | BLOCKED | not-provisioned | Local contract evidence only: DCR client → PKCE consent → resource-bound token → tools/list (17 tools) → tools/call, schema validation and insufficient_scope step-up pass through the real Worker (http.test.ts). **Blocker:** Deployed HTTPS origin and ChatGPT developer test setup |
| MCP-02 | BLOCKED | not-provisioned | Not executed: requires staging and external accounts. **Blocker:** ChatGPT test workspace + live provider account on staging |
| MCP-03 | BLOCKED | not-provisioned | Local contract evidence only: Tool list has no purchase tools; consent HTML contains no price/plan/checkout text; get_workspace_status returns no purchase links (http.test.ts). **Blocker:** Review in real ChatGPT on staging |
| MCP-04 | BLOCKED | not-provisioned | Not executed: requires staging and external accounts. **Blocker:** EXTERNAL POLICY BLOCKER: OpenAI digital-subscription restriction (handoff/docs/03-CHATGPT.md); directory submission not made |
| AI-01 | BLOCKED | not-provisioned | Not executed: requires staging and external accounts. **Blocker:** RESEARCH_API_KEY and AI_PROVIDER_API_KEY with budget limits |
| AI-02 | BLOCKED | not-provisioned | Not executed: requires staging and external accounts. **Blocker:** Licensed search API and model credentials |
| AI-03 | BLOCKED | not-provisioned | Local contract evidence only: Design: no tools given to the model, server-side citation check, proposals never auto-approved, per-cycle caps enforced in requestResearch. **Blocker:** Model credentials for adversarial test set |
| MET-01 | BLOCKED | not-provisioned | Not executed: requires staging and external accounts. **Blocker:** Live provider accounts with analytics scopes |
| REP-01 | BLOCKED | not-provisioned | Local contract evidence only: CSV (formula-injection guarded, "Not available" for null) and PDF generated into R2 and downloaded via signed URL; cross-tenant report access denied (approvals-reports.test.ts). **Blocker:** Real provider metrics on staging |
| UI-01 | BLOCKED | not-provisioned | Local contract evidence only: Web tests assert five nav items in sidebar and mobile nav; headless Chromium run against local wrangler dev shows API-driven empty/unconfigured states, no example data (evidence/screenshots/). **Blocker:** Staging deployment, scoped Cloudflare access and domain (docs/09-OPERATOR-SETUP.md) |
| UI-02 | BLOCKED | not-provisioned | Local contract evidence only: Partial local capture: 15 screenshots (dashboard/billings at 1440/834/390, five menus light, dashboard/connectors dark, auth/onboarding) with no horizontal overflow detected (evidence/screenshots/). **Blocker:** Full matrix (all screens × 1440/834/390 × light/dark × loading/error) against staging with controlled test data; contrast and keyboard audit |
| OPS-01 | BLOCKED | local-workerd (Miniflare D1/R2/KV/Queues/DO) | typecheck: exit 0; lint: exit 0; unit + provider contract + migration tests: exit 0; workerd contract/integration tests: exit 0; handoff reference tests: exit 0; web tests: exit 0; web build: exit 0; worker bundle (dry run): exit 0 **Blocker:** Deployed smoke checks (scripts/verify-live.mjs) require staging |
| OPS-02 | BLOCKED | not-provisioned | Not executed: requires staging and external accounts. **Blocker:** Staging deployment, scoped Cloudflare access and domain (docs/09-OPERATOR-SETUP.md) |
| OPS-03 | BLOCKED | not-provisioned | Not executed: requires staging and external accounts. **Blocker:** Staging deployment, scoped Cloudflare access and domain (docs/09-OPERATOR-SETUP.md) and alert transport |
| PERF-01 | BLOCKED | not-provisioned | Not executed: requires staging and external accounts. **Blocker:** Scoped staging resources for load test |
| PERF-02 | BLOCKED | not-provisioned | Not executed: requires staging and external accounts. **Blocker:** Staging load test |

PASS rows were produced locally and must be re-run on staging before release. Contract tests with doubles are never counted as live provider, Stripe or ChatGPT evidence.

## Next actions for the operator
1. Choose the domain (proposed sns.ayonix.com) and grant scoped Cloudflare access; run `scripts/provision.sh staging`.
2. Provide secrets via `wrangler secret put` (never in chat): BETTER_AUTH_SECRET, TOKEN_ENCRYPTION_KEY, SIGNING_KEY, EMAIL_API_KEY/EMAIL_FROM, STRIPE_* (sandbox), provider client credentials, RESEARCH_API_KEY, AI_PROVIDER_API_KEY.
3. Register callbacks/webhooks listed in docs/runbooks/operations.md; create Stripe products/prices for Basic/Standard/Premium and a Custom product.
4. Submit LinkedIn, Meta, TikTok and Google app reviews with the scopes in apps/worker/src/providers/SOURCES.md; designate test accounts.
5. Approve legal pages (terms, privacy, data deletion, refunds, tax) — not invented here.
6. Run the live acceptance matrix (handoff/docs/10-ACCEPTANCE.md) on staging and regenerate this file.
