#!/usr/bin/env node
// Builds evidence/acceptance.json and evidence/STATUS.md from actual command
// runs. A requirement is PASS only when its decisive evidence can be produced
// in the recorded environment; everything that needs staging, live provider
// accounts, Stripe sandbox, real email or ChatGPT stays BLOCKED.
import { execSync, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';

const root = new URL('..', import.meta.url).pathname;
const at = new Date().toISOString();
let sha = null;
try {
  sha = execSync('git rev-parse HEAD', { cwd: root, encoding: 'utf8' }).trim();
} catch {
  /* not committed yet */
}

function run(name, cmd) {
  const started = Date.now();
  const r = spawnSync('bash', ['-lc', cmd], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const out = `${r.stdout}\n${r.stderr}`;
  const tests = [...out.matchAll(/Tests\s+(\d+) passed(?: \((\d+)\))?/g)].map((m) => Number(m[1]));
  return { name, command: cmd, exit_code: r.status, duration_ms: Date.now() - started, tests_passed: tests.reduce((a, b) => a + b, 0) || null, tail: out.trim().split('\n').slice(-6).join('\n') };
}

const commands = [
  run('typecheck', 'npm run typecheck'),
  run('lint', 'npm run lint'),
  run('unit + provider contract + migration tests', 'npx vitest run --project unit'),
  run('workerd contract/integration tests', 'npm run test -w @ayonix/worker'),
  run('handoff reference tests', 'npm run test:reference'),
  run('web tests', 'npm run test -w @ayonix/web'),
  run('web build', 'npm run build -w @ayonix/web'),
  run('worker bundle (dry run)', 'npx wrangler deploy --dry-run --outdir /tmp/ayonix-worker-dryrun'),
];
const ok = (name) => commands.find((c) => c.name === name)?.exit_code === 0;
const local = 'local-workerd (Miniflare D1/R2/KV/Queues/DO)';
const notProvisioned = 'not-provisioned';

const B = (id, flow, blocker, localEvidence = null) => ({ requirement_id: id, status: 'BLOCKED', environment: notProvisioned, command_or_flow: flow, observed: localEvidence ? `Local contract evidence only: ${localEvidence}` : 'Not executed: requires staging and external accounts.', artifact_paths: [], blocker });
const P = (id, flow, observed, test, gate) => ({ requirement_id: id, status: gate ? 'PASS' : 'FAIL', environment: local, command_or_flow: flow, observed: gate ? observed : 'Test command failed; see commands[]', artifact_paths: [test], blocker: 'Re-run against staging before release' });

const workerOk = ok('workerd contract/integration tests');
const unitOk = ok('unit + provider contract + migration tests');
const STAGING = 'Staging deployment, scoped Cloudflare access and domain (docs/09-OPERATOR-SETUP.md)';
const rows = [
  B('AUTH-01', 'Register, verify email, login, reset, logout via deployed auth', `Verified email sender (EMAIL_API_KEY/EMAIL_FROM) and ${STAGING}`, 'apps/worker/test/http.test.ts runs register → verify (dev mailbox) → sign in → workspace through the real Worker; reset/logout not yet exercised end-to-end.'),
  B('AUTH-02', 'Role permissions, removed member loses access, last owner protection', STAGING, 'scheduling.test.ts, assets-products.test.ts and http.test.ts (MCP access revoked immediately after membership removal) pass locally.'),
  B('TEN-01', 'Cross-tenant IDs fail on REST and MCP', STAGING, 'scheduling.test.ts tenancy cases and approvals-reports.test.ts (foreign report ID) pass locally; signed URL tamper test passes.'),
  B('BILL-01', 'Stripe invoices $49/$99/$199 with correct entitlements', 'Stripe account, sandbox keys, Price IDs, webhook secret; approved tax/refund policy', 'Quote amounts and webhook-driven entitlements verified with a Stripe API double (billing.test.ts).'),
  P('BILL-02', 'Custom min/max, all 240 combinations, tampered input rejected (server quote)', 'Min 4900, max exactly 100000 cents, 27800 example, tampered fields/Price IDs rejected; MCP actors cannot quote', 'packages/domain/test/pricing.test.ts; apps/worker/test/billing.test.ts', unitOk && workerOk),
  B('BILL-03', 'Sandbox Checkout, renewal, failed card, Portal cancel, downgrade', 'Stripe sandbox configuration and authorized test cards'),
  B('BILL-04', 'Forged/repeated/reordered webhooks', 'Stripe sandbox webhook endpoint on staging', 'Forged signature rejected; duplicate event idempotent; stale event cannot restore canceled access (billing.test.ts with test-signed events).'),
  P('QUOTA-01', 'Last-unit parallel confirmations; multi-target all-or-none', '6 parallel confirmations for 1 unit → exactly 1 reservation (direct D1 and via coordinator DO); failing multi-target batch leaves no rows', 'apps/worker/test/scheduling.test.ts', workerOk),
  P('QUOTA-02', 'Retry once, failure releases, unknown retains, cancel releases', 'Retry after 429 commits once; validation failure releases; ambiguous keeps reservation; cancel before submit releases exactly once', 'apps/worker/test/dispatch.test.ts; scheduling.test.ts', workerOk),
  B('QUOTA-03', 'Upgrade/downgrade/trial expiry/future period', 'Stripe sandbox renewal cycle on staging', 'Upgrade grants difference only and downgrade waits for renewal (billing.test.ts double); trial 5 publications once (http.test.ts); future-cycle times rejected.'),
  B('CONN-01', 'Five real OAuth connections, scopes, reconnect, revoke', 'Developer apps and approvals for LinkedIn, Meta, TikTok, Google; callback URLs on staging', 'Adapter OAuth URL/exchange contract tests with fetch doubles (tests/unit/providers).'),
  B('LI-01', 'LinkedIn formats with real receipts', 'LinkedIn app with approved products, test member/Page'),
  B('FB-01', 'Facebook Page formats with real IDs', 'Meta app review, test Page'),
  B('IG-01', 'Instagram image/carousel/Reel real media IDs', 'Meta app review, Instagram professional test account'),
  B('TT-01', 'TikTok creator constraints, consent, final status', 'TikTok Content Posting API approval/audit, test creator', 'Hosted approval rules (no default privacy, disabled interactions, stale creator settings rejected) pass with a TikTok API double (approvals-reports.test.ts).'),
  B('YT-01', 'YouTube resumable upload, visibility, native schedule', 'Google Cloud project with YouTube Data API + OAuth verification, test channel'),
  B('MEDIA-01', 'Uploads, invalid media, signed URL expiry, SSRF, wrong tenant', STAGING, 'Content-based validation, token binding, SSRF guard and signed-URL tamper checks pass locally (assets-products.test.ts).'),
  B('SCH-01', 'ChatGPT closed + restart + redelivery → dispatch once', `${STAGING} and authorized provider account`, 'Duplicate queue delivery submits once; cron leases and enqueues outbox (dispatch.test.ts, provider double).'),
  B('SCH-02', 'Crash after provider acceptance → no blind retry', 'Live provider account on staging', 'Claim-lease expiry → outcome_unknown, never resubmitted; fencing rejects stale settlement (dispatch.test.ts, failure injection).'),
  P('SCH-03', 'UTC/IANA/local rendering across Melbourne DST', 'Nonexistent 2026-10-04 02:30 rejected; ambiguous 2026-04-05 02:30 needs a choice; AEST/AEDT offsets correct', 'packages/domain/test/rules.test.ts', unitOk),
  B('SCH-04', 'Edit invalidates approval; cancel race; partial failure', STAGING, 'Revision change invalidates preview; reschedule resets TikTok approval; post-submission cancel is honest (scheduling.test.ts).'),
  B('SCH-05', '429 delay, revocation pause, DLQ, lateness alerts', 'Live provider accounts and alert transport on staging', 'Retry-After honored; revocation → reconnect_required (dispatch.test.ts).'),
  B('MCP-01', 'Real ChatGPT authorization/discovery and tool calls', 'Deployed HTTPS origin and ChatGPT developer test setup', 'DCR client → PKCE consent → resource-bound token → tools/list (17 tools) → tools/call, schema validation and insufficient_scope step-up pass through the real Worker (http.test.ts).'),
  B('MCP-02', 'Real conversation draft→preview→confirm→publish→report', 'ChatGPT test workspace + live provider account on staging'),
  B('MCP-03', 'No plans/upsell/payment in MCP or OAuth', 'Review in real ChatGPT on staging', 'Tool list has no purchase tools; consent HTML contains no price/plan/checkout text; get_workspace_status returns no purchase links (http.test.ts).'),
  B('MCP-04', 'Directory review; install-to-payment flow', 'EXTERNAL POLICY BLOCKER: OpenAI digital-subscription restriction (handoff/docs/03-CHATGPT.md); directory submission not made'),
  B('AI-01', 'Auto learn with citations and review', 'RESEARCH_API_KEY and AI_PROVIDER_API_KEY with budget limits'),
  B('AI-02', 'Competitor/similar research with real sources', 'Licensed search API and model credentials'),
  B('AI-03', 'Prompt injection cannot act; budgets enforced', 'Model credentials for adversarial test set', 'Design: no tools given to the model, server-side citation check, proposals never auto-approved, per-cycle caps enforced in requestResearch.'),
  B('MET-01', 'Metrics reconcile with provider values', 'Live provider accounts with analytics scopes'),
  B('REP-01', 'CSV/PDF with real data, signed expiry', 'Real provider metrics on staging', 'CSV (formula-injection guarded, "Not available" for null) and PDF generated into R2 and downloaded via signed URL; cross-tenant report access denied (approvals-reports.test.ts).'),
  B('UI-01', 'Exactly five menus, real actions, no sample metrics', STAGING, 'Web tests assert five nav items in sidebar and mobile nav; headless Chromium run against local wrangler dev shows API-driven empty/unconfigured states, no example data (evidence/screenshots/).'),
  B('UI-02', 'Responsive/light/dark/state screenshots', 'Full matrix (all screens × 1440/834/390 × light/dark × loading/error) against staging with controlled test data; contrast and keyboard audit', 'Partial local capture: 15 screenshots (dashboard/billings at 1440/834/390, five menus light, dashboard/connectors dark, auth/onboarding) with no horizontal overflow detected (evidence/screenshots/).'),
  { requirement_id: 'OPS-01', status: commands.every((c) => c.exit_code === 0) ? 'BLOCKED' : 'FAIL', environment: local, command_or_flow: 'Build, typecheck, lint, migrations, tests, deployed smoke', observed: commands.map((c) => `${c.name}: exit ${c.exit_code}`).join('; '), artifact_paths: ['evidence/acceptance.json'], blocker: 'Deployed smoke checks (scripts/verify-live.mjs) require staging' },
  B('OPS-02', 'Backup restore, queue replay, rollback', STAGING),
  B('OPS-03', 'Token rotation, log redaction, retention, alert delivery', `${STAGING} and alert transport`),
  B('PERF-01', '100 workspaces × 10 concurrent confirmations', 'Scoped staging resources for load test'),
  B('PERF-02', 'p95 API latency and dispatch lateness', 'Staging load test'),
];
const counts = rows.reduce((a, r) => ((a[r.status] = (a[r.status] ?? 0) + 1), a), {});
mkdirSync(`${root}evidence`, { recursive: true });
writeFileSync(`${root}evidence/acceptance.json`, JSON.stringify({ generated_at: at, commit_sha: sha, overall: 'PARTIAL', counts, commands, requirements: rows }, null, 2) + '\n');
const md = `# Verification status

Generated ${at}${sha ? ` at commit ${sha}` : ''} by \`node scripts/evidence.mjs\`.

**Overall: PARTIAL.** The application is implemented and verified locally (workerd with real local D1/R2/KV/Queues/Durable Objects). No staging deployment, social provider app, Stripe sandbox, email sender, research/model credential or ChatGPT test workspace was available in this run, so every live gate is BLOCKED. The original ChatGPT install→subscribe flow is an external policy BLOCKER (MCP-04).

Counts: ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(', ')} (of ${rows.length}).

## Commands
| Check | Command | Exit | Tests passed |
|---|---|---:|---:|
${commands.map((c) => `| ${c.name} | \`${c.command}\` | ${c.exit_code} | ${c.tests_passed ?? ''} |`).join('\n')}

