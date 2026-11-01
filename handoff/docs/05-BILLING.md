# 5. Billing and entitlement implementation

## Website-only purchase flow

On the independent Ayonix website: verified account → workspace → plan selection → server quote → Stripe-hosted Checkout → return page shows pending until trusted webhook grants entitlement → social connectors. Use Customer Portal for payment methods, invoices, cancellation and supported subscription changes. Do not collect raw card data. ChatGPT OAuth never requires payment or carries a checkout redirect while current plugin rules apply.

Use integer cents from contracts/pricing.json. The server validates the exact selection and computes price. Standard product price IDs are operator-provisioned. For Custom, create/reuse a Stripe recurring Price on the server using a canonical versioned configuration hash and matching USD amount; never accept a browser Price ID, arbitrary amount or feature flags as authoritative. Persist the catalog version, selection, unit amount, provider price/subscription/customer IDs and effective interval. Tax can change the final invoice total; disclose it separately. No annual plan unless separately authorized.

## Webhooks and lifecycle

Verify Stripe signature against raw request bytes with timestamp tolerance. Deduplicate by event ID. Associate events using server-owned customer/subscription mappings and workspace metadata validated against those mappings. Handle checkout completion, asynchronous payment results as applicable, invoice paid/payment failed, subscription updated/deleted and trial-will-end. Retrieve canonical subscription/invoice state when events can arrive out of order; old events must not roll state backward.

Grant entitlement only on verified paid/valid trial state, never the browser success URL. Define scheduled plan changes and period boundaries using Stripe's authoritative timestamps. Persist webhook receipt and application transaction together; return retryable error on incomplete processing. Provide a replay tool with audit records. Test duplicate/reordered events, multiple tabs and checkout expiration.

Proposed lifecycle: trialing → active → past_due → suspended/unpaid → canceled. At payment failure notify owner and pause new confirmations immediately; hold due posts until payment recovery, with a 72-hour maximum stale window. Do not auto-publish missed posts in a burst after recovery: ask to reschedule. Cancellation at period end retains access until the paid period ends. Full cancellation/chargeback/revocation pauses future targets. Preserve receipts. Refund policy and tax registration must be approved by Ayonix before live checkout.

## Atomic quota ledger

Allowance = current plan cycle cap; available = allowance - used - reserved. Reserve all campaign targets in one transaction or none. Serialize per workspace. Use unique operation keys and unique target-ledger references to prevent replay consumption. Confirming the same idempotency key with the same payload returns the stored result; with a different payload returns conflict. Store payload hash.

Each target transitions reservation exactly once: reserved → committed on verified success; reserved → released on safe cancellation or definite failure. Unknown/provider-submitted work stays reserved. A committed target is never charged again by a retry. Deleting a published post does not restore quota. Scheduled work uses immutable allowance period ID; no accidental transfer into a new cycle. Cross-period changes release only safe old reservations, then reserve in the effective new period if it exists.

## Website price examples

| Selection | Monthly pre-tax price |
|---|---:|
| Basic | $49 |
| Standard | $99 |
| Premium | $199 |
| Custom base | $49 |
| Custom 120 publications + 10 products + auto learn | $278 |
| Custom all highest tiers and all three features | $1,000 |

All-selected pricing must equal exactly 100,000 cents; no silent clamp that grants unlimited unpriced features. Invalid combinations are rejected. Show the incremental price beside each checkbox and a persistent total. Capacity controls are exclusive tier checkbox groups, not cumulative additions. Essential connector/auth/reporting features stay included.

## Commercial protections

Enforce maximum product/account counts, research jobs, corpus size, asset storage and retention. Proposed included media storage: Basic 2 GB, Standard 10 GB, Premium 30 GB, Custom 50 GB; 90-day inactive source-media cleanup with owner notice, while scheduled assets stay retained. Maximum ingested file 500 MB initially; larger YouTube media requires a documented upgrade to streaming/upload limits, not a false supported label. Full media generation is excluded. Alert internally on research/API cost above 20% of subscription revenue; do not secretly degrade paid promises. No upsell in ChatGPT.
