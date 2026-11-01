# 2. Architecture

## Stack decision

Use Cloudflare Workers for API/MCP and static React/TypeScript application assets, Cloudflare D1 for relational tenant data, R2 for media and reports, Queues plus dead-letter queue for jobs, and a per-workspace Durable Object for serialized scheduling/dispatch. Use maintained MCP SDK and schema validation, Stripe Checkout/Customer Portal on the independent website, a maintained OIDC/auth provider that explicitly supports the required MCP OAuth flow, transactional email and an approved search/model provider. Do not implement password or OAuth cryptography from scratch. Choose an auth provider after proving PKCE, discovery and the chosen ChatGPT client-registration method in staging.

Use direct official social APIs as the production default. A paid aggregator may be considered only after owner approval, documented coverage, approval/consent proof and margin calculation. Neither the LinkupAPI article nor an installed ChatGPT marketing connector grants this new app permission to publish for arbitrary customers.

## Execution path

React or ChatGPT → authenticated application service → tenant membership + entitlement + capability validation → immutable content revision → preview/approval → transaction: schedule + quota reservation + outbox → dispatcher → durable per-target claim → provider upload/create → status polling/reconciliation → provider receipt + quota commit → dashboard/MCP status + analytics collector.

The same service layer serves REST and MCP. Neither client writes database rows directly. D1 is the source of truth; queue payloads contain IDs and revision references, not tokens or media. Store media checksums and metadata. Upload through scoped signed URLs; validate MIME by content, dimensions, duration, checksum, ownership and size before accepting an asset.

## Scheduling and race handling

- Store IANA timezone, original local timestamp, chosen offset and UTC timestamp. Reject nonexistent DST times; ask the user which occurrence for ambiguous times. Display local and UTC at confirmation.
- Cron scans due outbox rows every minute; indexed batches, keyset pagination, outbox leases and backpressure. An outbox row remains retryable until enqueue acknowledgment. Lost acknowledgment can duplicate delivery; consumer must deduplicate.
- Per-workspace Durable Object serializes schedule changes and claims; use database conditional updates/version checks. All service writes route through this coordinator. A claim includes lease owner, expiry, content revision and fencing token.
- If a claim expires after a request might have reached the provider, mark outcome unknown and reconcile. Never simply let a new worker publish again. Exactly-once provider side effects cannot be guaranteed without provider support.
- Target 95% dispatch initiation within 120 seconds of the selected time under tested load, excluding upstream outages and unapproved content. Report lateness; do not guarantee exact public visibility time.
- Cancellation after submission stops polling only if safe; otherwise retain reconciliation. Rescheduling and editing require revision checking, reapproval and safe reservation adjustment. A campaign can have partial per-network success.

## Retry policy

Retry network failures only when known safe; respect Retry-After for 429, bounded exponential backoff with jitter (5s, 30s, 2m, 10m, 30m; then dead letter), provider-specific limits and a maximum retry window. Refresh expired tokens under a distributed single-flight lock; stop on revoked access. Validation errors are terminal and visible. Ambiguous timeouts after creation go to reconciliation, not blind retries. Dead-letter redrive requires an authorized operator and rechecks state, not a raw resend.

## Storage and security

Every business row is tenant-scoped. Composite foreign keys prevent cross-tenant linkage in the reference schema. Derive workspace access from authenticated membership; cache only with tenant keys. Owner/admin manages billing/connectors/members, editor drafts/schedules within granted policy, viewer reads. Platform-owner operations require separately audited staff access.

Encrypt refresh/access tokens using AES-GCM envelope encryption with a versioned secret key; workspace+connection as additional authenticated data, random IV, rotation runbook. TLS only. Secure, HttpOnly, SameSite cookies; CSRF for website mutations; OAuth state and PKCE; strict redirect allowlists; short-lived scoped upload URLs; rate limits and Turnstile where appropriate. Redact auth headers, tokens, media URLs and personal captions from logs.

R2 keys isolate workspace prefixes. Never trust an arbitrary remote media URL: controlled ingestion with DNS/IP checks, no private/link-local targets, strict protocol/redirect/size/time limits, and recheck each redirect. Avoid unnecessary third-party downloads by accepting direct uploads. CSP and HTML sanitization on all rendered content. Research ingestion cannot override system/tool instructions.

## Target repository

```text
apps/web/src/{routes,components,features,styles}
apps/worker/src/{routes,mcp,auth,services,providers,jobs,security}
packages/domain/{pricing,quotas,scheduling,validation}
packages/contracts/
migrations/
tests/{unit,contract,integration,e2e,live}
scripts/{preflight,seed-test-account,verify-live,release,restore}
docs/{runbooks,api,decisions}
.github/workflows/ci.yml
wrangler.jsonc
.env.example
README.md
```

This is the required output structure Claude must create; the handoff folder itself is not that application.
