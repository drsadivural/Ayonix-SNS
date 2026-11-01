// CONTRACT/INTEGRATION TEST against real local D1 (Miniflare). Not live provider evidence.
import { describe, expect, it } from 'vitest';
import { actorFor, future, makeAsset, makeIdentity, makeWorkspace, testEnv, uid, type Fixture } from './helpers.js';
import { createCampaign, preparePost } from '../src/services/campaigns.js';
import { cancelSchedule, confirmSchedule, getPostStatus, previewSchedule, rescheduleTarget } from '../src/services/schedules.js';
import { mutate } from '../src/jobs/coordinator.js';
import { AppError } from '../src/lib/errors.js';
import type { Actor } from '../src/services/context.js';

async function draft(f: Fixture, actor: Actor, platforms: Array<'linkedin' | 'facebook' | 'tiktok'> = ['linkedin', 'facebook']) {
  const c = await createCampaign(testEnv, actor, { product_id: f.productId, goal: 'Awareness', audience: 'Retailers', language: 'en', idempotency_key: uid('k') });
  const asset = platforms.includes('tiktok') ? await makeAsset(f) : null;
  return preparePost(testEnv, actor, {
    campaign_id: c.id,
    idempotency_key: uid('k'),
    targets: platforms.map((p) => ({ platform: p, connection_id: f.connections[p]!, format: p === 'tiktok' ? 'photo' : 'text', caption: 'Protect your stores with real-time alerts.', asset_ids: p === 'tiktok' ? [asset!] : [] })) as never,
  });
}

async function quota(f: Fixture) {
  return (await testEnv.DB.prepare('SELECT allowance, used, reserved FROM quota_periods WHERE id = ?').bind(f.periodId).first<{ allowance: number; used: number; reserved: number }>())!;
}

