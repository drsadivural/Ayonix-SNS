# 7. API and data contract

REST prefix /api/v1. Use schema-validated JSON, request IDs, structured errors, cursor pagination and workspace membership on all routes. CORS allowlists actual origins; no wildcard credentials. MCP and REST invoke the same services.

| Method/path | Result / access |
|---|---|
| GET /workspace | Current authorized workspace and entitlements / member |
| GET, POST /products | List/create approved profiles / member, editor write |
| PATCH /products/:id | Versioned profile edit and approval / editor or admin |
| POST /products/:id/approve | Approve exact reviewed version and cited claims / authorized scheduler |
| GET /connections | Redacted account/capability list / member |
| POST /connections/:provider/authorize | State-bound OAuth initiation / admin |
| GET /oauth/:provider/callback | Validate state/PKCE, exchange, discover; no client token exposure |
| DELETE /connections/:id | Revoke/disconnect, pause targets / admin |
| POST /assets/upload-intent | Bounded, owned R2 upload / editor |
| POST /assets/ingest | Safe authorized remote media ingestion / editor |
| GET /assets | Owned validated assets with cursor / member |
| POST /assets/:id/complete | Probe actual media, checksum and scan / editor |
| POST /campaigns | Persist campaign draft / editor |
| POST /posts | Persist per-platform content revision / editor |
| POST /schedules/preview | Validation, quota cost, dates, bound token / scheduler permission |
| POST /schedules/confirm | Atomic reservation + outbox / scheduler permission |
| GET /schedules | Filtered target status with cursor / member |
| POST /schedules/:id/cancel | Conditional cancellation / scheduler permission |
| PATCH /schedules/:id | Version-checked edit/reschedule; reapprove / scheduler permission |
| GET /posts/:id/status | Real per-target receipt/state / member |
| GET /analytics | Normalized actual metrics, freshness / member |
| POST /reports | Persist report job / member |
| GET /reports/:id | Status and short-lived owned download / member |
| POST /products/:id/{learn,competitors,research} | Entitled bounded evidence jobs / editor |
| GET /research/:id | Real job status, sources and proposed revisions / member |
| GET /billing/catalog | Website catalog / authenticated |
| POST /billing/quote | Server validated versioned quote / owner |
| POST /billing/checkout | Independent website Stripe Checkout / owner |
| POST /billing/portal | Independent website Stripe Portal / owner |
| POST /webhooks/stripe | Raw-body verified signature; idempotent service handler |
| POST /webhooks/:provider | Official signature verification; event deduplication |
| GET /events | Redacted tenant audit list / admin |
| POST, PATCH, DELETE /members | Invite/change/revoke; last owner protection / owner |
| POST /privacy/{export,delete} | Reauthenticated owner request, tracked job |
| GET /health/live, /health/ready | Liveness; safe dependency summary; no secrets |

Common error envelope: code, safe message, request_id, field_errors, retryable, retry_after_seconds, current_version when applicable. Status codes 400 invalid, 401 auth, 403 permission/entitlement, 404 absent or inaccessible resource, 409 revision/idempotency conflict, 422 media/date/capability, 429 limit, 502/503 upstream/unavailable. Never return 200 with success true when the operation failed. Provider error detail is redacted in UI and audit.

## Data model

reference/schema.sql is an executable SQLite reference for core constraints. It is not a full production migration suite. Claude must expand it into versioned D1 migrations with these tables and indexes before delivery:

workspaces; identities; memberships; invitations; products; product_claims; product_sources; product_revisions; connections; connection_capabilities; encrypted_credentials; assets; campaigns; posts; content_revisions; post_assets; schedules; targets; approvals; provider_receipts; attempts; quota_periods; quota_ledger; idempotency_records; outbox; subscriptions; billing_quotes; billing_events; invoices; metric_snapshots; report_jobs; research_jobs; research_sources; audit_events; privacy_jobs; notification_preferences; sent_notifications.

Each tenant row uses workspace_id and composite unique (workspace_id,id); foreign keys use both. Index upcoming (status,due_at), outbox (state,next_attempt_at), metrics (workspace_id,account_id,date), events (workspace_id,created_at), connections expiry and webhook unique provider/event ID. Keep schema version. Migration tests must cover populated upgrade and rollback/recovery, not only blank database creation.

Do not store card numbers. Secrets use encrypted_credentials with ciphertext, nonce, key_version and authenticated tenant context. Assets store object key, checksum, MIME, dimensions, duration, bytes, validation state and retention deadline. Approvals bind content revision and settings hash. Provider receipts include actual IDs and verification status; canonical URLs must be provider-derived or validated, never invented.

## Publication state machine

draft → awaiting_approval → scheduled → queued → uploading → processing → published. From applicable nonterminal states: retry_wait, reconnect_required, failed, canceled or outcome_unknown. Only explicit allowed transitions; compare-and-swap versioning. The small reference state machine covers business transitions; application adds upload phases and provider-specific reconciliation.

Published is terminal for publication accounting. Post deletion is a separate external operation and does not refund a unit. Outcome_unknown cannot be canceled/released until reconciled; the UI can request cancellation but must show that publication may already have happened. Retry uses the same target ID. Native scheduled YouTube targets persist remote scheduling ownership and are not uploaded again by the queue.
