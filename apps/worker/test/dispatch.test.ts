// CONTRACT TEST of the durable dispatcher with a provider DOUBLE and controlled
// failure injection, against real local D1/Queues/Durable Objects.
// Not live provider evidence (docs/10-ACCEPTANCE.md).
import { afterEach, describe, expect, it } from 'vitest';
import { future, makeWorkspace, storeFakeToken, testEnv, uid, type Fixture } from './helpers.js';
import { createCampaign, preparePost } from '../src/services/campaigns.js';
import { confirmSchedule, previewSchedule } from '../src/services/schedules.js';
import { testHooks, sweepExpiredClaims } from '../src/jobs/dispatch.js';
import { handlePublishMessage } from '../src/jobs/queue.js';
import { coordinator } from '../src/jobs/coordinator.js';
import { scanOutbox } from '../src/jobs/cron.js';
import { ProviderError, type ProviderAdapter, type Receipt } from '../src/providers/types.js';
import type { QueueMessage } from '../src/lib/env.js';

const receipt = (remoteId: string | null, extra: Partial<Receipt> = {}): Receipt => ({ remoteId, containerId: null, publishId: null, url: remoteId ? `https://www.linkedin.com/feed/update/${remoteId}` : null, state: {}, ...extra });

function fakeAdapter(behavior: { submit: () => Promise<unknown>; poll?: () => Promise<unknown> }) {
  const calls = { submit: 0, poll: 0 };
  const a = {
    provider: 'linkedin',
    configured: () => true,
    scopes: () => [],
    authorizeUrl: () => '',
    exchangeCode: async () => ({ accessToken: '', scopes: [] }),
    discoverAccounts: async () => [],
    probeCapabilities: async () => [],
    refreshOrReconnect: async () => ({ kind: 'reconnect_required', reason: 'x' }),
    validatePost: () => [],
    uploadMedia: async () => ({}),
    submitPost: async () => {
      calls.submit++;
      return behavior.submit();
    },
    pollStatus: async () => {
      calls.poll++;
      return behavior.poll!();
    },
    fetchMetrics: async () => [],
    disconnect: async () => ({ revoked: false }),
  } as unknown as ProviderAdapter;
  testHooks.adapter = () => a;
  return calls;
}

afterEach(() => {
  testHooks.adapter = null;
});

async function scheduled(f: Fixture, minutesAhead = 3) {
  await storeFakeToken(f, f.connections.linkedin!);
  const c = await createCampaign(testEnv, f.owner, { product_id: f.productId, goal: 'g', audience: 'a', language: 'en', idempotency_key: uid('k') });
  const post = await preparePost(testEnv, f.owner, { campaign_id: c.id, idempotency_key: uid('k'), targets: [{ platform: 'linkedin', connection_id: f.connections.linkedin!, format: 'text', caption: 'Hello', asset_ids: [] }] });
  const p = await previewSchedule(testEnv, f.owner, [{ post_id: post.post_id, revision: post.revision, scheduled_at_utc: future(minutesAhead), timezone: 'UTC' }]);
  const r = await confirmSchedule(testEnv, f.owner, { preview_token: p.preview_token!, confirmed: true, idempotency_key: uid('k') });
  const targetId = r.target_ids[0]!;
  // Make it due now (simulates the clock reaching due time).
  await testEnv.DB.prepare(`UPDATE targets SET due_at = ? WHERE id = ?`).bind(new Date(Date.now() - 1000).toISOString(), targetId).run();
  await testEnv.DB.prepare(`UPDATE outbox SET next_attempt_at = ? WHERE target_id = ?`).bind(new Date(Date.now() - 1000).toISOString(), targetId).run();
  const outbox = await testEnv.DB.prepare('SELECT id FROM outbox WHERE target_id = ?').bind(targetId).first<{ id: string }>();
  const msg: QueueMessage = { kind: 'dispatch', workspace_id: f.workspaceId, target_id: targetId, revision: 1, outbox_id: outbox!.id };
  return { targetId, msg };
}

const target = (id: string) => testEnv.DB.prepare('SELECT * FROM targets WHERE id = ?').bind(id).first<Record<string, unknown>>();
const quota = (f: Fixture) => testEnv.DB.prepare('SELECT used, reserved FROM quota_periods WHERE id = ?').bind(f.periodId).first<{ used: number; reserved: number }>();