describe('preview and confirm', () => {
  it('binds content, reserves quota atomically and persists targets + outbox', async () => {
    const f = await makeWorkspace();
    const post = await draft(f, f.owner);
    const p = await previewSchedule(testEnv, f.owner, [{ post_id: post.post_id, revision: post.revision, scheduled_at_utc: future(60), timezone: 'Australia/Melbourne' }]);
    expect(p.blocking_problems).toEqual([]);
    expect(p.quota_cost).toBe(2);
    expect(p.targets[0]!.utc_offset).toMatch(/^\+1[01]:00$/);
    const r = await confirmSchedule(testEnv, f.owner, { preview_token: p.preview_token!, confirmed: true, idempotency_key: 'confirm-1' });
    expect(r.target_ids).toHaveLength(2);
    expect(await quota(f)).toMatchObject({ used: 0, reserved: 2 });
    const outbox = await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM outbox WHERE workspace_id = ?').bind(f.workspaceId).first<{ n: number }>();
    expect(outbox!.n).toBe(2);
    // Same key + same payload returns the stored result without reserving again.
    const again = await confirmSchedule(testEnv, f.owner, { preview_token: p.preview_token!, confirmed: true, idempotency_key: 'confirm-1' });
    expect(again).toEqual(r);
    expect(await quota(f)).toMatchObject({ reserved: 2 });
    // Same key + different payload conflicts.
    const p2 = await previewSchedule(testEnv, f.owner, [{ post_id: post.post_id, revision: post.revision, scheduled_at_utc: future(90), timezone: 'Australia/Melbourne' }]);
    await expect(confirmSchedule(testEnv, f.owner, { preview_token: p2.preview_token!, confirmed: true, idempotency_key: 'confirm-1' })).rejects.toMatchObject({ code: 'idempotency_conflict' });
  });

  it('a preview can only be confirmed once, even with a new idempotency key', async () => {
    const f = await makeWorkspace();
    const post = await draft(f, f.owner, ['linkedin']);
    const p = await previewSchedule(testEnv, f.owner, [{ post_id: post.post_id, revision: post.revision, scheduled_at_utc: future(60), timezone: 'UTC' }]);
    await confirmSchedule(testEnv, f.owner, { preview_token: p.preview_token!, confirmed: true, idempotency_key: uid('k') });
    await expect(confirmSchedule(testEnv, f.owner, { preview_token: p.preview_token!, confirmed: true, idempotency_key: uid('k') })).rejects.toMatchObject({ code: 'conflict' });
    expect(await quota(f)).toMatchObject({ reserved: 1 });
  });

  it('rejects confirmation after the content changes (new revision)', async () => {
    const f = await makeWorkspace();
    const post = await draft(f, f.owner);
    const p = await previewSchedule(testEnv, f.owner, [{ post_id: post.post_id, revision: post.revision, scheduled_at_utc: future(60), timezone: 'UTC' }]);
    await preparePost(testEnv, f.owner, { campaign_id: post.campaign_id, post_id: post.post_id, idempotency_key: uid('k'), targets: [{ platform: 'linkedin', connection_id: f.connections.linkedin!, format: 'text', caption: 'Edited', asset_ids: [] }] });
    await expect(confirmSchedule(testEnv, f.owner, { preview_token: p.preview_token!, confirmed: true, idempotency_key: uid('k') })).rejects.toMatchObject({ code: 'version_conflict' });
  });

  it('rejects a tampered preview token and a different identity', async () => {
    const f = await makeWorkspace();
    const post = await draft(f, f.owner);
    const p = await previewSchedule(testEnv, f.owner, [{ post_id: post.post_id, revision: post.revision, scheduled_at_utc: future(60), timezone: 'UTC' }]);
    const [body, sig] = p.preview_token!.split('.');
    const tampered = `${body!.slice(0, -2)}AA.${sig}`;
    await expect(confirmSchedule(testEnv, f.owner, { preview_token: tampered, confirmed: true, idempotency_key: uid('k') })).rejects.toBeInstanceOf(AppError);
    const editor = await makeIdentity();
    await testEnv.DB.prepare(`INSERT INTO memberships(workspace_id, identity_id, role, created_at, updated_at) VALUES (?,?,?,?,?)`).bind(f.workspaceId, editor.id, 'editor', new Date().toISOString(), new Date().toISOString()).run();
    await expect(confirmSchedule(testEnv, actorFor(f.workspaceId, editor, 'editor'), { preview_token: p.preview_token!, confirmed: true, idempotency_key: uid('k') })).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('blocks preview beyond remaining quota and requires approval for TikTok', async () => {
    const f = await makeWorkspace({ allowance: 1 });
    const post = await draft(f, f.owner, ['linkedin', 'tiktok']);
    const p = await previewSchedule(testEnv, f.owner, [{ post_id: post.post_id, revision: post.revision, scheduled_at_utc: future(60), timezone: 'UTC' }]);
    expect(p.preview_token).toBeNull();
    expect(p.blocking_problems.join(' ')).toMatch(/only 1 remain/);
    expect(p.targets.find((t) => t.platform === 'tiktok')!.approval_required).toBe('tiktok_creator_consent');
  });

  it('QUOTA-01: parallel confirmations for the last unit allow exactly one reservation', async () => {
    const f = await makeWorkspace({ allowance: 1 });
    const tokens: string[] = [];
    for (let i = 0; i < 6; i++) {
      const post = await draft(f, f.owner, ['linkedin']);
      const p = await previewSchedule(testEnv, f.owner, [{ post_id: post.post_id, revision: post.revision, scheduled_at_utc: future(60 + i), timezone: 'UTC' }]);
      tokens.push(p.preview_token!);
    }
    // Direct service calls (bypassing the coordinator) prove the D1 constraint alone prevents overspend.
    const results = await Promise.allSettled(tokens.map((t) => confirmSchedule(testEnv, f.owner, { preview_token: t, confirmed: true, idempotency_key: uid('k') })));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const r of results.filter((r) => r.status === 'rejected')) expect((r as PromiseRejectedResult).reason).toMatchObject({ code: 'quota_exceeded' });
    expect(await quota(f)).toMatchObject({ allowance: 1, used: 0, reserved: 1 });
  });

  it('QUOTA-01: multi-target confirmation is all-or-none', async () => {
    const f = await makeWorkspace({ allowance: 3 });
    const a = await draft(f, f.owner, ['linkedin', 'facebook']);
    const pa = await previewSchedule(testEnv, f.owner, [{ post_id: a.post_id, revision: a.revision, scheduled_at_utc: future(60), timezone: 'UTC' }]);
    const b = await draft(f, f.owner, ['linkedin', 'facebook']);
    const pb = await previewSchedule(testEnv, f.owner, [{ post_id: b.post_id, revision: b.revision, scheduled_at_utc: future(61), timezone: 'UTC' }]);
    await confirmSchedule(testEnv, f.owner, { preview_token: pa.preview_token!, confirmed: true, idempotency_key: uid('k') });
    await expect(confirmSchedule(testEnv, f.owner, { preview_token: pb.preview_token!, confirmed: true, idempotency_key: uid('k') })).rejects.toMatchObject({ code: 'quota_exceeded' });
    expect(await quota(f)).toMatchObject({ reserved: 2 });
    const targets = await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM targets WHERE workspace_id = ?').bind(f.workspaceId).first<{ n: number }>();
    expect(targets!.n).toBe(2);
  });

  it('serializes through the workspace coordinator Durable Object', async () => {
    const f = await makeWorkspace({ allowance: 2 });
    const tokens: string[] = [];
    for (let i = 0; i < 4; i++) {
      const post = await draft(f, f.owner, ['linkedin']);
      tokens.push((await previewSchedule(testEnv, f.owner, [{ post_id: post.post_id, revision: post.revision, scheduled_at_utc: future(70 + i), timezone: 'UTC' }])).preview_token!);
    }
    const results = await Promise.allSettled(tokens.map((t) => mutate(testEnv, f.workspaceId, { op: 'confirm', actor: f.owner, input: { preview_token: t, confirmed: true, idempotency_key: uid('k') } })));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2);
    expect(await quota(f)).toMatchObject({ reserved: 2 });
  });
});

