// CONTRACT TEST with a fetch double. Not live provider evidence (docs/10-ACCEPTANCE.md).
import { beforeEach, describe, expect, it } from 'vitest';
import { chunkPlan, queryCreatorInfo, tiktok } from '../../../apps/worker/src/providers/tiktok.js';
import { content, ctx, empty, env, fetchDouble, form, json, media, quietLogs } from './helpers.js';

const creator = { account_type: 'creator', provider_account_id: 'open_1', granted_scopes: ['user.info.basic', 'video.publish', 'video.list'] };
const ok = { code: 'ok', message: '', log_id: 'l' };
const creatorInfo = (over: Record<string, unknown> = {}) =>
  json({ data: { creator_nickname: 'Ann', creator_username: 'ann', creator_avatar_url: 'https://x', privacy_level_options: ['PUBLIC_TO_EVERYONE', 'MUTUAL_FOLLOW_FRIENDS', 'SELF_ONLY'], comment_disabled: false, duet_disabled: false, stitch_disabled: false, max_video_post_duration_sec: 600, ...over }, error: ok });

beforeEach(quietLogs);

describe('tiktok oauth', () => {
  it('authorizeUrl carries client_key, comma scopes, state and exact redirect', () => {
    const u = new URL(tiktok.authorizeUrl(env, { state: 'st', codeChallenge: 'ch', redirectUri: 'https://app.example.test/cb/tt' }));
    expect(u.origin + u.pathname).toBe('https://www.tiktok.com/v2/auth/authorize/');
    expect(u.searchParams.get('client_key')).toBe('tt-key');
    expect(u.searchParams.get('scope')).toBe('user.info.basic,video.publish,video.list');
    expect(u.searchParams.get('state')).toBe('st');
    expect(u.searchParams.get('redirect_uri')).toBe('https://app.example.test/cb/tt');
    expect(u.searchParams.get('response_type')).toBe('code');
  });

  it('exchangeCode parses expiry, refresh expiry, comma-separated scopes and open_id', async () => {
    const { fetch, calls } = fetchDouble([{ method: 'POST', match: '/v2/oauth/token/', reply: () => json({ access_token: 'AT', expires_in: 86400, refresh_token: 'RT', refresh_expires_in: 31536000, scope: 'user.info.basic,video.publish', open_id: 'open_1', token_type: 'Bearer' }) }]);
    const t = await tiktok.exchangeCode(env, 'c', 'v', 'https://app.example.test/cb/tt', fetch);
    expect(t).toMatchObject({ accessToken: 'AT', refreshToken: 'RT', scopes: ['user.info.basic', 'video.publish'], subject: 'open_1' });
    expect(Date.parse(t.expiresAt!) - Date.now()).toBeGreaterThan(86_000_000);
    expect(form(calls[0]!.body)).toMatchObject({ client_key: 'tt-key', grant_type: 'authorization_code', code: 'c', redirect_uri: 'https://app.example.test/cb/tt' });
  });

  it('refreshOrReconnect uses the refresh_token grant', async () => {
    const { fetch, calls } = fetchDouble([{ method: 'POST', match: '/v2/oauth/token/', reply: () => json({ access_token: 'AT2', expires_in: 86400, refresh_token: 'RT2', scope: 'video.publish', open_id: 'open_1' }) }]);
    const r = await tiktok.refreshOrReconnect(ctx('tiktok', fetch, creator, { refresh: 'RT' }));
    expect(r).toMatchObject({ kind: 'refreshed', tokens: { accessToken: 'AT2', refreshToken: 'RT2' } });
    expect(form(calls[0]!.body)).toMatchObject({ grant_type: 'refresh_token', refresh_token: 'RT' });
  });

  it('discoverAccounts returns the creator from user/info', async () => {
    const { fetch } = fetchDouble([{ match: '/v2/user/info/', reply: () => json({ data: { user: { open_id: 'open_1', display_name: 'Ann' } }, error: ok }) }]);
    const a = await tiktok.discoverAccounts(env, { accessToken: 'AT', scopes: creator.granted_scopes }, fetch);
    expect(a).toEqual([expect.objectContaining({ providerAccountId: 'open_1', name: 'Ann', type: 'creator' })]);
  });

  it('disconnect revokes the token', async () => {
    const { fetch, calls } = fetchDouble([{ method: 'POST', match: '/v2/oauth/revoke/', reply: () => empty(200) }]);
    expect(await tiktok.disconnect(ctx('tiktok', fetch, creator))).toEqual({ revoked: true });
    expect(form(calls[0]!.body)).toMatchObject({ token: 'USER_TOKEN', client_key: 'tt-key' });
  });
});

