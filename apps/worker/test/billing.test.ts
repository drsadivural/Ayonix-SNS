// CONTRACT TEST: Stripe webhook verification and entitlement sync with a
// Stripe API DOUBLE (fetch injection) and test-signed events. This is NOT a
// Stripe sandbox run; BILL-03 still requires real sandbox evidence.
import { SELF } from 'cloudflare:test';
import Stripe from 'stripe';
import { afterEach, describe, expect, it } from 'vitest';
import { makeWorkspace, testEnv, uid } from './helpers.js';
import { stripeTestHooks, createQuote } from '../src/services/billing.js';

const SECRET = 'whsec_contract_test_secret';
const stripe = new Stripe('sk_test_contract_double', { httpClient: Stripe.createFetchHttpClient() });
const period = { start: Math.floor(Date.now() / 1000) - 60, end: Math.floor(Date.now() / 1000) + 30 * 86400 };

function subscription(id: string, customer: string, status: string, price: string, p = period) {
  return { id, object: 'subscription', customer, status, cancel_at_period_end: false, trial_end: null, items: { object: 'list', data: [{ id: 'si_1', object: 'subscription_item', price: { id: price, object: 'price' }, current_period_start: p.start, current_period_end: p.end }] } };
}

const canonical: Record<string, unknown> = {};
afterEach(() => {
  stripeTestHooks.fetch = null;
});
function stripeDouble() {
  stripeTestHooks.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
    const id = url.pathname.split('/').pop()!;
    const obj = canonical[id];
    return new Response(JSON.stringify(obj ?? { error: { message: 'not found' } }), { status: obj ? 200 : 404, headers: { 'content-type': 'application/json', 'request-id': 'req_test' } });
  }) as typeof fetch;
}

async function send(event: Record<string, unknown>, secret = SECRET) {
  const payload = JSON.stringify(event);
  const header = await stripe.webhooks.generateTestHeaderStringAsync({ payload, secret, cryptoProvider: Stripe.createSubtleCryptoProvider() });
  return SELF.fetch('http://localhost:8787/webhooks/stripe', { method: 'POST', headers: { 'stripe-signature': header, 'content-type': 'application/json' }, body: payload });
}

async function setup() {
  const f = await makeWorkspace({ plan: 'basic', status: 'none' });
  const customer = uid('cus');
  await testEnv.DB.prepare(`UPDATE subscriptions SET plan = NULL, status = 'none', current_period_start = NULL, current_period_end = NULL, stripe_customer_id = ? WHERE workspace_id = ?`).bind(customer, f.workspaceId).run();
  await testEnv.DB.prepare('DELETE FROM quota_periods WHERE workspace_id = ?').bind(f.workspaceId).run();
  return { f, customer };
}

const sub = (ws: string) => testEnv.DB.prepare('SELECT plan, status, entitlement_version, pending_plan FROM subscriptions WHERE workspace_id = ?').bind(ws).first<Record<string, unknown>>();

