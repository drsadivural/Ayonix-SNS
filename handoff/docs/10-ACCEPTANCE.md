# 10. Acceptance matrix

Run against staging with authorized dedicated social accounts and Stripe sandbox. Unit/contract tests may inject failures, but cannot replace live provider evidence. Record PASS/FAIL/BLOCKED per case and environment. No skipped mandatory case is PASS. Redact secrets and personal data.

| ID | Requirement and decisive evidence |
|---|---|
| AUTH-01 | New verified account, login, reset and logout work through actual auth service |
| AUTH-02 | Owner/admin/editor/viewer permissions; removed member immediately loses mutation access; last owner cannot be removed |
| TEN-01 | Cross-tenant product/connection/asset/report/target IDs fail on REST and MCP; no leak via error, cache or signed URL |
| BILL-01 | Basic/Standard/Premium invoices have $49/$99/$199 pre-tax monthly line items and correct server entitlements |
| BILL-02 | Custom min $49/max exactly $1,000; all combinations server validated; tampered amounts, flags and Price IDs rejected |
| BILL-03 | Sandbox real Checkout, paid invoice, renewal, failed card, async pending if enabled, Portal cancellation and effective-date downgrade |
| BILL-04 | Forged signature rejected; repeated/reordered webhook cannot duplicate allowance or restore canceled access |
| QUOTA-01 | Last-unit parallel confirmations allow one reservation only; multi-target confirmation all-or-none |
| QUOTA-02 | Retry consumes once, definite failure releases, unknown retains, cancellation before submit releases, published deletion does not refund |
| QUOTA-03 | Upgrade/downgrade/trial expiry/future period handled without quota reset or overspend |
| CONN-01 | All five actual OAuth connections, account discovery, exact granted scopes, reconnect and revoke prove lifecycle |
| LI-01 | LinkedIn member/Page as approved: text/image/link/video supported formats have actual receipt and correct-account visibility |
| FB-01 | Facebook Page text/link/image/video/Reels as supported; real final IDs; personal-profile request rejected |
| IG-01 | Instagram eligible account image/carousel/Reel; ready-container then publish, final media ID; consumer/text-only rejected |
| TT-01 | TikTok fresh creator constraints, manual privacy, interactions/disclosure/consent; wrong/stale approval blocks; final status and correct visibility |
| YT-01 | YouTube resumable upload, actual channel/video ID, visibility, audience, synthetic disclosure and native schedule/cancel tested |
| MEDIA-01 | Owned upload persisted; invalid MIME/duration/dimensions/size rejected; signed URL expires; SSRF and wrong-tenant access fail |
| SCH-01 | ChatGPT closes, Worker restarts and queue redelivers; approved target still dispatches once or enters explicit unknown reconciliation |
| SCH-02 | Crash after provider acceptance and before local receipt: no blind retry; reconcile real outcome or retain unknown with operator action |
| SCH-03 | UTC/IANA/local rendering correct across Melbourne DST; nonexistent time rejected, ambiguous occurrence explicitly selected |
| SCH-04 | Edit/reschedule invalidates approval; cancellation race honest; partial multi-network failure visible and reconciled |
| SCH-05 | 429 respects server delay, revocation pauses, retry limits/DLQ/authorized redrive and lateness alerts work |
| MCP-01 | Actual ChatGPT authorization/discovery, resource/audience/scopes, exact callback, tools/list and guarded tools/call |
| MCP-02 | Real conversation draft→preview→confirm→durable publish→provider URL→report; missing input, duplicate call and cancel paths |
| MCP-03 | No plans/upsell/payment tool/checkout hidden in OAuth; existing subscriber signs in and uses entitlement |
| MCP-04 | Public directory review and installation proof; original install-to-payment flow remains BLOCKED unless explicitly enabled |
| AI-01 | Auto learn ingests owned source, cites evidence, proposes changes and requires review; disabled tier/cap blocked |
| AI-02 | Competitor and similar-product brief use actual permitted sources, dates and citations; inaccessible data marked unavailable |
| AI-03 | Retrieval prompt injection cannot invoke tools, disclose tokens, change billing or approve content; budgets enforced |
| MET-01 | Metrics reconcile with actual provider values within documented lag; unsupported metrics null; no false unique cross-network reach |
| REP-01 | Filtered CSV/PDF contains real authorized data, definitions/date/freshness; signed download expires; empty/error/export encoding checked |
| UI-01 | Exactly five menus; every control persists real action or shows explicit restriction; no sample metrics in production |
| UI-02 | Five menus + auth/onboarding/consent/composer/details at 1440/834/390, light/dark, loading/empty/error; keyboard/contrast/no overflow |
| OPS-01 | Build, typecheck, lint, migrations, tests and deployed smoke checks pass; no suppressed errors |
| OPS-02 | Database backup restored to isolated staging; media keys retained; queue/DLQ replay safe; previous deployment rollback tested |
| OPS-03 | Token rotation, log redaction, retention/export/deletion, alert delivery and support escalation tested |
| PERF-01 | Scoped staging load: 100 workspaces × 10 concurrent confirmations without quota overspend; queue duplicate tests without bulk live publishing |
| PERF-02 | Measure p95 API latency and dispatch lateness against agreed workload; record upstream latency separately and cost per tenant |

## Evidence file shape

```json
{
  "requirement_id": "SCH-01",
  "status": "BLOCKED",
  "environment": "not-provisioned",
  "command_or_flow": "Close ChatGPT after confirmed schedule and observe authorized provider publication",
  "expected": "Durable target dispatch and real receipt",
  "observed": "No deployed application or authorized test account supplied in package-preparation environment",
  "artifact_paths": [],
  "blocker": "Application implementation and configured staging accounts required"
}
```

Populate timestamps, real command results and safe receipt IDs only when tests actually run. Generated UI concepts and the local pricing calculator cannot be used as this evidence.