describe('tiktok creator constraints', () => {
  it('queryCreatorInfo posts to creator_info/query', async () => {
    const { fetch, calls } = fetchDouble([{ method: 'POST', match: '/v2/post/publish/creator_info/query/', reply: () => creatorInfo() }]);
    const info = await queryCreatorInfo(ctx('tiktok', fetch, creator));
    expect(info.privacy_level_options).toContain('SELF_ONLY');
    expect(info.max_video_post_duration_sec).toBe(600);
    expect(calls[0]!.headers.authorization).toBe('Bearer USER_TOKEN');
  });

  it('missing privacy_level is rejected (no default) before any network call', async () => {
    const { fetch, calls } = fetchDouble([]);
    const post = content('video', { media: [media({ mime: 'video/mp4', durationMs: 10_000 })], options: {} });
    expect(tiktok.validatePost(null, post).join(' ')).toMatch(/privacy level explicitly/);
    await expect(tiktok.submitPost(ctx('tiktok', fetch, creator), post, {})).rejects.toMatchObject({ kind: 'validation' });
    expect(calls).toHaveLength(0);
  });

  it('stale creator constraints (privacy option removed / comments disabled) are rejected at dispatch', async () => {
    const a = fetchDouble([{ match: 'creator_info', reply: () => creatorInfo({ privacy_level_options: ['SELF_ONLY'] }) }]);
    const post = content('video', { media: [media({ mime: 'video/mp4', durationMs: 10_000 })], options: { privacy_level: 'PUBLIC_TO_EVERYONE' } });
    await expect(tiktok.submitPost(ctx('tiktok', a.fetch, creator), post, {})).rejects.toMatchObject({ kind: 'validation', code: 'creator_constraints_changed' });
    expect(a.calls.some((c) => c.url.includes('/video/init/'))).toBe(false);

    const b = fetchDouble([{ match: 'creator_info', reply: () => creatorInfo({ comment_disabled: true }) }]);
    await expect(tiktok.submitPost(ctx('tiktok', b.fetch, creator), content('video', { media: [media({ mime: 'video/mp4' })], options: { privacy_level: 'SELF_ONLY', disable_comment: false } }), {})).rejects.toMatchObject({ code: 'creator_constraints_changed' });

    const d = fetchDouble([{ match: 'creator_info', reply: () => creatorInfo({ max_video_post_duration_sec: 60 }) }]);
    await expect(tiktok.submitPost(ctx('tiktok', d.fetch, creator), content('video', { media: [media({ mime: 'video/mp4', durationMs: 120_000 })], options: { privacy_level: 'SELF_ONLY' } }), {})).rejects.toMatchObject({ code: 'creator_constraints_changed' });
  });

  it('validatePost enforces creator max duration when known and photo count 1–35', () => {
    expect(tiktok.validatePost(null, content('video', { media: [media({ mime: 'video/mp4', durationMs: 200_000 })], options: { privacy_level: 'SELF_ONLY', max_video_post_duration_sec: 180 } })).join(' ')).toMatch(/180 seconds/);
    expect(tiktok.validatePost(null, content('photo', { media: Array.from({ length: 36 }, () => media()), options: { privacy_level: 'SELF_ONLY' } })).join(' ')).toMatch(/1–35/);
  });
});

