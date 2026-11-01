// Website-only billing (Stripe Checkout + Customer Portal). The server
// validates the selection and computes the price from contracts/pricing.json;
// browser Price IDs, amounts and feature flags are never trusted. Entitlement
// changes only from verified webhooks reconciled against canonical Stripe state.
import Stripe from 'stripe';
import type { BillingQuote, CustomSelection, Invoice, PlanName, Subscription as SubscriptionView } from '@ayonix/contracts';
import { PricingError, betterValueRecommendation, billingCatalog, customQuote, entitlementFor, quoteConfigurationHash, standardPlan } from '@ayonix/domain';
import type { Env } from '../lib/env.js';
import { stripeConfigured } from '../lib/env.js';
import { AppError, forbidden, invalid, notFound } from '../lib/errors.js';
import { newId, nowIso } from '../lib/ids.js';
import { all, first, parseJson, run, stmt } from '../lib/db.js';
import { log } from '../security/redact.js';
import { auditStmt } from './audit.js';
import type { Actor } from './context.js';
import { authorize } from './context.js';
import { getSubscription, notifyWorkspace, type SubscriptionRow } from './workspace.js';

export const stripeTestHooks: { fetch: typeof fetch | null } = { fetch: null };

export function stripeClient(env: Env): Stripe {
  if (!stripeConfigured(env)) throw new AppError('not_configured', 'Billing is not configured on this deployment.');
  const f = env.ENVIRONMENT === 'test' && stripeTestHooks.fetch ? stripeTestHooks.fetch : undefined;
  return new Stripe(env.STRIPE_SECRET_KEY!, {
    httpClient: Stripe.createFetchHttpClient(f),
    maxNetworkRetries: 2,
    appInfo: { name: 'Ayonix-SNS' },
  });
}

export function catalog() {
  return billingCatalog();
}

const PLAN_RANK: Record<PlanName, number> = { trial: 0, basic: 1, standard: 2, premium: 3, custom: 0 };

function planValueCents(plan: PlanName, selection: CustomSelection | null): number {
  if (plan === 'trial') return 0;
  return entitlementFor(plan, selection).priceCents;
}