describe('dispatch', () => {
  it('publishes once, commits quota, and ignores duplicate deliveries', async () => {
    const f = await makeWorkspace();
    const calls = fakeAdapter({ submit: async () => ({ kind: 'published', receipt: receipt('urn:li:share:123') }) });
    const { targetId, msg } = await scheduled(f);
    await handlePublishMessage(testEnv, msg, 'w1');
    await handlePublishMessage(testEnv, msg, 'w2'); // queue redelivery
    expect(calls.submit).toBe(1);
    const t = await target(targetId);
    expect(t).toMatchObject({ status: 'published', provider_post_id: 'urn:li:share:123' });
    expect(await quota(f)).toEqual({ used: 1, reserved: 0 });
    const r = await testEnv.DB.prepare('SELECT remote_id, status, verified_at FROM provider_receipts WHERE target_id = ?').bind(targetId).first<Record<string, string>>();
    expect(r!.remote_id).toBe('urn:li:share:123');
    expect(r!.verified_at).toBeTruthy();
  });

  it('cron leases due outbox rows and enqueues them', async () => {
    const f = await makeWorkspace();
    fakeAdapter({ submit: async () => ({ kind: 'published', receipt: receipt('urn:li:share:9') }) });
    const { targetId } = await scheduled(f);
    const r = await scanOutbox(testEnv);
    expect(r.enqueued).toBeGreaterThanOrEqual(1);
    expect((await target(targetId))!.status).toBe('queued');
    const ob = await testEnv.DB.prepare('SELECT state FROM outbox WHERE target_id = ?').bind(targetId).first<{ state: string }>();
    expect(ob!.state).toBe('enqueued');
  });

  it('processing is not published; poll completes it', async () => {
    const f = await makeWorkspace();
    const calls = fakeAdapter({
      submit: async () => ({ kind: 'processing', pollAfterSeconds: 5, receipt: receipt(null, { containerId: 'c1' }) }),
      poll: async () => ({ kind: 'published', receipt: receipt('urn:li:share:77', { containerId: 'c1' }) }),
    });
    const { targetId, msg } = await scheduled(f);
    await handlePublishMessage(testEnv, msg, 'w1');
    expect((await target(targetId))!.status).toBe('processing');
    expect(await quota(f)).toEqual({ used: 0, reserved: 1 });
    const poll = await testEnv.DB.prepare(`SELECT id FROM outbox WHERE target_id = ? AND kind = 'poll'`).bind(targetId).first<{ id: string }>();
    await handlePublishMessage(testEnv, { ...msg, kind: 'poll', outbox_id: poll!.id }, 'w1');
    expect(calls.poll).toBe(1);
    expect((await target(targetId))!.status).toBe('published');
    expect(await quota(f)).toEqual({ used: 1, reserved: 0 });
  });

  it('429 waits with Retry-After and retries the same target without extra quota', async () => {
    const f = await makeWorkspace();
    let n = 0;
    const calls = fakeAdapter({
      submit: async () => {
        if (n++ === 0) throw new ProviderError('rate_limited', '429', 'Slow down', 90, 429);
        return { kind: 'published', receipt: receipt('urn:li:share:5') };
      },
    });
    const { targetId, msg } = await scheduled(f);
    await handlePublishMessage(testEnv, msg, 'w1');
    const t = await target(targetId);
    expect(t!.status).toBe('retry_wait');
    expect(new Date(t!.next_attempt_at as string).getTime() - Date.now()).toBeGreaterThan(80_000);
    // Not yet due: a delivery now defers.
    await handlePublishMessage(testEnv, msg, 'w1');
    expect(calls.submit).toBe(1);
    await testEnv.DB.prepare('UPDATE targets SET next_attempt_at = ? WHERE id = ?').bind(new Date(Date.now() - 1000).toISOString(), targetId).run();
    await handlePublishMessage(testEnv, msg, 'w1');
    expect(calls.submit).toBe(2);
    expect((await target(targetId))!.status).toBe('published');
    expect(await quota(f)).toEqual({ used: 1, reserved: 0 });
  });

  it('definite validation failure releases the reservation', async () => {
    const f = await makeWorkspace();
    fakeAdapter({ submit: async () => { throw new ProviderError('validation', 'bad_media', 'Rejected'); } });
    const { targetId, msg } = await scheduled(f);
    await handlePublishMessage(testEnv, msg, 'w1');
    expect((await target(targetId))!.status).toBe('failed');
    expect(await quota(f)).toEqual({ used: 0, reserved: 0 });
  });

  it('SCH-02: ambiguous failure after submit → outcome_unknown, reservation kept, never re-submitted', async () => {
    const f = await makeWorkspace();
    const calls = fakeAdapter({ submit: async () => { throw new ProviderError('ambiguous', 'timeout', 'No response'); } });
    const { targetId, msg } = await scheduled(f);
    await handlePublishMessage(testEnv, msg, 'w1');
    await handlePublishMessage(testEnv, msg, 'w2');
    expect(calls.submit).toBe(1);
    expect((await target(targetId))!.status).toBe('outcome_unknown');
    expect(await quota(f)).toEqual({ used: 0, reserved: 1 });
  });

  it('SCH-02: crash after claim (lease expiry) becomes outcome_unknown, never blindly retried', async () => {
    const f = await makeWorkspace();
    const calls = fakeAdapter({ submit: async () => ({ kind: 'published', receipt: receipt('x') }) });
    const { targetId, msg } = await scheduled(f);
    // Claim then "crash" before settlement.
    const claim = await coordinator(testEnv, f.workspaceId).claim(msg, 'crashed-worker');
    expect(claim.kind).toBe('claimed');
    await testEnv.DB.prepare('UPDATE targets SET claim_expires_at = ? WHERE id = ?').bind(new Date(Date.now() - 1000).toISOString(), targetId).run();
    expect(await sweepExpiredClaims(testEnv)).toBeGreaterThanOrEqual(1);
    expect((await target(targetId))!.status).toBe('outcome_unknown');
    await handlePublishMessage(testEnv, msg, 'w2');
    expect(calls.submit).toBe(0);
    expect(await quota(f)).toEqual({ used: 0, reserved: 1 });
  });

  it('a late provider result after lease expiry still records the real post id', async () => {
    const f = await makeWorkspace();
    fakeAdapter({ submit: async () => ({ kind: 'published', receipt: receipt('x') }) });
    const { targetId, msg } = await scheduled(f);
    const claim = await coordinator(testEnv, f.workspaceId).claim(msg, 'slow-worker');
    if (claim.kind !== 'claimed') throw new Error('expected claim');
    await testEnv.DB.prepare('UPDATE targets SET claim_expires_at = ? WHERE id = ?').bind(new Date(Date.now() - 1000).toISOString(), targetId).run();
    await sweepExpiredClaims(testEnv);
    expect((await target(targetId))!.status).toBe('outcome_unknown');
    const next = await coordinator(testEnv, f.workspaceId).settle(f.workspaceId, targetId, claim.fencing, { kind: 'published', receipt: receipt('urn:li:share:late') }, 'submit');
    expect(next).toBe('published');
    expect(await quota(f)).toEqual({ used: 1, reserved: 0 });
  });

  it('a stale worker cannot settle over a newer claim (fencing)', async () => {
    const f = await makeWorkspace();
    fakeAdapter({ submit: async () => ({ kind: 'published', receipt: receipt('x') }) });
    const { targetId, msg } = await scheduled(f);
    const claim = await coordinator(testEnv, f.workspaceId).claim(msg, 'w1');
    if (claim.kind !== 'claimed') throw new Error('expected claim');
    const stale = await coordinator(testEnv, f.workspaceId).settle(f.workspaceId, targetId, claim.fencing - 1, { kind: 'published', receipt: receipt('y') }, 'submit');
    expect(stale).toBe('stale');
    expect((await target(targetId))!.status).toBe('submitting');
  });

  it('revoked access pauses the target as reconnect_required', async () => {
    const f = await makeWorkspace();
    fakeAdapter({ submit: async () => { throw new ProviderError('reconnect_required', '401', 'Token revoked'); } });
    const { targetId, msg } = await scheduled(f);
    await handlePublishMessage(testEnv, msg, 'w1');
    expect((await target(targetId))!.status).toBe('reconnect_required');
    const c = await testEnv.DB.prepare('SELECT state FROM connections WHERE id = ?').bind(f.connections.linkedin).first<{ state: string }>();
    expect(c!.state).toBe('reconnect_required');
  });

  it('does not burst-publish posts whose window passed long ago', async () => {
    const f = await makeWorkspace();
    const calls = fakeAdapter({ submit: async () => ({ kind: 'published', receipt: receipt('x') }) });
    const { targetId, msg } = await scheduled(f);
    await testEnv.DB.prepare('UPDATE targets SET due_at = ? WHERE id = ?').bind(new Date(Date.now() - 7 * 3600_000).toISOString(), targetId).run();
    await handlePublishMessage(testEnv, msg, 'w1');
    expect(calls.submit).toBe(0);
    expect((await target(targetId))!).toMatchObject({ status: 'failed', last_error_code: 'missed_window' });
    expect(await quota(f)).toEqual({ used: 0, reserved: 0 });
  });

  it('holds due posts while payment is past due', async () => {
    const f = await makeWorkspace();
    const calls = fakeAdapter({ submit: async () => ({ kind: 'published', receipt: receipt('x') }) });
    const { targetId, msg } = await scheduled(f);
    await testEnv.DB.prepare(`UPDATE subscriptions SET status = 'past_due' WHERE workspace_id = ?`).bind(f.workspaceId).run();
    await handlePublishMessage(testEnv, msg, 'w1');
    expect(calls.submit).toBe(0);
    expect((await target(targetId))!).toMatchObject({ status: 'scheduled', hold_reason: 'payment_past_due' });
  });
});
