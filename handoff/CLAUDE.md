# Ayonix-SNS execution rules

The user authorizes implementation in Claude Code. This package itself is not a production implementation.

- Read the entire docs directory, contracts and evidence/STATUS.md before building.
- Inspect existing code and repository instructions. Preserve unrelated work. Do not push, merge, deploy production, charge a real card or publish to a customer's live account without applicable operator authorization. Staging deployment and tests may use designated authorized test accounts.
- Build production paths end to end. Every control must call real application behavior or explain a real permission/state restriction. Never silently simulate success.
- Exactly five top-level menus: Dashboard, Connectors, Billings, Reports, Settings.
- Cloudflare is the preferred host. Use durable database-backed scheduling and an outbox. Queues may deliver a message more than once. Never promise exactly-once delivery by a social provider that lacks an idempotency primitive.
- Tenant identity comes from validated auth and membership, never from a request parameter alone. Encrypt provider tokens. Tokens and payment details never enter MCP responses or logs.
- Implement both website auth and MCP OAuth resource protection; they are different flows. Use a maintained auth service/library, not custom password crypto or an improvised OAuth server.
- Revalidate official docs, scopes, API versions and app policy before each external integration. Fail closed if approval/capability is unavailable.
- Keep website billing independent of ChatGPT while current digital-subscription restrictions apply. No hidden checkout in OAuth.
- Reference code is a tested business-rule seed. Replace no live integration with it. Move it into the finished app's shared package, preserving behavioral tests.
- Tests using doubles must be identified as unit/contract tests. Provider acceptance needs authorized real API results and IDs, not doubles.
- Evidence states: PASS, FAIL, BLOCKED. Do not remove tests, weaken assertions, suppress errors, auto-update visual baselines, or mark skips as passed.
- Completion requires production build, typecheck, lint, application tests, UI checks, live provider flows, verified billing sandbox flow, deployment smoke checks and restore exercise.
- Never put secrets, user media, full request bodies or confidential research in a public evidence report.
