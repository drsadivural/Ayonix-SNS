// CONTRACT TEST: TikTok hosted approval with a TikTok API DOUBLE, and report
// generation into local R2. Not live TikTok evidence (TT-01 remains BLOCKED).
import { SELF } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';
import { future, makeAsset, makeWorkspace, storeFakeToken, testEnv, uid } from './helpers.js';
import { createCampaign, preparePost } from '../src/services/campaigns.js';
import { confirmSchedule, previewSchedule } from '../src/services/schedules.js';
import { approvalContext, submitApproval } from '../src/services/approvals.js';
import { testHooks } from '../src/jobs/dispatch.js';
import { requestReport, getReport, runReport } from '../src/services/reports.js';

let creator: Record<string, unknown> = {};
afterEach(() => {
  testHooks.fetch = null;
});
function tiktokDouble() {
  testHooks.fetch = (async () => new Response(JSON.stringify({ data: creator, error: { code: 'ok', message: '' } }), { headers: { 'content-type': 'application/json' } })) as typeof fetch;
}

async function tiktokTarget() {
  const f = await makeWorkspace();
  await storeFakeToken(f, f.connections.tiktok!);
  const asset = await makeAsset(f);
  const c = await createCampaign(testEnv, f.owner, { product_id: f.productId, goal: 'g', audience: 'a', language: 'en', idempotency_key: uid('k') });
  const post = await preparePost(testEnv, f.owner, { campaign_id: c.id, idempotency_key: uid('k'), targets: [{ platform: 'tiktok', connection_id: f.connections.tiktok!, format: 'photo', caption: 'Original caption', asset_ids: [asset] }] });
  const p = await previewSchedule(testEnv, f.owner, [{ post_id: post.post_id, revision: post.revision, scheduled_at_utc: future(60), timezone: 'UTC' }]);
  const r = await confirmSchedule(testEnv, f.owner, { preview_token: p.preview_token!, confirmed: true, idempotency_key: uid('k') });
  return { f, targetId: r.target_ids[0]! };
}

const base = { creator_nickname: 'Ayonix demo', creator_username: 'ayonix', creator_avatar_url: null, privacy_level_options: ['PUBLIC_TO_EVERYONE', 'SELF_ONLY'], comment_disabled: false, duet_disabled: true, stitch_disabled: false, max_video_post_duration_sec: 600 };

describe('TikTok approval (TT-01 contract)', () => {
  it('requires explicit privacy and consent, honors creator constraints, and schedules on approval', async () => {
    creator = { ...base };
    tiktokDouble();
    const { f, targetId } = await tiktokTarget();
    const ctx = await approvalContext(testEnv, f.owner, targetId);
    expect(ctx.creator.privacy_level_options).toEqual(['PUBLIC_TO_EVERYONE', 'SELF_ONLY']);
    const input = { approval_token: ctx.approval_token, privacy_level: '', allow_comment: true, allow_duet: false, allow_stitch: false, brand_organic_toggle: false, brand_content_toggle: false, consent: true };
    await expect(submitApproval(testEnv, f.owner, targetId, input)).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(submitApproval(testEnv, f.owner, targetId, { ...input, privacy_level: 'PUBLIC_TO_EVERYONE', consent: false })).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(submitApproval(testEnv, f.owner, targetId, { ...input, privacy_level: 'PUBLIC_TO_EVERYONE', allow_duet: true })).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(submitApproval(testEnv, f.owner, targetId, { ...input, privacy_level: 'SELF_ONLY', brand_content_toggle: true })).rejects.toMatchObject({ code: 'invalid_request' });
    const ok = await submitApproval(testEnv, f.owner, targetId, { ...input, privacy_level: 'PUBLIC_TO_EVERYONE', title: 'Edited title' });
    expect(ok.status).toBe('scheduled');
    const ob = await testEnv.DB.prepare(`SELECT COUNT(*) AS n FROM outbox WHERE target_id = ? AND state = 'pending'`).bind(targetId).first<{ n: number }>();
    expect(ob!.n).toBe(1);
  });

  it('rejects approval when creator settings changed during review', async () => {
    creator = { ...base };
    tiktokDouble();
    const { f, targetId } = await tiktokTarget();
    const ctx = await approvalContext(testEnv, f.owner, targetId);
    creator = { ...base, privacy_level_options: ['SELF_ONLY'] };
    await expect(submitApproval(testEnv, f.owner, targetId, { approval_token: ctx.approval_token, privacy_level: 'PUBLIC_TO_EVERYONE', allow_comment: false, allow_duet: false, allow_stitch: false, brand_organic_toggle: false, brand_content_toggle: false, consent: true })).rejects.toBeTruthy();
    const t = await testEnv.DB.prepare('SELECT status FROM targets WHERE id = ?').bind(targetId).first<{ status: string }>();
    expect(t!.status).toBe('awaiting_approval');
  });
});

describe('reports (REP-01 local)', () => {
  it('generates CSV and PDF from stored data with definitions; null metrics shown as Not available', async () => {
    const f = await makeWorkspace();
    for (const format of ['csv', 'pdf'] as const) {
      const job = await requestReport(testEnv, f.owner, { format, from_utc: new Date(Date.now() - 7 * 86400_000).toISOString(), to_utc: new Date().toISOString() });
      await runReport(testEnv, f.workspaceId, job.id);
      const ready = await getReport(testEnv, f.owner, job.id);
      expect(ready.status).toBe('ready');
      const res = await SELF.fetch(ready.download_url!);
      expect(res.status).toBe(200);
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (format === 'csv') {
        const text = new TextDecoder().decode(bytes);
        expect(text).toContain('Impressions,Not available');
        expect(text).toContain('Not unique reach');
      } else {
        expect(new TextDecoder().decode(bytes.slice(0, 8))).toBe('%PDF-1.4');
      }
    }
    const other = await makeWorkspace();
    const job = await requestReport(testEnv, f.owner, { format: 'csv', from_utc: new Date(Date.now() - 86400_000).toISOString(), to_utc: new Date().toISOString() });
    await expect(getReport(testEnv, other.owner, job.id)).rejects.toMatchObject({ code: 'not_found' });
  });
});