describe('cancel and reschedule', () => {
  it('cancellation before submission releases quota exactly once; version-checked', async () => {
    const f = await makeWorkspace();
    const post = await draft(f, f.owner);
    const p = await previewSchedule(testEnv, f.owner, [{ post_id: post.post_id, revision: post.revision, scheduled_at_utc: future(60), timezone: 'UTC' }]);
    const r = await confirmSchedule(testEnv, f.owner, { preview_token: p.preview_token!, confirmed: true, idempotency_key: uid('k') });
    await expect(cancelSchedule(testEnv, f.owner, { schedule_id: r.schedule_id, expected_version: 9, idempotency_key: uid('k') })).rejects.toMatchObject({ code: 'version_conflict' });
    const c = await cancelSchedule(testEnv, f.owner, { schedule_id: r.schedule_id, expected_version: 1, idempotency_key: 'cancel-1' });
    expect(Object.values(c.outcomes)).toEqual(['canceled', 'canceled']);
    expect(await quota(f)).toMatchObject({ reserved: 0, used: 0 });
    const again = await cancelSchedule(testEnv, f.owner, { schedule_id: r.schedule_id, expected_version: 1, idempotency_key: 'cancel-1' });
    expect(again).toEqual(c);
    expect(await quota(f)).toMatchObject({ reserved: 0 });
    const status = await getPostStatus(testEnv, f.owner, post.post_id);
    expect(status.targets.every((t) => t.status === 'canceled')).toBe(true);
  });

  it('cancellation after submission is honest and keeps the reservation', async () => {
    const f = await makeWorkspace();
    const post = await draft(f, f.owner, ['linkedin']);
    const p = await previewSchedule(testEnv, f.owner, [{ post_id: post.post_id, revision: post.revision, scheduled_at_utc: future(60), timezone: 'UTC' }]);
    const r = await confirmSchedule(testEnv, f.owner, { preview_token: p.preview_token!, confirmed: true, idempotency_key: uid('k') });
    await testEnv.DB.prepare(`UPDATE targets SET status = 'outcome_unknown' WHERE id = ?`).bind(r.target_ids[0]).run();
    const c = await cancelSchedule(testEnv, f.owner, { schedule_id: r.schedule_id, expected_version: 1, idempotency_key: uid('k') });
    expect(Object.values(c.outcomes)).toEqual(['submitted_reconciling']);
    expect(await quota(f)).toMatchObject({ reserved: 1 });
  });

  it('rescheduling bumps the version and resets TikTok approval', async () => {
    const f = await makeWorkspace();
    const post = await draft(f, f.owner, ['tiktok']);
    const p = await previewSchedule(testEnv, f.owner, [{ post_id: post.post_id, revision: post.revision, scheduled_at_utc: future(60), timezone: 'UTC' }]);
    const r = await confirmSchedule(testEnv, f.owner, { preview_token: p.preview_token!, confirmed: true, idempotency_key: uid('k') });
    const id = r.target_ids[0]!;
    expect(r.states[id]).toBe('awaiting_approval');
    await testEnv.DB.prepare(`UPDATE targets SET status = 'scheduled', approval_id = 'apr_x', version = version + 1 WHERE id = ?`).bind(id).run();
    const t = await rescheduleTarget(testEnv, f.owner, id, { expected_version: 2, scheduled_at_utc: future(120), timezone: 'UTC' });
    expect(t.status).toBe('awaiting_approval');
    expect(t.version).toBe(3);
    await expect(rescheduleTarget(testEnv, f.owner, id, { expected_version: 2, scheduled_at_utc: future(130), timezone: 'UTC' })).rejects.toMatchObject({ code: 'version_conflict' });
  });
});

