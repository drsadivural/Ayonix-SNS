# 11. Production operations

## Observability

Structured correlation IDs connect MCP request, schedule, target, attempt, provider receipt, webhook and quota transaction without leaking captions/tokens. Redacted audit events record actor, workspace, action, object, revision and time. Expose customer events inside Settings, with platform diagnostics only for authorized staff.

Monitor due-target lag, publish success per provider/format, unknown outcomes, retries, queue/DLQ depth, expired leases, token failures, webhook lag, payment mismatch, quota invariants, metric freshness, research spend and HTTP errors. Alert on any unknown outcome older than 15 minutes, missed dispatch beyond 5 minutes, sustained queue backlog or webhook failure. Notification transports must be real and tested, not console logging described as email. Thresholds are initial operating defaults to tune against measured load.

## Recovery

Before release take a consistent D1 backup/export and inventory R2 asset references, configuration and key versions. Restore into an isolated environment and validate row counts, tenant constraints, receipts, pending schedules and decryption. Pause dispatch during recovery. Reconcile in-flight provider work before resuming; never replay a historical outbox blindly. Database rollback must preserve receipts and quota ledger. Prefer forward-compatible migrations and explicit corrective migrations to destructive rollback.

DLQ redrive checks target version, terminal state, quota reservation, consent freshness, capability and real provider outcome. Record operator reason. Disable one provider independently during incidents while preserving other channels. Published links stay visible.

## Privacy and lifecycle

Provide owner export, account/workspace deletion, provider deauthorization and Meta deletion callback as required. Immediately revoke access and pause future publication; erase tokens and media on the disclosed schedule. Retain only legally required billing records and minimal lawful audit data, with explicit retention. Proposed logs 30 days, audit 12 months, reports 30 days, raw research 90 days; approve these before publishing privacy terms. Respect backups and deletion tombstones during restoration. No training on customer data without explicit contract and consent.

## Release gate

Separate staging/prod resources, secrets and webhook signing keys. No broad account API tokens in client bundles or CI. Scoped deployment identity; protected CI environments; dependencies pinned and scanned. Keep a release version and migration history. Verify actual provider API deprecation dates regularly. Reports, learning and new schedule confirmations can degrade independently; never hide publishing failures behind a healthy home page.
