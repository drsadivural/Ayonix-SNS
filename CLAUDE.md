# Ayonix-SNS — repository rules

Follow `handoff/CLAUDE.md` (execution rules) and `handoff/docs/*` (product contract). Key rules restated:
- Exactly five top-level menus: Dashboard, Connectors, Billings, Reports, Settings.
- `packages/contracts/pricing.json` and `mcp-tools.json` must stay byte-identical to `handoff/contracts/` (tests + `npm run preflight` enforce it). Money is integer cents.
- Never fake success: no sample metrics, invented provider IDs, or "published" without a provider-verified receipt. Missing ≠ zero.
- No purchase/plan/upsell surfaces in MCP or the OAuth consent page.
- Tests with doubles are labeled CONTRACT TEST; they are not live provider or Stripe evidence. Update `evidence/` only from real runs.
- Tenant identity comes from session/OAuth membership, never request parameters alone. Schedule mutations go through the workspace coordinator (`apps/worker/src/jobs/coordinator.ts`).

Commands: `npm run typecheck`, `npm run lint`, `npm test` (unit + workerd contract + handoff reference), `npm run build`, `npm run preflight`.
