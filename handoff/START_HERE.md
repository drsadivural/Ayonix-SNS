# Paste into Claude Code

Build Ayonix-SNS from this package. Read CLAUDE.md and all docs before implementation. Treat this as an instruction to implement and verify the full product, not to create a demo, plan, landing page, or disconnected frontend.

First inspect the repository, AGENTS.md/CLAUDE.md, git status, existing routes, schema, auth and deployment. Protect existing changes. If this is a new repository, create the complete Cloudflare application described here. Choose current stable supported dependencies, verify official documentation, pin versions and commit a reproducible lockfile only when authorized to commit. Do not assume reference schema or domain rules constitute a finished app.

Implement real registration, workspace roles, five social connectors, scheduling, approval, media uploads, publication verification, analytics, reports, product learning/research, server-authoritative Stripe subscriptions, all plan limits, and authenticated MCP tools. Match the supplied designs. Navigation must contain only Dashboard, Connectors, Billings, Reports, Settings; put members, products, audit events and policy controls inside Settings and the scheduler inside Dashboard.

ChatGPT specifies content and timing. Ayonix persists the approved schedule and publishes from its own durable scheduler even after the conversation closes. Do not rely on ChatGPT remaining online or on ChatGPT reminders as the publishing clock. Handle required platform-specific consent, especially TikTok, with a real hosted approval screen.

Enforce the current OpenAI digital-subscription restriction. Website acquisition and subscription operate independently. Existing entitled customers can authenticate in ChatGPT. No purchase tool, plan upsell, checkout redirect or compulsory purchase in OAuth. Record the original install-to-payment requirement as an external policy BLOCKER unless enabled in writing or supported by current official policy at execution time.

Use contracts/pricing.json as the only commercial source of truth, with integer cents. Pass all included tests, then create the real application tests in docs/10-ACCEPTANCE.md. A mocked adapter or intercepted network response cannot satisfy a provider integration gate. Contract tests with controlled failure injection are useful but must be labeled as such.

Execute docs/08-IMPLEMENTATION.md to the end. At each milestone, write changed files, exact commands, exit codes, runtime evidence and remaining blockers into evidence/. Never show success when an API fails, use sample metrics in production, invent provider IDs, or label queued/processing media as published. Do not bypass missing approval with scraping, passwords or session cookies.

Do all independent work before asking for missing secrets or external approvals. Never ask for secrets in chat. End with PASS/FAIL/BLOCKED per requirement, real post IDs/URLs with secrets redacted, billing proof, screenshots, and deployment/rollback instructions. Overall status can be COMPLETE only if all mandatory gates pass. Otherwise use PARTIAL or BLOCKED with exact next actions.
