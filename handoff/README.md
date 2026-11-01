# Ayonix-SNS — Claude Code delivery package

Prepared for Dr. Sadi Vural / Ayonix, 30 October 2026.

**This is an implementation handoff, visual design kit and tested reference logic. It is not a deployed marketing service.** No social account was connected, no subscription was charged, and no post was published during preparation. See evidence/STATUS.md for the exact verification boundary.

## Start

1. Extract this folder beside the intended application repository. Open that repository in Claude Code.
2. Read CLAUDE.md and paste START_HERE.md as the first task. If there is no repository, Claude must create the project described in docs/02-ARCHITECTURE.md.
3. Supply credentials through the deployment secret store using docs/09-OPERATOR-SETUP.md. Never paste secrets into chat or commit them.
4. Execute every milestone in docs/08-IMPLEMENTATION.md. Preserve evidence after each gate. Continue independent work when a credential or review is missing; record that live gate as BLOCKED.
5. Publish only after docs/10-ACCEPTANCE.md passes. The app directory submission and platform approvals are separate external gates.

Run the package checks with Node 22+ and Python 3.11+:

```bash
npm test
```

Open design/index.html for the five-menu design specification and working local custom-plan calculator. The design file uses explicitly labeled example data; its UI is not a social publishing implementation. PNG mockups and an overview PDF accompany the editable source. Optional generated concept boards are visual references, never acceptance evidence.

## Included

| Path | Purpose |
|---|---|
| START_HERE.md, CLAUDE.md | Copy-ready execution contract |
| docs/01-PRODUCT.md | Features, limits and business decisions |
| docs/02-ARCHITECTURE.md | Cloudflare deployment, persistence, reliability |
| docs/03-CHATGPT.md | MCP, authentication, onboarding and directory policy |
| docs/04-PROVIDERS.md | Five real social API integrations |
| docs/05-BILLING.md | Stripe, quotas, custom pricing |
| docs/06-UI.md | Screens, responsive behavior and all important states |
| docs/07-API-AND-DATA.md | API operations, access and database model |
| docs/08-IMPLEMENTATION.md | Ordered Claude Code work and stop conditions |
| docs/09-OPERATOR-SETUP.md | Required accounts, secrets and approvals |
| docs/10-ACCEPTANCE.md | Live and automated acceptance matrix |
| docs/11-OPERATIONS.md | Monitoring, restore, deletion, incident handling |
| docs/12-SOURCES.md | Research findings and source limitations |
| contracts/ | Pricing and MCP tool contracts |
| reference/ | Executable domain rules and SQL reference schema |
| tests/ | Real reference-rule and SQLite constraint checks |
| design/ | Source design, screen PNGs and visual overview |
| evidence/ | Actual package-check results; live gates remain blocked |

## Important commercial constraint

The requested public ChatGPT install → register → subscribe flow must not be promised as currently approvable. Current OpenAI plugin guidelines prohibit initiating digital subscriptions from the plugin, including indirect freemium upsells. Users can authenticate an existing paid account and use its entitlements. Therefore the implementation supports an independently operated Ayonix website with registration/billing, plus a ChatGPT connection for existing entitled accounts. Change that handoff only after an applicable policy update or explicit OpenAI enablement. Do not hide a purchase flow inside OAuth.

Proposed application origin: https://sns.ayonix.com (not provisioned). Currency USD/month, taxes additional where required. All assumptions requiring owner signoff are explicitly listed in docs/01-PRODUCT.md.