## Requirements
| ID | Status | Environment | Evidence / blocker |
|---|---|---|---|
${rows.map((r) => `| ${r.requirement_id} | ${r.status} | ${r.environment} | ${(r.status === 'PASS' ? `${r.observed} (${r.artifact_paths.join(', ')})` : `${r.observed} **Blocker:** ${r.blocker}`).replace(/\|/g, '/')} |`).join('\n')}

PASS rows were produced locally and must be re-run on staging before release. Contract tests with doubles are never counted as live provider, Stripe or ChatGPT evidence.

## Next actions for the operator
1. Choose the domain (proposed sns.ayonix.com) and grant scoped Cloudflare access; run \`scripts/provision.sh staging\`.
2. Provide secrets via \`wrangler secret put\` (never in chat): BETTER_AUTH_SECRET, TOKEN_ENCRYPTION_KEY, SIGNING_KEY, EMAIL_API_KEY/EMAIL_FROM, STRIPE_* (sandbox), provider client credentials, RESEARCH_API_KEY, AI_PROVIDER_API_KEY.
3. Register callbacks/webhooks listed in docs/runbooks/operations.md; create Stripe products/prices for Basic/Standard/Premium and a Custom product.
4. Submit LinkedIn, Meta, TikTok and Google app reviews with the scopes in apps/worker/src/providers/SOURCES.md; designate test accounts.
5. Approve legal pages (terms, privacy, data deletion, refunds, tax) — not invented here.
6. Run the live acceptance matrix (handoff/docs/10-ACCEPTANCE.md) on staging and regenerate this file.
`;
writeFileSync(`${root}evidence/STATUS.md`, md);
console.log(md.split('\n').slice(0, 30).join('\n'));
process.exit(commands.every((c) => c.exit_code === 0) ? 0 : 1);