describe('stripe webhooks', () => {
  it('BILL-04: forged signatures are rejected', async () => {
    const r = await send({ id: uid('evt'), type: 'customer.subscription.updated', created: 1, data: { object: {} } }, 'whsec_wrong');
    expect(r.status).toBe(400);
  });

  it('grants entitlement from canonical state; duplicates are idempotent; stale events cannot restore canceled access', async () => {
    stripeDouble();
    const { f, customer } = await setup();
    const subId = uid('sub');
    canonical[subId] = subscription(subId, customer, 'active', 'price_standard_test');
    const evt = { id: uid('evt'), object: 'event', type: 'customer.subscription.created', created: 100, data: { object: { id: subId, customer } } };
    expect((await send(evt)).status).toBe(200);
    expect(await sub(f.workspaceId)).toMatchObject({ plan: 'standard', status: 'active' });
    const qp = await testEnv.DB.prepare('SELECT allowance FROM quota_periods WHERE workspace_id = ?').bind(f.workspaceId).first<{ allowance: number }>();
    expect(qp!.allowance).toBe(60);
    const v1 = (await sub(f.workspaceId))!.entitlement_version;
    const dup = await send(evt);
    expect(await dup.json()).toMatchObject({ duplicate: true });
    expect((await sub(f.workspaceId))!.entitlement_version).toBe(v1);
    const periods = await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM quota_periods WHERE workspace_id = ?').bind(f.workspaceId).first<{ n: number }>();
    expect(periods!.n).toBe(1);
    // Cancellation, then a stale "updated(active)" event arrives late: canonical state wins.
    canonical[subId] = subscription(subId, customer, 'canceled', 'price_standard_test');
    await send({ id: uid('evt'), object: 'event', type: 'customer.subscription.deleted', created: 300, data: { object: { id: subId, customer } } });
    await send({ id: uid('evt'), object: 'event', type: 'customer.subscription.updated', created: 200, data: { object: { id: subId, customer, status: 'active' } } });
    expect(await sub(f.workspaceId)).toMatchObject({ status: 'canceled' });
  });

  it('QUOTA-03: upgrade grants only the difference; downgrade waits for renewal', async () => {
    stripeDouble();
    const { f, customer } = await setup();
    const subId = uid('sub');
    canonical[subId] = subscription(subId, customer, 'active', 'price_basic_test');
    await send({ id: uid('evt'), object: 'event', type: 'customer.subscription.created', created: 1, data: { object: { id: subId, customer } } });
    await testEnv.DB.prepare('UPDATE quota_periods SET used = 15 WHERE workspace_id = ?').bind(f.workspaceId).run();
    canonical[subId] = subscription(subId, customer, 'active', 'price_premium_test');
    await send({ id: uid('evt'), object: 'event', type: 'customer.subscription.updated', created: 2, data: { object: { id: subId, customer } } });
    const up = await testEnv.DB.prepare('SELECT allowance, used FROM quota_periods WHERE workspace_id = ?').bind(f.workspaceId).first<{ allowance: number; used: number }>();
    expect(up).toEqual({ allowance: 120, used: 15 });
    canonical[subId] = subscription(subId, customer, 'active', 'price_basic_test');
    await send({ id: uid('evt'), object: 'event', type: 'customer.subscription.updated', created: 3, data: { object: { id: subId, customer } } });
    expect(await sub(f.workspaceId)).toMatchObject({ plan: 'premium', pending_plan: 'basic' });
    // Renewal: new period → downgrade applies to the new cycle.
    canonical[subId] = subscription(subId, customer, 'active', 'price_basic_test', { start: period.end, end: period.end + 30 * 86400 });
    await send({ id: uid('evt'), object: 'event', type: 'customer.subscription.updated', created: 4, data: { object: { id: subId, customer } } });
    expect(await sub(f.workspaceId)).toMatchObject({ plan: 'basic', pending_plan: null });
  });

  it('events for unknown customers are ignored, never mapped by metadata alone', async () => {
    stripeDouble();
    const { f } = await setup();
    const subId = uid('sub');
    canonical[subId] = subscription(subId, 'cus_attacker', 'active', 'price_premium_test');
    const r = await send({ id: uid('evt'), object: 'event', type: 'checkout.session.completed', created: 1, data: { object: { id: 'cs_1', customer: 'cus_attacker', subscription: subId, metadata: { workspace_id: f.workspaceId } } } });
    expect(r.status).toBe(200);
    expect(await sub(f.workspaceId)).toMatchObject({ status: 'none' });
  });
});

describe('quotes', () => {
  it('BILL-02: server computes Custom prices; tampered input rejected; max $1,000', async () => {
    const f = await makeWorkspace();
    const max = await createQuote(testEnv, f.owner, { plan: 'custom', selection: { posts: 1000, products: 50, autoLearn: true, competitorCheck: true, similarResearch: true } });
    expect(max.price_cents).toBe(100000);
    const min = await createQuote(testEnv, f.owner, { plan: 'custom', selection: {} });
    expect(min.price_cents).toBe(4900);
    const ex = await createQuote(testEnv, f.owner, { plan: 'custom', selection: { posts: 120, products: 10, autoLearn: true } });
    expect(ex.price_cents).toBe(27800);
    for (const bad of [{ posts: 121 }, { priceCents: 1 }, { autoLearn: 'true' }, { stripe_price_id: 'price_x' }]) {
      await expect(createQuote(testEnv, f.owner, { plan: 'custom', selection: bad })).rejects.toMatchObject({ code: 'invalid_request' });
    }
    await expect(createQuote(testEnv, f.owner, { plan: 'standard', selection: { posts: 1000 } })).rejects.toMatchObject({ code: 'invalid_request' });
    expect((await createQuote(testEnv, f.owner, { plan: 'basic' })).price_cents).toBe(4900);
    expect((await createQuote(testEnv, f.owner, { plan: 'standard' })).price_cents).toBe(9900);
    expect((await createQuote(testEnv, f.owner, { plan: 'premium' })).price_cents).toBe(19900);
    const better = await createQuote(testEnv, f.owner, { plan: 'custom', selection: { posts: 60, products: 3, autoLearn: true } });
    expect(better.better_value).toBe('standard');
    await expect(createQuote(testEnv, { ...f.owner, via: 'mcp', scopes: ['sns:read', 'sns:draft', 'sns:schedule', 'sns:cancel'] }, { plan: 'basic' })).rejects.toMatchObject({ code: 'forbidden' });
  });
});
