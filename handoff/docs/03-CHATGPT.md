# 3. ChatGPT connection

## Policy finding and implementation boundary

Official plugin guidelines retrieved 30 October 2026 prohibit selling digital subscriptions directly or indirectly in a plugin. Existing paid users may sign in and use included features. A plugin can explain unavailable entitlements and link an informational page, but cannot initiate checkout or link a page that starts a subscription. The checkout reference's general external-checkout wording does not override the category restriction.

Consequently, the exact requested installation → registration → payment handoff is **BLOCKED by current public policy**, unless OpenAI explicitly enables this use case. Implement a fully functioning independent website acquisition/billing path. The ChatGPT connector supports existing entitled accounts, sign-in, consent, drafting, scheduling, reporting and status. It must not display plans, promote upgrades, offer a checkout tool or route OAuth through required payment. A new account may authenticate without being forced to buy; return a neutral entitlement-unavailable response when necessary. No deceptive redirect or hidden upsell.

Record this unresolved business requirement in the release checklist. If policy changes, document the exact official source or written enablement and add a policy-versioned feature flag, with tests and review, before changing the flow. Directory approval, naming, ranking and discovery are not guaranteed. Developer testing is not public listing.

## Auth and MCP

Expose HTTPS /mcp with the maintained SDK and Streamable HTTP. Expose OAuth protected-resource metadata at the well-known location; issuer discovery comes from the selected authorization server. Require authorization-code flow with PKCE S256 and resource-bound tokens. Verify issuer, audience, expiry, signature, workspace membership and scopes on every invocation. Support one documented ChatGPT client registration approach (prefer CIMD when supported; DCR if selected). Use the exact redirect URI shown by ChatGPT's management interface; do not hardcode a guessed callback. Return the proper WWW-Authenticate challenge and OAuth error metadata for reauthorization. Website login is not automatically an MCP bearer token.

Scopes: sns:read, sns:draft, sns:schedule, sns:cancel. Tenant/account IDs in tool arguments are selectors only. A valid token never grants access to another workspace. Validate origin/transport and rate-limit without relying on a model to enforce auth. Render user content as inert text.

## Tools

Machine-readable names and schemas are in contracts/mcp-tools.json. Implement runtime validation and declare accurate read/write/destructive/open-world hints; hints are not authorization.

| Tool | Behavior |
|---|---|
| get_workspace_status | Actual entitlement/capability summary, no upsell |
| list_products | Authorized product profile IDs and approved claims |
| list_connections | Accounts, capability, token expiry/reconnect state; no secrets |
| create_campaign_draft | Persist product, audience, language, goal and explicit targets |
| prepare_post | Persist per-platform content revision and owned asset IDs |
| preview_schedule | Validate dates, quota and provider format; return costs, times, approval requirements and expiring revision hash |
| confirm_schedule | Verify preview token, revision, confirmation, membership, consent and entitlement; atomic reservation; return schedule and target IDs |
| list_schedule | Tenant-filtered status list with pagination |
| cancel_schedule | Version-checked cancellation with per-target outcome |
| get_post_status | Provider receipts, processing/failure/unknown state and verified URL |
| get_report | Real normalized metrics with provenance, unsupported fields null |
| save_product_profile / approve_product_profile | Define products in ChatGPT; save draft claims, then approve an exact reviewed version |
| ingest_media / list_assets | Ingest available user-selected media into owned validated storage; list actual assets |
| request_product_research / get_research_status | Launch entitled evidence jobs and read real status/results |

No general arbitrary HTTP tool, secret retrieval tool or payment tool. Read tools return redacted small data. Write tools require idempotency keys. A server-minted signed preview token binds tenant, identity, exact content hashes, target IDs, timezone, timestamps, policy/entitlement versions and expiry (10 min). Changing any field invalidates approval. Raw user text saying “confirmed” cannot bypass server validation or platform consent. Host confirmation UI and application approval are complementary controls.

Media handoff: a ChatGPT conversation file handle is not automatically a public download URL or an Ayonix asset ID. If the host supplies a retrievable media resource through its documented mechanism, ingest it with authorization and strict fetch validation. Otherwise return an authenticated upload page and resume with the real asset ID after completion. Persist bytes to R2 before a temporary source URL expires. Never claim a generated picture or video was attached when only its filename/text was available. Test both remote ingestion and hosted upload; apply source URL redaction.

## Conversation acceptance flow

Customer: “Schedule these three posts for Ayonix Shoplifter next week at 09:00 Melbourne on LinkedIn and Facebook.” Resolve the actual product and connected account IDs. Ask only for missing choices or media. Create six target publications; show exact dates, local timezone/UTC offset, text/media previews, six units and any approval issue. Confirm the persisted version. Ayonix returns actual IDs. Close ChatGPT, wait for the service clock, then verify real platform receipts and read them through get_post_status. Do not claim YouTube can publish a plain text post or Instagram can publish text without media.

For TikTok, return a hosted per-post approval URL when creator settings and consent are required. The URL signs a short-lived authenticated handoff, not an unauthenticated authorization token. No subscription UI appears there. If the user has not completed required choices, status remains awaiting_approval and cannot dispatch.

## Submission deliverables

Production MCP URL, verified domain, stable auth/discovery, concise tool descriptions, accurate screenshots, owner contact, working support, privacy/terms/data deletion pages, test account and reproducible review instructions, supported languages, declared data practices and all required permissions. Test expired tokens, reconnect, cancellation, wrong tenant, rejected approval and duplicate messages in real ChatGPT. Keep review credentials in the submission channel only.
