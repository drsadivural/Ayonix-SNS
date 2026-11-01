# 9. Operator setup and external gates

The preparation environment has no Ayonix-SNS repository, deployed origin, social-app credentials or Stripe configuration. A connected ChatGPT app in this session is not a credential source for a new SaaS. Claude must request only missing configuration names and guide entry into local/deployment secret storage, never ask for full secrets in chat.

| Dependency | Operator provides or authorizes | Required proof |
|---|---|---|
| Domain/Cloudflare | sns.ayonix.com or chosen domain; scoped deployment access | TLS, DNS and callback reachability |
| Cloudflare resources | D1, R2, publish/research queues, DLQs, coordinator binding, staging/prod isolation | Real IDs in generated deployment config; read/write and queue smoke tests |
| Auth | Maintained identity provider with MCP-compatible authorization server | Registration/reset/session, PKCE/discovery, resource-bound token tests |
| Email | Verified sender/domain and API credentials | Verification/reset/delivery and bounced-email handling |
| Stripe | Business account, sandbox keys/webhook secret; approved commercial/tax/refund details | Real sandbox Checkout and webhook-backed entitlement |
| LinkedIn | Developer app, approved products/scopes, callback, owned test member/Page | Granted scope probe and real receipt per supported format |
| Meta | Developer app, Facebook/Instagram login path, business verification/review where required, Page/pro account access | Verified eligibility, real upload/publish/insights, deletion callbacks |
| TikTok | Developer app, Login Kit/Content Posting, verified media domain, audit | Required consent UI, private/public capability tested as permitted |
| Google | Cloud project, YouTube APIs, consent config, OAuth client/verification as applicable | Channel upload and Analytics access, actual quota/visibility behavior |
| Search/model | Licensed API access and budget limits | Real cited research and bounded learning job |
| ChatGPT | Developer test setup and authorized workspace; public submission owner | Real MCP OAuth/write flow; directory review decision |
| Legal/commercial | Approved terms/privacy/deletion/refund, Ayonix contracting entity/tax data/support contacts | Published accurate pages, no invented company details |

Use separate secrets and callback origins for staging/production. Validate required configuration on server boot; optional unconfigured features report unavailable and are not advertised as enabled. TOKEN_ENCRYPTION_KEY is a cryptographically random 256-bit key managed in secret storage, with versioned rotation; generate through a local secure command in the actual implementation run. No real value is shipped in this handoff.

## Deployment procedure Claude must make executable

Create staging resources through Cloudflare's documented CLI/API under scoped access. Write real bindings and exact pinned CLI version. Apply migration locally, run integration tests, migrate staging, deploy, register real callbacks/webhooks, smoke-test health, auth, signed upload, queues and MCP. Run live provider acceptance against designated accounts. Capture release artifact/versions, take verified backup, prepare migration and rollback, then deploy production under applicable authorization. Keep previous Worker version, compatible schema and restore procedure. Do not ship a wrangler config with invented resource IDs or an empty deployment script just to appear ready.

## What can be validated without credentials

Pricing arithmetic, rejection of invalid combinations, domain transitions, SQL constraints, package links, design source, accessibility structure and build checks after application code exists. These do not validate OAuth, publishing, payment processing, research APIs, ChatGPT connection, public directory listing or a production deployment.