describe('tenancy and permissions', () => {
  it('TEN-01: another workspace cannot read or use foreign IDs', async () => {
    const a = await makeWorkspace();
    const b = await makeWorkspace();
    const post = await draft(a, a.owner);
    await expect(getPostStatus(testEnv, b.owner, post.post_id)).rejects.toMatchObject({ code: 'not_found' });
    await expect(previewSchedule(testEnv, b.owner, [{ post_id: post.post_id, revision: 1, scheduled_at_utc: future(60), timezone: 'UTC' }])).rejects.toMatchObject({ code: 'not_found' });
    const c = await createCampaign(testEnv, b.owner, { product_id: b.productId, goal: 'g', audience: 'a', language: 'en', idempotency_key: uid('k') });
    await expect(preparePost(testEnv, b.owner, { campaign_id: c.id, idempotency_key: uid('k'), targets: [{ platform: 'linkedin', connection_id: a.connections.linkedin!, format: 'text', caption: 'x', asset_ids: [] }] })).rejects.toMatchObject({ code: 'not_found' });
    await expect(createCampaign(testEnv, b.owner, { product_id: a.productId, goal: 'g', audience: 'a', language: 'en', idempotency_key: uid('k') })).rejects.toMatchObject({ code: 'not_found' });
  });

  it('AUTH-02: viewers cannot draft; MCP actors need the right scope', async () => {
    const f = await makeWorkspace();
    const viewer = await makeIdentity();
    const v = actorFor(f.workspaceId, viewer, 'viewer');
    await expect(createCampaign(testEnv, v, { product_id: f.productId, goal: 'g', audience: 'a', language: 'en', idempotency_key: uid('k') })).rejects.toMatchObject({ code: 'forbidden' });
    const mcpReadOnly = { ...f.owner, via: 'mcp' as const, scopes: ['sns:read' as const] };
    await expect(createCampaign(testEnv, mcpReadOnly, { product_id: f.productId, goal: 'g', audience: 'a', language: 'en', idempotency_key: uid('k') })).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('blocks scheduling when the subscription is past due', async () => {
    const f = await makeWorkspace({ status: 'past_due' });
    const post = await draft(f, f.owner, ['linkedin']);
    const p = await previewSchedule(testEnv, f.owner, [{ post_id: post.post_id, revision: post.revision, scheduled_at_utc: future(60), timezone: 'UTC' }]);
    expect(p.preview_token).toBeNull();
    expect(p.blocking_problems.join(' ')).toMatch(/payment failed/i);
  });
});
