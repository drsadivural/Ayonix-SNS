# 1. Requirements and commercial decisions

## Outcome

A customer independently registers and subscribes on Ayonix-SNS, connects permitted social accounts, then connects Ayonix-SNS to ChatGPT. In conversation the customer defines a product, audience, content, media and schedule. Ayonix validates it, obtains the required approval, persists it and publishes at the selected times. Dashboard and ChatGPT return true per-account status and post links. Closing ChatGPT has no effect on scheduled work.

The originally requested new subscription during ChatGPT installation is policy-blocked as researched on 30 October 2026; it is not silently considered satisfied by the independent website path. See docs/03-CHATGPT.md.

## Included plans — USD per month

| Plan | Monthly price | Destination publications | Active products | Auto learn | Competitor check | Similar-product research |
|---|---:|---:|---:|---|---|---|
| Basic | 49 | 20 | 1 | No | No | No |
| Standard | 99 | 60 | 3 | Yes | Yes | Yes |
| Premium | 199 | 120 | 10 | Yes | Yes | Yes |
| Custom | 49–1,000 | 20–1,000 | 1–50 | Optional | Optional | Optional |

All plans include all five supported networks, authenticated ChatGPT connection, media supplied by the user, schedule management, basic channel analytics, CSV/PDF reports, roles, audit events and support by email. A product is a marketing profile, not a social account: name, approved claims, URLs, audience, language, assets, prohibited claims and tone. One verified destination per network per active product is the proposed included account limit. Do not silently interpret 1 product as 1 post or as unlimited accounts.

Premium inherits Standard features: assumption because the user specified its volume/products but did not separately list its features. Custom ceilings and research limits below are proposed commercial defaults, not user-specified quantities. Store as versioned settings so Ayonix can change future offers without changing existing contracts.

## Custom calculator

Start with Basic ($49, 20 publications, 1 product). The customer selects independent checkboxes; each category permits only one tier or none. Prices below are additional monthly amounts. No disabled essential security or billing features.

| Category | Options and incremental monthly price |
|---|---|
| Publication capacity | 60 +$30; 120 +$70; 300 +$170; 600 +$300; 1,000 +$420 |
| Product capacity | 3 +$20; 10 +$60; 25 +$110; 50 +$160 |
| Auto learn | +$99 |
| Competitor check | +$129 |
| Similar-product research | +$143 |

Maximum valid configuration = 49 + 420 + 160 + 99 + 129 + 143 = **$1,000/month**. The default is $49. Exact totals, including server quote verification, live in contracts/pricing.json and reference/domain.mjs. A Custom configuration equivalent to Standard may cost more: show a website-only “Standard offers better value” recommendation, never alter the selected price automatically. Taxes are not part of the $1,000 subscription-price ceiling; say so next to the total.

## Quotas

- One unit = one destination publication. One campaign sent to LinkedIn and Instagram consumes two units. A ten-slide Instagram carousel consumes one publication. Failed attempts and retrying the same target do not consume extra units.
- Reserve one unit per target atomically when a schedule is confirmed. Move reserved → used after provider-verified success. Release on cancellation before submission or definite terminal failure. An unknown outcome retains its reservation until reconciled.
- Use the subscription billing cycle in UTC, not the calendar month. No rollover. Store immutable period IDs and dates. Future-cycle scheduling is tentative and cannot consume a yet-uncreated allowance; promote after renewal and reconfirm if necessary. Never promise future publication when renewal is uncertain.
- Upgrades grant only the difference in cycle allowance. Do not reset used/reserved. Downgrades take effect at next renewal; do not delete products. Ask the owner which products remain active and pause excess targets on the effective date.
- Plan entitlement and connected-account capability are separate gates. Paying does not grant an API permission.

## Learning and research — real behavior

Auto learn: ingest only owner-approved product URLs/docs and that tenant's authorized analytics; extract evidence-backed claims; show source URL, retrieval date and a proposed profile change. Human review before new claims become usable. Relearn weekly plus on demand, with limits. Never train a shared model on customer data by default.

Competitor check: customer selects competitor URLs/accounts. Fetch permitted public website/search information and officially accessible social data. Show dated evidence, positioning, price only when visible, and changes. Never promise private metrics or unrestricted competitor social access. No credential scraping or copying competitors' assets.

Similar-product research: licensed search API + retrieval from permitted domains, structured comparison with citations and freshness. Treat web text as untrusted; it cannot invoke tools, change billing, or approve publishing. Deduplicate and require review before changing a campaign.

Proposed caps per active product: Standard 4 learning refreshes, 4 competitor scans across 3 competitors, 4 research briefs/month; Premium 4/4/4 across 5 competitors; Custom enabled feature 4/4/4 across 5 competitors. Max 20 retrieved pages and 30k model input tokens per brief; max 5 MB source document, 50 MB source corpus per product, 90-day raw retrieval retention. Stop at cap with a plain reason; no surprise metered charges. Generating images/videos is not included in these prices; upload existing assets, including assets prepared in ChatGPT. Any paid generation later requires a separately approved offer.

## Trial assumption

Proposed independent website trial: 7 days, no card, 5 destination publications total, 1 product; one trial per verified business owner subject to abuse controls. No automatic paid conversion without explicit website checkout consent. Expiry pauses publication, preserves drafts, releases safe reservations and shows status. Do not promote this trial inside the ChatGPT plugin under the researched policy.

## Scope

Organic publishing, measurement, scheduling, research and approvals are in scope. Paid ad buying, automated likes/follows/DMs, community inbox, unlimited media generation and revenue attribution without a real conversion integration are outside scope. Never place those controls in the UI.
