// CONTRACT TEST with a fetch double. Not live provider evidence (docs/10-ACCEPTANCE.md).
import { beforeEach, describe, expect, it } from 'vitest';
import { cancelNativeSchedule, youtube } from '../../../apps/worker/src/providers/youtube.js';
import { content, ctx, empty, env, fetchDouble, form, json, media, quietLogs } from './helpers.js';

const UP = 'https://www.googleapis.com/auth/youtube.upload';
const RO = 'https://www.googleapis.com/auth/youtube.readonly';
const AN = 'https://www.googleapis.com/auth/yt-analytics.readonly';
const FS = 'https://www.googleapis.com/auth/youtube.force-ssl';
const channel = { account_type: 'channel', provider_account_id: 'UC1', granted_scopes: [UP, RO, AN] };
const opts = { privacy_status: 'public', made_for_kids: false, contains_synthetic_media: false };
const video = (over = {}) => media({ mime: 'video/mp4', bytes: 64, durationMs: 30_000, ...over });

beforeEach(quietLogs);

describe('youtube oauth', () => {
  it('authorizeUrl includes PKCE S256, state, exact redirect, offline access and minimal scopes', () => {
    const u = new URL(youtube.authorizeUrl(env, { state: 'st', codeChallenge: 'CHAL', redirectUri: 'https://app.example.test/cb/yt' }));
    expect(u.origin + u.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(u.searchParams.get('code_challenge')).toBe('CHAL');
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
    expect(u.searchParams.get('state')).toBe('st');
    expect(u.searchParams.get('redirect_uri')).toBe('https://app.example.test/cb/yt');
    expect(u.searchParams.get('access_type')).toBe('offline');
    expect(u.searchParams.get('scope')).toBe(`${UP} ${RO} ${AN}`);
  });

  it('exchangeCode sends code_verifier and parses expiry + space-delimited granted scopes', async () => {
    const { fetch, calls } = fetchDouble([{ method: 'POST', match: 'oauth2.googleapis.com/token', reply: () => json({ access_token: 'AT', expires_in: 3599, refresh_token: 'RT', scope: `${UP} ${RO}`, token_type: 'Bearer' }) }]);
    const t = await youtube.exchangeCode(env, 'code', 'VERIFIER', 'https://app.example.test/cb/yt', fetch);
    expect(t).toMatchObject({ accessToken: 'AT', refreshToken: 'RT', scopes: [UP, RO] });
    expect(Date.parse(t.expiresAt!) - Date.now()).toBeGreaterThan(3_500_000);
    expect(form(calls[0]!.body)).toMatchObject({ code: 'code', code_verifier: 'VERIFIER', grant_type: 'authorization_code', redirect_uri: 'https://app.example.test/cb/yt' });
  });

  it('refresh: missing refresh token → reconnect; invalid_grant → reconnect; success keeps stored refresh token', async () => {
    expect(await youtube.refreshOrReconnect(ctx('youtube', fetchDouble([]).fetch, channel))).toMatchObject({ kind: 'reconnect_required' });
    const bad = fetchDouble([{ match: '/token', reply: () => json({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }, 400) }]);
    expect(await youtube.refreshOrReconnect(ctx('youtube', bad.fetch, channel, { refresh: 'RT' }))).toMatchObject({ kind: 'reconnect_required' });
    const good = fetchDouble([{ match: '/token', reply: () => json({ access_token: 'AT2', expires_in: 3599, scope: `${UP} ${RO} ${AN}` }) }]);
    expect(await youtube.refreshOrReconnect(ctx('youtube', good.fetch, channel, { refresh: 'RT' }))).toMatchObject({ kind: 'refreshed', tokens: { accessToken: 'AT2', refreshToken: 'RT' } });
  });

  it('discoverAccounts lists the authenticated user channels', async () => {
    const { fetch, calls } = fetchDouble([{ match: '/youtube/v3/channels', reply: () => json({ items: [{ id: 'UC1', snippet: { title: 'My Channel' } }] }) }]);
    const a = await youtube.discoverAccounts(env, { accessToken: 'AT', scopes: [UP, RO] }, fetch);
    expect(calls[0]!.url).toContain('mine=true');
    expect(a).toEqual([expect.objectContaining({ providerAccountId: 'UC1', name: 'My Channel', type: 'channel' })]);
  });

  it('disconnect revokes at Google', async () => {
    const { fetch, calls } = fetchDouble([{ method: 'POST', match: 'oauth2.googleapis.com/revoke', reply: () => empty(200) }]);
    expect(await youtube.disconnect(ctx('youtube', fetch, channel, { refresh: 'RT' }))).toEqual({ revoked: true });
    expect(form(calls[0]!.body)).toEqual({ token: 'RT' });
  });
});

describe('youtube validation', () => {
  it('requires title ≤100, privacy_status, made_for_kids and contains_synthetic_media', () => {
    const missingKids = youtube.validatePost(null, content('video', { title: 'T', media: [video()], options: { privacy_status: 'public', contains_synthetic_media: false } }));
    expect(missingKids.join(' ')).toMatch(/made for kids/);
    const missingSynth = youtube.validatePost(null, content('video', { title: 'T', media: [video()], options: { privacy_status: 'public', made_for_kids: false } }));
    expect(missingSynth.join(' ')).toMatch(/synthetic/);
    expect(youtube.validatePost(null, content('video', { title: 'x'.repeat(101), media: [video()], options: opts })).join(' ')).toMatch(/100 characters/);
    expect(youtube.validatePost(null, content('video', { title: 'T', media: [video()], options: { ...opts, privacy_status: 'friends' } })).join(' ')).toMatch(/visibility/);
    expect(youtube.validatePost(null, content('video', { title: 'T', media: [video()], options: opts }))).toEqual([]);
  });

  it('publishAt requires private visibility and the delete scope for cancellation', () => {
    const future = new Date(Date.now() + 86400_000).toISOString();
    const c = ctx('youtube', fetchDouble([]).fetch, channel);
    const p = youtube.validatePost(c, content('video', { title: 'T', media: [video()], options: opts, publishAt: future })).join(' ');
    expect(p).toMatch(/requires privacy_status "private"/);
    expect(p).toMatch(/force-ssl/);
  });

  it('submitPost rejects a missing made_for_kids without touching the network', async () => {
    const { fetch, calls } = fetchDouble([]);
    await expect(youtube.submitPost(ctx('youtube', fetch, channel), content('video', { title: 'T', media: [video()], options: { privacy_status: 'public', contains_synthetic_media: true } }), {})).rejects.toMatchObject({ kind: 'validation' });
    expect(calls).toHaveLength(0);
  });
});

describe('youtube publishing', () => {
  it('resumable upload: session POST → PUT bytes → video id → processing → poll processed → watch URL', async () => {
    const { fetch, calls } = fetchDouble([
      { method: 'POST', match: 'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status', reply: () => empty(200, { location: 'https://www.googleapis.com/upload/youtube/v3/videos?upload_id=SESSION' }) },
      { method: 'PUT', match: 'upload_id=SESSION', reply: () => json({ id: 'vid123', status: { uploadStatus: 'uploaded' } }, 201) },
      { method: 'GET', match: '/youtube/v3/videos?part=status,processingDetails&id=vid123', times: 1, reply: () => json({ items: [{ status: { uploadStatus: 'uploaded' }, processingDetails: { processingStatus: 'processing' } }] }) },
      { method: 'GET', match: '/youtube/v3/videos?part=status,processingDetails&id=vid123', reply: () => json({ items: [{ status: { uploadStatus: 'processed', privacyStatus: 'public' }, processingDetails: { processingStatus: 'succeeded' } }] }) },
    ]);
    const c = ctx('youtube', fetch, channel);
    const s = await youtube.submitPost(c, content('video', { title: 'Launch', caption: 'Description', media: [video()], options: { ...opts, category_id: '28' } }), {});
    const meta = JSON.parse(calls[0]!.body!);
    expect(meta).toEqual({ snippet: { title: 'Launch', description: 'Description', categoryId: '28' }, status: { privacyStatus: 'public', selfDeclaredMadeForKids: false, containsSyntheticMedia: false } });
    expect(calls[0]!.headers['x-upload-content-length']).toBe('64');
    expect(calls[0]!.headers['x-upload-content-type']).toBe('video/mp4');
    expect(calls[1]!.headers['content-range']).toBe('bytes 0-63/64');
    expect(calls[1]!.bodyBytes).toBe(64);
    expect(s).toMatchObject({ kind: 'processing', receipt: { remoteId: 'vid123', url: null } });
    const p1 = await youtube.pollStatus(c, s.receipt);
    expect(p1.kind).toBe('processing');
    const p2 = await youtube.pollStatus(c, p1.receipt);
    expect(p2).toMatchObject({ kind: 'published', receipt: { remoteId: 'vid123', url: 'https://www.youtube.com/watch?v=vid123' } });
  });

  it('chunked upload follows 308 Resume Incomplete and sends publishAt with private status', async () => {
    const big = 8 * 1024 * 1024 + 10;
    const { fetch, calls } = fetchDouble([
      { method: 'POST', match: 'uploadType=resumable', reply: () => empty(200, { location: 'https://www.googleapis.com/upload/youtube/v3/videos?upload_id=S2' }) },
      { method: 'PUT', match: 'upload_id=S2', times: 1, reply: () => empty(308, { range: `bytes=0-${8 * 1024 * 1024 - 1}` }) },
      { method: 'PUT', match: 'upload_id=S2', reply: () => json({ id: 'vidS' }, 200) },
    ]);
    const future = new Date(Date.now() + 2 * 86400_000).toISOString();
    const c = ctx('youtube', fetch, { ...channel, granted_scopes: [...channel.granted_scopes, FS] });
    const s = await youtube.submitPost(c, content('video', { title: 'Later', media: [video({ bytes: big })], options: { ...opts, privacy_status: 'private' }, publishAt: future }), {});
    expect(JSON.parse(calls[0]!.body!).status).toMatchObject({ privacyStatus: 'private', publishAt: future });
    expect(calls[1]!.headers['content-range']).toBe(`bytes 0-${8 * 1024 * 1024 - 1}/${big}`);
    expect(calls[2]!.headers['content-range']).toBe(`bytes ${8 * 1024 * 1024}-${big - 1}/${big}`);
    expect(s.receipt.remoteId).toBe('vidS');
  });

  it('rejected upload → failed', async () => {
    const { fetch } = fetchDouble([{ match: '/youtube/v3/videos?part=status', reply: () => json({ items: [{ status: { uploadStatus: 'rejected', rejectionReason: 'duplicate' } }] }) }]);
    expect(await youtube.pollStatus(ctx('youtube', fetch, channel), { remoteId: 'v', containerId: null, publishId: null, url: null, state: {} })).toMatchObject({ kind: 'failed', code: 'rejected:duplicate' });
  });

  it('cancelNativeSchedule deletes only a still-private future-scheduled video', async () => {
    const future = new Date(Date.now() + 86400_000).toISOString();
    const withDelete = { ...channel, granted_scopes: [...channel.granted_scopes, FS] };
    const ok = fetchDouble([
      { method: 'GET', match: '/youtube/v3/videos?part=status&id=v1', reply: () => json({ items: [{ status: { privacyStatus: 'private', publishAt: future } }] }) },
      { method: 'DELETE', match: '/youtube/v3/videos?id=v1', reply: () => empty(204) },
    ]);
    const receipt = { remoteId: 'v1', containerId: null, publishId: null, url: null, state: {} };
    expect(await cancelNativeSchedule(ctx('youtube', ok.fetch, withDelete), receipt)).toEqual({ deleted: true });
    expect(ok.calls[1]!.method).toBe('DELETE');

    const pub = fetchDouble([{ method: 'GET', match: 'part=status&id=v1', reply: () => json({ items: [{ status: { privacyStatus: 'public' } }] }) }]);
    await expect(cancelNativeSchedule(ctx('youtube', pub.fetch, withDelete), receipt)).rejects.toMatchObject({ kind: 'validation', code: 'schedule_not_cancellable' });
    expect(pub.calls.some((x) => x.method === 'DELETE')).toBe(false);

    await expect(cancelNativeSchedule(ctx('youtube', fetchDouble([]).fetch, channel), receipt)).rejects.toMatchObject({ kind: 'capability' });
  });
});

describe('youtube errors', () => {
  const post = () => content('video', { title: 'T', media: [video()], options: opts });

  it('401 → reconnect_required', async () => {
    const { fetch } = fetchDouble([{ match: 'uploadType=resumable', reply: () => json({ error: { code: 401, message: 'Invalid Credentials', errors: [{ reason: 'authError' }] } }, 401) }]);
    await expect(youtube.submitPost(ctx('youtube', fetch, channel), post(), {})).rejects.toMatchObject({ kind: 'reconnect_required' });
  });

  it('429 with Retry-After → rate_limited; 403 quotaExceeded → rate_limited', async () => {
    const a = fetchDouble([{ match: 'uploadType=resumable', reply: () => json({ error: { code: 429, message: 'slow', errors: [{ reason: 'rateLimitExceeded' }] } }, 429, { 'retry-after': '17' }) }]);
    await expect(youtube.submitPost(ctx('youtube', a.fetch, channel), post(), {})).rejects.toMatchObject({ kind: 'rate_limited', retryAfterSeconds: 17 });
    const b = fetchDouble([{ match: 'uploadType=resumable', reply: () => json({ error: { code: 403, message: 'quota', errors: [{ reason: 'quotaExceeded' }] } }, 403) }]);
    await expect(youtube.submitPost(ctx('youtube', b.fetch, channel), post(), {})).rejects.toMatchObject({ kind: 'rate_limited', code: 'quotaExceeded' });
  });

  it('timeout / 5xx on the final (creating) PUT → ambiguous', async () => {
    const a = fetchDouble([
      { method: 'POST', match: 'uploadType=resumable', reply: () => empty(200, { location: 'https://www.googleapis.com/upload/youtube/v3/videos?upload_id=S3' }) },
      { method: 'PUT', match: 'upload_id=S3', reply: () => 'timeout' },
    ]);
    await expect(youtube.submitPost(ctx('youtube', a.fetch, channel), post(), {})).rejects.toMatchObject({ kind: 'ambiguous', code: 'timeout' });
    const b = fetchDouble([
      { method: 'POST', match: 'uploadType=resumable', reply: () => empty(200, { location: 'https://www.googleapis.com/upload/youtube/v3/videos?upload_id=S4' }) },
      { method: 'PUT', match: 'upload_id=S4', reply: () => json({ error: { code: 503, message: 'backend' } }, 503) },
    ]);
    await expect(youtube.submitPost(ctx('youtube', b.fetch, channel), post(), {})).rejects.toMatchObject({ kind: 'ambiguous' });
  });
});

describe('youtube metrics', () => {
  it('reads YouTube Analytics with video filters and maps views/likes', async () => {
    const { fetch, calls } = fetchDouble([
      { match: 'youtubeanalytics.googleapis.com/v2/reports', reply: () => json({ columnHeaders: [{ name: 'video' }, { name: 'views' }, { name: 'likes' }, { name: 'comments' }, { name: 'shares' }], rows: [['vid123', 1000, 50, 4, null]] }) },
    ]);
    const rows = await youtube.fetchMetrics(ctx('youtube', fetch, channel), { objectIds: ['vid123'], since: '2026-10-01T00:00:00Z', until: '2026-10-31T00:00:00Z' });
    const q = new URL(calls[0]!.url).searchParams;
    expect(q.get('ids')).toBe('channel==MINE');
    expect(q.get('filters')).toBe('video==vid123');
    expect(q.get('startDate')).toBe('2026-10-01');
    expect(rows.map((r) => [r.rawMetric, r.metric, r.value])).toEqual([
      ['views', 'views', 1000],
      ['likes', 'likes', 50],
      ['comments', 'comments', 4],
    ]);
  });

  it('without analytics scope → capability', async () => {
    await expect(youtube.fetchMetrics(ctx('youtube', fetchDouble([]).fetch, { ...channel, granted_scopes: [UP] }), { objectIds: ['v'], since: '2026-10-01', until: '2026-10-31' })).rejects.toMatchObject({ kind: 'capability' });
  });
});