export async function createQuote(env: Env, actor: Actor, input: { plan: string; selection?: unknown }): Promise<BillingQuote> {
  authorize(actor, 'manage_billing');
  if (actor.via !== 'web') throw forbidden('Plans are managed on the Ayonix website');
  let priceCents: number;
  let selection: CustomSelection | null = null;
  let hash: string;
  let better: 'standard' | null = null;
  try {
    if (input.plan === 'custom') {
      const q = customQuote(input.selection ?? {});
      priceCents = q.priceCents;
      selection = q.selection;
      hash = await quoteConfigurationHash(q);
      better = betterValueRecommendation(q.selection, q.priceCents);
    } else if (['basic', 'standard', 'premium'].includes(input.plan)) {
      if (input.selection !== undefined) throw new PricingError('Fixed plans take no selection');
      priceCents = standardPlan(input.plan).priceCents;
      hash = await quoteConfigurationHash({ catalogVersion: billingCatalog().version, currency: 'USD', interval: 'month', priceCents, selection: { plan: input.plan } } as never);
    } else {
      throw new PricingError('Unknown plan', 'plan');
    }
  } catch (e) {
    if (e instanceof PricingError) throw invalid(e.message, e.field ? { [e.field]: e.message } : undefined);
    throw e;
  }
  const id = newId('quo');
  const expires = new Date(Date.now() + 30 * 60_000).toISOString();
  await run(env, `INSERT INTO billing_quotes(id, workspace_id, plan, catalog_version, selection_json, price_cents, configuration_hash, created_by, expires_at, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
    id, actor.workspaceId, input.plan, billingCatalog().version, selection ? JSON.stringify(selection) : null, priceCents, hash, actor.identityId, expires, nowIso());
  return { quote_id: id, plan: input.plan as BillingQuote['plan'], selection, price_cents: priceCents, currency: 'USD', catalog_version: billingCatalog().version, configuration_hash: hash, better_value: better, expires_at: expires };
}

async function priceIdFor(env: Env, stripe: Stripe, quote: { plan: string; price_cents: number; configuration_hash: string; selection_json: string | null; catalog_version: string }): Promise<string> {
  if (quote.plan === 'basic') return env.STRIPE_BASIC_PRICE_ID!;
  if (quote.plan === 'standard') return env.STRIPE_STANDARD_PRICE_ID!;
  if (quote.plan === 'premium') return env.STRIPE_PREMIUM_PRICE_ID!;
  const existing = await first<{ stripe_price_id: string; price_cents: number }>(env, 'SELECT stripe_price_id, price_cents FROM custom_prices WHERE configuration_hash = ?', quote.configuration_hash);
  if (existing) {
    if (existing.price_cents !== quote.price_cents) throw new AppError('internal', 'Custom price mismatch');
    return existing.stripe_price_id;
  }
  const lookupKey = `ayonix_custom_${quote.configuration_hash.slice(0, 40)}`;
  const found = await stripe.prices.list({ lookup_keys: [lookupKey], active: true, limit: 1 });
  let price = found.data[0];
  if (price && (price.unit_amount !== quote.price_cents || price.currency !== 'usd' || price.recurring?.interval !== 'month')) {
    throw new AppError('internal', 'Stripe custom price does not match the server quote');
  }
  if (!price) {
    price = await stripe.prices.create(
      {
        product: env.STRIPE_PRODUCT_ID!,
        currency: 'usd',
        unit_amount: quote.price_cents,
        recurring: { interval: 'month' },
        lookup_key: lookupKey,
        nickname: `Custom ${quote.catalog_version}`,
        metadata: { configuration_hash: quote.configuration_hash, catalog_version: quote.catalog_version },
      },
      { idempotencyKey: `custom-price-${quote.configuration_hash}` },
    );
  }
  await run(env, `INSERT INTO custom_prices(configuration_hash, catalog_version, price_cents, selection_json, stripe_price_id, created_at) VALUES (?,?,?,?,?,?) ON CONFLICT(configuration_hash) DO NOTHING`,
    quote.configuration_hash, quote.catalog_version, quote.price_cents, quote.selection_json ?? '{}', price.id, nowIso());
  return price.id;
}

async function ensureCustomer(env: Env, stripe: Stripe, actor: Actor, sub: SubscriptionRow): Promise<string> {
  if (sub.stripe_customer_id) return sub.stripe_customer_id;
  const ws = await first<{ name: string }>(env, 'SELECT name FROM workspaces WHERE id = ?', actor.workspaceId);
  const customer = await stripe.customers.create({ email: actor.email, name: ws?.name, metadata: { workspace_id: actor.workspaceId } }, { idempotencyKey: `customer-${actor.workspaceId}` });
  await run(env, 'UPDATE subscriptions SET stripe_customer_id = ?, updated_at = ? WHERE workspace_id = ? AND stripe_customer_id IS NULL', customer.id, nowIso(), actor.workspaceId);
  const fresh = await getSubscription(env, actor.workspaceId);
  return fresh!.stripe_customer_id!;
}

/**
 * Start Stripe Checkout for a new subscription, or change an existing one.
 * Upgrades are charged now and grant only the allowance difference;
 * downgrades take effect at the next renewal.
 */
export async function checkout(env: Env, actor: Actor, input: { quote_id: string }): Promise<{ kind: 'redirect'; url: string } | { kind: 'changed'; effective_at: string; immediate: boolean }> {
  authorize(actor, 'manage_billing');
  if (actor.via !== 'web') throw forbidden('Plans are managed on the Ayonix website');
  const quote = await first<{ id: string; plan: string; price_cents: number; configuration_hash: string; selection_json: string | null; catalog_version: string; expires_at: string; used_at: string | null }>(
    env, 'SELECT * FROM billing_quotes WHERE workspace_id = ? AND id = ?', actor.workspaceId, input.quote_id);
  if (!quote) throw notFound('Quote');
  if (quote.expires_at < nowIso()) throw new AppError('conflict', 'This quote expired. Choose the plan again.');
  if (quote.catalog_version !== billingCatalog().version) throw new AppError('conflict', 'Prices were updated. Choose the plan again.');
  const stripe = stripeClient(env);
  const sub = (await getSubscription(env, actor.workspaceId))!;
  const priceId = await priceIdFor(env, stripe, quote);
  await run(env, 'UPDATE billing_quotes SET stripe_price_id = ? WHERE id = ?', priceId, quote.id);
  const customer = await ensureCustomer(env, stripe, actor, sub);
  const live = sub.stripe_subscription_id && ['active', 'trialing', 'past_due', 'unpaid', 'incomplete'].includes(sub.status);
  if (!live) {
    const session = await stripe.checkout.sessions.create(
      {
        mode: 'subscription',
        customer,
        client_reference_id: actor.workspaceId,
        line_items: [{ price: priceId, quantity: 1 }],
        metadata: { workspace_id: actor.workspaceId, quote_id: quote.id, plan: quote.plan, configuration_hash: quote.configuration_hash },
        subscription_data: { metadata: { workspace_id: actor.workspaceId, plan: quote.plan, configuration_hash: quote.configuration_hash } },
        success_url: `${env.APP_ORIGIN}/billings?checkout=returned&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${env.APP_ORIGIN}/billings?checkout=canceled`,
        allow_promotion_codes: false,
      },
      { idempotencyKey: `checkout-${quote.id}` },
    );
    await env.DB.batch([
      stmt(env, 'UPDATE billing_quotes SET used_at = COALESCE(used_at, ?) WHERE id = ?', nowIso(), quote.id),
      auditStmt(env, actor, 'billing.checkout_started', 'billing_quote', quote.id, { plan: quote.plan, price_cents: quote.price_cents }),
    ]);
    if (!session.url) throw new AppError('upstream_error', 'Stripe did not return a checkout URL', { retryable: true });
    return { kind: 'redirect', url: session.url };
  }
  // Existing subscription: change plan.
  const stripeSub = await stripe.subscriptions.retrieve(sub.stripe_subscription_id!);
  const item = stripeSub.items.data[0];
  if (!item) throw new AppError('upstream_error', 'Subscription has no items');
  const currentValue = planValueCents(sub.plan ?? 'basic', parseJson<CustomSelection | null>(sub.selection_json, null));
  const upgrade = quote.price_cents > currentValue;
  const periodEnd = periodBounds(stripeSub).end;
  if (upgrade) {
    // error_if_incomplete: a successful call means the proration was paid.
    await stripe.subscriptions.update(sub.stripe_subscription_id!, {
      items: [{ id: item.id, price: priceId }],
      proration_behavior: 'always_invoice',
      payment_behavior: 'error_if_incomplete',
      metadata: { workspace_id: actor.workspaceId, plan: quote.plan, configuration_hash: quote.configuration_hash },
    }, { idempotencyKey: `change-${quote.id}` });
  } else {
    await stripe.subscriptions.update(sub.stripe_subscription_id!, {
      items: [{ id: item.id, price: priceId }],
      proration_behavior: 'none',
      metadata: { workspace_id: actor.workspaceId, plan: quote.plan, configuration_hash: quote.configuration_hash },
    }, { idempotencyKey: `change-${quote.id}` });
    await run(env, `UPDATE subscriptions SET pending_plan = ?, pending_selection_json = ?, pending_effective_at = ?, updated_at = ? WHERE workspace_id = ?`, quote.plan, quote.selection_json, periodEnd, nowIso(), actor.workspaceId);
  }
  await env.DB.batch([
    stmt(env, 'UPDATE billing_quotes SET used_at = COALESCE(used_at, ?) WHERE id = ?', nowIso(), quote.id),
    auditStmt(env, actor, upgrade ? 'billing.upgraded' : 'billing.downgrade_scheduled', 'billing_quote', quote.id, { plan: quote.plan, effective_at: upgrade ? 'now' : periodEnd }),
  ]);
  return { kind: 'changed', effective_at: upgrade ? nowIso() : periodEnd ?? nowIso(), immediate: upgrade };
}

export async function portal(env: Env, actor: Actor): Promise<{ url: string }> {
  authorize(actor, 'manage_billing');
  if (actor.via !== 'web') throw forbidden('Billing is managed on the Ayonix website');
  const sub = await getSubscription(env, actor.workspaceId);
  if (!sub?.stripe_customer_id) throw new AppError('conflict', 'There is no billing account yet.');
  const session = await stripeClient(env).billingPortal.sessions.create({ customer: sub.stripe_customer_id, return_url: `${env.APP_ORIGIN}/billings` });
  return { url: session.url };
}

export async function subscriptionView(env: Env, actor: Actor): Promise<SubscriptionView> {
  authorize(actor, 'read');
  const sub = await getSubscription(env, actor.workspaceId);
  return {
    plan: sub?.plan ?? null,
    status: sub?.status ?? 'none',
    price_cents: sub?.unit_amount_cents ?? null,
    current_period_end: sub?.current_period_end ?? null,
    cancel_at_period_end: sub?.cancel_at_period_end === 1,
    pending_change: sub?.pending_plan && sub.pending_effective_at ? { plan: sub.pending_plan as PlanName, effective_at: sub.pending_effective_at } : null,
    trial_ends_at: sub?.trial_ends_at ?? null,
    portal_available: Boolean(sub?.stripe_customer_id) && stripeConfigured(env),
  };
}

export async function listInvoices(env: Env, actor: Actor): Promise<Invoice[]> {
  authorize(actor, 'manage_billing');
  return all<Invoice>(env, `SELECT id, number, status, amount_due_cents, amount_paid_cents, currency, hosted_invoice_url, period_start, period_end, created_at FROM invoices WHERE workspace_id = ? ORDER BY created_at DESC LIMIT 50`, actor.workspaceId);
}

// ---------------------------------------------------------------------------
// Webhooks

const STATUS_MAP: Record<string, SubscriptionRow['status']> = {
  active: 'active',
  trialing: 'trialing',
  past_due: 'past_due',
  unpaid: 'unpaid',
  canceled: 'canceled',
  incomplete: 'incomplete',
  incomplete_expired: 'expired',
  paused: 'suspended',
};

const toIso = (s: number | null | undefined) => (typeof s === 'number' ? new Date(s * 1000).toISOString() : null);

function periodBounds(s: Stripe.Subscription): { start: string | null; end: string | null } {
  const item = s.items?.data?.[0] as (Stripe.SubscriptionItem & { current_period_start?: number; current_period_end?: number }) | undefined;
  const legacy = s as unknown as { current_period_start?: number; current_period_end?: number };
  return { start: toIso(item?.current_period_start ?? legacy.current_period_start), end: toIso(item?.current_period_end ?? legacy.current_period_end) };
}

async function planForPrice(env: Env, priceId: string): Promise<{ plan: PlanName; selection: CustomSelection | null } | null> {
  if (priceId === env.STRIPE_BASIC_PRICE_ID) return { plan: 'basic', selection: null };
  if (priceId === env.STRIPE_STANDARD_PRICE_ID) return { plan: 'standard', selection: null };
  if (priceId === env.STRIPE_PREMIUM_PRICE_ID) return { plan: 'premium', selection: null };
  const c = await first<{ selection_json: string }>(env, 'SELECT selection_json FROM custom_prices WHERE stripe_price_id = ?', priceId);
  if (!c) return null;
  // Re-validate stored selection against the catalog (defense against tampering).
  return { plan: 'custom', selection: customQuote(JSON.parse(c.selection_json)).selection };
}

/** Apply canonical Stripe subscription state. Idempotent and order-independent. */
export async function syncSubscription(env: Env, workspaceId: string, s: Stripe.Subscription, eventCreated: number, requestId: string) {
  const row = (await getSubscription(env, workspaceId))!;
  const liveStates = ['active', 'trialing', 'past_due'];
  if (row.stripe_subscription_id && row.stripe_subscription_id !== s.id && liveStates.includes(row.status) && !liveStates.includes(s.status)) {
    // An older/other subscription's terminal state must not overwrite the current live one.
    log('warn', 'billing.ignored_other_subscription', { workspace_id: workspaceId, status: s.status });
    return;
  }
  const priceId = s.items.data[0]?.price.id;
  const mapped = priceId ? await planForPrice(env, priceId) : null;
  if (!mapped) {
    log('error', 'billing.unknown_price', { workspace_id: workspaceId, price: priceId });
    throw new AppError('internal', 'Unknown Stripe price on subscription');
  }
  const status = STATUS_MAP[s.status] ?? 'suspended';
  const { start, end } = periodBounds(s);
  const ent = entitlementFor(mapped.plan, mapped.selection);
  const samePeriod = row.current_period_start === start;
  const currentValue = row.plan && row.plan !== 'trial' ? planValueCents(row.plan, parseJson<CustomSelection | null>(row.selection_json, null)) : 0;
  const isDowngradeInPeriod = samePeriod && row.plan && row.plan !== 'trial' && ent.priceCents < currentValue && ['active', 'trialing', 'past_due'].includes(status);
  const now = nowIso();
  const statements: D1PreparedStatement[] = [];
  let effectivePlan: PlanName = mapped.plan;
  let effectiveSelection = mapped.selection;
  if (isDowngradeInPeriod) {
    effectivePlan = row.plan!;
    effectiveSelection = parseJson<CustomSelection | null>(row.selection_json, null);
    statements.push(stmt(env, `UPDATE subscriptions SET pending_plan = ?, pending_selection_json = ?, pending_effective_at = ? WHERE workspace_id = ?`, mapped.plan, mapped.selection ? JSON.stringify(mapped.selection) : null, end, workspaceId));
  } else if (!samePeriod) {
    statements.push(stmt(env, `UPDATE subscriptions SET pending_plan = NULL, pending_selection_json = NULL, pending_effective_at = NULL WHERE workspace_id = ?`, workspaceId));
  }
  const effectiveEnt = entitlementFor(effectivePlan, effectiveSelection);
  const changed = row.plan !== effectivePlan || row.status !== status || row.selection_json !== (effectiveSelection ? JSON.stringify(effectiveSelection) : null);
  statements.push(
    stmt(env, `UPDATE subscriptions SET plan = ?, status = ?, selection_json = ?, unit_amount_cents = ?, stripe_subscription_id = ?, stripe_price_id = ?, catalog_version = ?,
      current_period_start = ?, current_period_end = ?, cancel_at_period_end = ?, trial_ends_at = ?, past_due_since = CASE WHEN ? = 'past_due' THEN COALESCE(past_due_since, ?) ELSE NULL END,
      last_event_created = MAX(last_event_created, ?), entitlement_version = entitlement_version + ?, updated_at = ? WHERE workspace_id = ?`,
      effectivePlan, status, effectiveSelection ? JSON.stringify(effectiveSelection) : null, effectiveEnt.priceCents, s.id, priceId, billingCatalog().version,
      start, end, s.cancel_at_period_end ? 1 : 0, toIso(s.trial_end), status, now, eventCreated, changed ? 1 : 0, now, workspaceId),
  );
  // Allowance for the current paid cycle: create the period, or grant only the difference on upgrade.
  if (start && end && ['active', 'trialing'].includes(status)) {
    statements.push(
      stmt(env, `INSERT INTO quota_periods(id, workspace_id, source, external_ref, starts_at, ends_at, allowance, created_at) VALUES (?,?,?,?,?,?,?,?)
        ON CONFLICT(workspace_id, starts_at) DO UPDATE SET allowance = MAX(allowance, excluded.allowance), ends_at = excluded.ends_at, version = version + 1`,
        newId('qp'), workspaceId, 'subscription', s.id, start, end, effectiveEnt.posts, now),
      // A trial period overlapping the paid cycle ends when the paid cycle starts.
      stmt(env, `UPDATE quota_periods SET ends_at = ? WHERE workspace_id = ? AND source = 'trial' AND ends_at > ? AND starts_at < ?`, start, workspaceId, start, start),
    );
  }
  if (changed) statements.push(auditStmt(env, { workspaceId, actorType: 'stripe', requestId }, 'billing.subscription_synced', 'subscription', s.id, { plan: effectivePlan, status, downgrade_pending: Boolean(isDowngradeInPeriod) }));
  await env.DB.batch(statements);
  if (status === 'past_due' && row.status !== 'past_due') {
    await notifyWorkspace(env, workspaceId, 'payment_failed', 'Ayonix-SNS payment failed', `A payment for your Ayonix-SNS subscription failed. New schedules are paused and due posts are held for up to 72 hours.\n\nUpdate your payment method: ${env.APP_ORIGIN}/billings`, `past_due:${s.id}:${start}`);
  }
}

async function upsertInvoice(env: Env, workspaceId: string, inv: Stripe.Invoice) {
  const now = nowIso();
  const tax = (inv as unknown as { total_taxes?: Array<{ amount: number }>; tax?: number | null }).total_taxes?.reduce((a, t) => a + t.amount, 0) ?? (inv as unknown as { tax?: number | null }).tax ?? null;
  await run(env, `INSERT INTO invoices(id, workspace_id, stripe_invoice_id, number, status, amount_due_cents, amount_paid_cents, subtotal_cents, tax_cents, currency, hosted_invoice_url, period_start, period_end, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(stripe_invoice_id) DO UPDATE SET status = excluded.status, amount_due_cents = excluded.amount_due_cents, amount_paid_cents = excluded.amount_paid_cents, number = excluded.number,
      hosted_invoice_url = excluded.hosted_invoice_url, subtotal_cents = excluded.subtotal_cents, tax_cents = excluded.tax_cents, updated_at = excluded.updated_at`,
    newId('inv'), workspaceId, inv.id, inv.number ?? null, inv.status ?? 'unknown', inv.amount_due, inv.amount_paid, inv.subtotal ?? null, tax, inv.currency, inv.hosted_invoice_url ?? null,
    toIso(inv.period_start), toIso(inv.period_end), toIso(inv.created) ?? now, now);
}

function invoiceSubscriptionId(inv: Stripe.Invoice): string | null {
  const legacy = (inv as unknown as { subscription?: string | { id: string } | null }).subscription;
  if (legacy) return typeof legacy === 'string' ? legacy : legacy.id;
  const parent = (inv as unknown as { parent?: { subscription_details?: { subscription?: string | { id: string } } } }).parent;
  const s = parent?.subscription_details?.subscription;
  return s ? (typeof s === 'string' ? s : s.id) : null;
}

/** Verify the raw body signature, deduplicate by event ID and apply. */
export async function handleStripeWebhook(env: Env, rawBody: string, signature: string | null, requestId: string): Promise<{ status: number; body: Record<string, unknown> }> {
  if (!stripeConfigured(env)) return { status: 503, body: { error: 'billing_not_configured' } };
  if (!signature) return { status: 400, body: { error: 'missing_signature' } };
  const stripe = stripeClient(env);
  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(rawBody, signature, env.STRIPE_WEBHOOK_SECRET!, 300, Stripe.createSubtleCryptoProvider());
  } catch {
    log('warn', 'stripe.signature_invalid', { request_id: requestId });
    return { status: 400, body: { error: 'invalid_signature' } };
  }
  const existing = await first<{ status: string }>(env, `SELECT status FROM billing_events WHERE provider = 'stripe' AND event_id = ?`, event.id);
  if (existing && (existing.status === 'applied' || existing.status === 'ignored')) return { status: 200, body: { received: true, duplicate: true } };
  if (!existing) {
    await run(env, `INSERT INTO billing_events(provider, event_id, type, event_created, status, received_at) VALUES ('stripe',?,?,?,?,?) ON CONFLICT(provider, event_id) DO NOTHING`, event.id, event.type, event.created, 'received', nowIso());
  }
  try {
    const result = await applyStripeEvent(env, stripe, event, requestId);
    await run(env, `UPDATE billing_events SET status = ?, workspace_id = ?, applied_at = ?, error = NULL WHERE provider = 'stripe' AND event_id = ?`, result.applied ? 'applied' : 'ignored', result.workspaceId, nowIso(), event.id);
    return { status: 200, body: { received: true } };
  } catch (e) {
    const msg = e instanceof Error ? e.message.slice(0, 300) : 'error';
    await run(env, `UPDATE billing_events SET status = 'failed', error = ? WHERE provider = 'stripe' AND event_id = ?`, msg, event.id);
    log('error', 'stripe.apply_failed', { event_type: event.type, request_id: requestId, error: msg });
    // Retryable: Stripe redelivers and we reprocess from canonical state.
    return { status: 500, body: { error: 'processing_failed' } };
  }
}

async function workspaceForCustomer(env: Env, customer: string | { id: string } | null | undefined): Promise<string | null> {
  const id = typeof customer === 'string' ? customer : customer?.id;
  if (!id) return null;
  return (await first<{ workspace_id: string }>(env, 'SELECT workspace_id FROM subscriptions WHERE stripe_customer_id = ?', id))?.workspace_id ?? null;
}

async function applyStripeEvent(env: Env, stripe: Stripe, event: Stripe.Event, requestId: string): Promise<{ applied: boolean; workspaceId: string | null }> {
  const obj = event.data.object as unknown as Record<string, unknown>;
  switch (event.type) {
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded':
    case 'checkout.session.async_payment_failed': {
      const session = event.data.object as Stripe.Checkout.Session;
      const ws = await workspaceForCustomer(env, session.customer);
      // Metadata is only accepted when it agrees with the server-owned customer mapping.
      if (!ws || (session.metadata?.workspace_id && session.metadata.workspace_id !== ws)) return { applied: false, workspaceId: ws };
      if (session.subscription) {
        const s = await stripe.subscriptions.retrieve(typeof session.subscription === 'string' ? session.subscription : session.subscription.id);
        await syncSubscription(env, ws, s, event.created, requestId);
      }
      return { applied: true, workspaceId: ws };
    }
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted':
    case 'customer.subscription.trial_will_end':
    case 'customer.subscription.paused':
    case 'customer.subscription.resumed': {
      const ws = await workspaceForCustomer(env, obj.customer as string);
      if (!ws) return { applied: false, workspaceId: null };
      const s = await stripe.subscriptions.retrieve(obj.id as string);
      await syncSubscription(env, ws, s, event.created, requestId);
      if (event.type === 'customer.subscription.trial_will_end') {
        await notifyWorkspace(env, ws, 'payment_failed', 'Your Ayonix-SNS trial ends soon', `Your trial ends on ${toIso(s.trial_end)}. Manage billing: ${env.APP_ORIGIN}/billings`, `trial_end:${s.id}`);
      }
      return { applied: true, workspaceId: ws };
    }
    case 'invoice.paid':
    case 'invoice.payment_succeeded':
    case 'invoice.payment_failed':
    case 'invoice.finalized':
    case 'invoice.voided':
    case 'invoice.marked_uncollectible': {
      const ws = await workspaceForCustomer(env, obj.customer as string);
      if (!ws) return { applied: false, workspaceId: null };
      const inv = await stripe.invoices.retrieve(obj.id as string);
      await upsertInvoice(env, ws, inv);
      const subId = invoiceSubscriptionId(inv);
      if (subId) await syncSubscription(env, ws, await stripe.subscriptions.retrieve(subId), event.created, requestId);
      return { applied: true, workspaceId: ws };
    }
    default:
      return { applied: false, workspaceId: null };
  }
}

/** Operator replay of a stored event (audited); re-fetches from Stripe and re-applies. */
export async function replayStripeEvent(env: Env, eventId: string, operator: string) {
  const stripe = stripeClient(env);
  const event = await stripe.events.retrieve(eventId);
  const result = await applyStripeEvent(env, stripe, event, `replay:${operator}`);
  await run(env, `UPDATE billing_events SET status = ?, applied_at = ?, error = NULL WHERE provider = 'stripe' AND event_id = ?`, result.applied ? 'applied' : 'ignored', nowIso(), eventId);
  if (result.workspaceId) await auditStmt(env, { workspaceId: result.workspaceId, actorType: 'staff', requestId: `replay:${operator}` }, 'billing.event_replayed', 'billing_event', eventId).run();
  return result;
}

export { PLAN_RANK };