describe('tiktok publishing', () => {
  it('video: FILE_UPLOAD init → chunk PUT with Content-Range → processing (never published from init) → poll → published with public id', async () => {
    const { fetch, calls } = fetchDouble([
      { match: 'creator_info', reply: () => creatorInfo() },
      { method: 'POST', match: '/v2/post/publish/video/init/', reply: () => json({ data: { publish_id: 'v_pub_1', upload_url: 'https://open-upload.tiktokapis.com/upload/?id=1' }, error: ok }) },
      { method: 'PUT', match: 'open-upload.tiktokapis.com', reply: () => empty(201) },
      { method: 'POST', match: '/v2/post/publish/status/fetch/', times: 1, reply: () => json({ data: { status: 'PROCESSING_UPLOAD' }, error: ok }) },
      { method: 'POST', match: '/v2/post/publish/status/fetch/', reply: () => new Response('{"data":{"status":"PUBLISH_COMPLETE","publicaly_available_post_id":[7429876543210987654]},"error":{"code":"ok"}}', { status: 200 }) },
    ]);
    const c = ctx('tiktok', fetch, creator);
    const m = media({ mime: 'video/mp4', bytes: 1000, durationMs: 15_000 });
    const s = await tiktok.submitPost(c, content('video', { caption: 'My clip', media: [m], options: { privacy_level: 'PUBLIC_TO_EVERYONE', disable_comment: false, is_aigc: false } }), {});
    const init = JSON.parse(calls[1]!.body!);
    expect(init.post_info).toEqual({ title: 'My clip', privacy_level: 'PUBLIC_TO_EVERYONE', disable_comment: false, is_aigc: false });
    expect(init.source_info).toEqual({ source: 'FILE_UPLOAD', video_size: 1000, chunk_size: 1000, total_chunk_count: 1 });
    expect(calls[2]!.headers['content-range']).toBe('bytes 0-999/1000');
    expect(calls[2]!.bodyBytes).toBe(1000);
    expect(s).toMatchObject({ kind: 'processing', receipt: { publishId: 'v_pub_1', remoteId: null } });
    const p1 = await tiktok.pollStatus(c, s.receipt);
    expect(p1.kind).toBe('processing');
    const p2 = await tiktok.pollStatus(c, p1.receipt);
    expect(p2).toMatchObject({ kind: 'published', receipt: { publishId: 'v_pub_1', remoteId: '7429876543210987654' } }); // full int64 precision
  });

  it('photo: content/init PULL_FROM_URL with photo_images = publicUrls', async () => {
    const { fetch, calls } = fetchDouble([
      { match: 'creator_info', reply: () => creatorInfo() },
      { method: 'POST', match: '/v2/post/publish/content/init/', reply: () => json({ data: { publish_id: 'p_pub_1' }, error: ok }) },
    ]);
    const imgs = [media({ publicUrl: 'https://media.example.test/a.jpg' }), media({ publicUrl: 'https://media.example.test/b.jpg' })];
    const s = await tiktok.submitPost(ctx('tiktok', fetch, creator), content('photo', { title: 'Trip', caption: 'desc', media: imgs, options: { privacy_level: 'SELF_ONLY' } }), {});
    const body = JSON.parse(calls[1]!.body!);
    expect(body).toMatchObject({ media_type: 'PHOTO', post_mode: 'DIRECT_POST', post_info: { title: 'Trip', description: 'desc', privacy_level: 'SELF_ONLY' }, source_info: { source: 'PULL_FROM_URL', photo_cover_index: 0, photo_images: ['https://media.example.test/a.jpg', 'https://media.example.test/b.jpg'] } });
    expect(s).toMatchObject({ kind: 'processing', receipt: { publishId: 'p_pub_1' } });
  });

  it('PUBLISH_COMPLETE without public id for a SELF_ONLY post → published with remoteId = publish_id, url null', async () => {
    const { fetch } = fetchDouble([{ match: 'status/fetch', reply: () => json({ data: { status: 'PUBLISH_COMPLETE', publicaly_available_post_id: [] }, error: ok }) }]);
    const r = await tiktok.pollStatus(ctx('tiktok', fetch, creator), { remoteId: null, containerId: null, publishId: 'pub_x', url: null, state: { privacy_level: 'SELF_ONLY', submitted_at: new Date().toISOString() } });
    expect(r).toMatchObject({ kind: 'published', receipt: { remoteId: 'pub_x', url: null } });
  });

  it('public post without id yet (moderation) keeps processing', async () => {
    const { fetch } = fetchDouble([{ match: 'status/fetch', reply: () => json({ data: { status: 'PUBLISH_COMPLETE', publicaly_available_post_id: [] }, error: ok }) }]);
    const r = await tiktok.pollStatus(ctx('tiktok', fetch, creator), { remoteId: null, containerId: null, publishId: 'pub_y', url: null, state: { privacy_level: 'PUBLIC_TO_EVERYONE', submitted_at: new Date().toISOString() } });
    expect(r.kind).toBe('processing');
  });

  it('FAILED → failed with fail_reason', async () => {
    const { fetch } = fetchDouble([{ match: 'status/fetch', reply: () => json({ data: { status: 'FAILED', fail_reason: 'picture_size_check_failed' }, error: ok }) }]);
    expect(await tiktok.pollStatus(ctx('tiktok', fetch, creator), { remoteId: null, containerId: null, publishId: 'p', url: null, state: {} })).toMatchObject({ kind: 'failed', code: 'picture_size_check_failed' });
  });

  it('chunkPlan follows the 5–64 MB rule with the final chunk absorbing the remainder', () => {
    expect(chunkPlan(4 * 1024 * 1024)).toEqual({ chunkSize: 4 * 1024 * 1024, count: 1, sizes: [4 * 1024 * 1024] });
    const p = chunkPlan(25 * 1024 * 1024 + 7);
    expect(p.count).toBe(2);
    expect(p.chunkSize).toBe(10 * 1024 * 1024);
    expect(p.sizes).toEqual([10 * 1024 * 1024, 15 * 1024 * 1024 + 7]);
  });
});

describe('tiktok errors', () => {
  it('401 access_token_invalid → reconnect_required', async () => {
    const { fetch } = fetchDouble([{ match: 'creator_info', reply: () => json({ error: { code: 'access_token_invalid', message: 'expired' } }, 401) }]);
    await expect(tiktok.submitPost(ctx('tiktok', fetch, creator), content('photo', { media: [media()], options: { privacy_level: 'SELF_ONLY' } }), {})).rejects.toMatchObject({ kind: 'reconnect_required' });
  });

  it('429 rate_limit_exceeded with Retry-After → rate_limited', async () => {
    const { fetch } = fetchDouble([{ match: 'creator_info', reply: () => json({ error: { code: 'rate_limit_exceeded', message: 'slow' } }, 429, { 'retry-after': '45' }) }]);
    await expect(queryCreatorInfo(ctx('tiktok', fetch, creator))).rejects.toMatchObject({ kind: 'rate_limited', retryAfterSeconds: 45 });
  });

  it('HTTP 200 with spam_risk error code → validation', async () => {
    const { fetch } = fetchDouble([{ match: 'creator_info', reply: () => json({ data: {}, error: { code: 'spam_risk_too_many_posts', message: 'cap' } }) }]);
    await expect(queryCreatorInfo(ctx('tiktok', fetch, creator))).rejects.toMatchObject({ kind: 'validation', code: 'spam_risk_too_many_posts' });
  });

  it('timeout/5xx on the create call (photo init, final video chunk) → ambiguous', async () => {
    const a = fetchDouble([
      { match: 'creator_info', reply: () => creatorInfo() },
      { match: '/content/init/', reply: () => 'timeout' },
    ]);
    await expect(tiktok.submitPost(ctx('tiktok', a.fetch, creator), content('photo', { media: [media()], options: { privacy_level: 'SELF_ONLY' } }), {})).rejects.toMatchObject({ kind: 'ambiguous' });
    const b = fetchDouble([
      { match: 'creator_info', reply: () => creatorInfo() },
      { match: '/video/init/', reply: () => json({ data: { publish_id: 'p', upload_url: 'https://open-upload.tiktokapis.com/u' }, error: ok }) },
      { method: 'PUT', match: 'open-upload', reply: () => json({ error: { code: 'internal_error' } }, 502) },
    ]);
    await expect(tiktok.submitPost(ctx('tiktok', b.fetch, creator), content('video', { media: [media({ mime: 'video/mp4' })], options: { privacy_level: 'SELF_ONLY' } }), {})).rejects.toMatchObject({ kind: 'ambiguous' });
  });
});

describe('tiktok metrics', () => {
  it('queries public post ids only and maps counts', async () => {
    const { fetch, calls } = fetchDouble([{ match: '/v2/video/query/', reply: () => new Response('{"data":{"videos":[{"id":7429876543210987654,"view_count":100,"like_count":5}]},"error":{"code":"ok"}}') }]);
    const rows = await tiktok.fetchMetrics(ctx('tiktok', fetch, creator), { objectIds: ['7429876543210987654', 'v_pub_private'], since: '2026-10-01', until: '2026-10-31' });
    expect(JSON.parse(calls[0]!.body!)).toEqual({ filters: { video_ids: ['7429876543210987654'] } });
    expect(rows.map((r) => [r.providerObjectId, r.rawMetric, r.metric, r.value])).toEqual([
      ['7429876543210987654', 'view_count', 'views', 100],
      ['7429876543210987654', 'like_count', 'likes', 5],
    ]);
  });
});
