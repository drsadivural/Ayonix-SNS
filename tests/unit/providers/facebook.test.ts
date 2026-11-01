// CONTRACT TEST with a fetch double. Not live provider evidence (docs/10-ACCEPTANCE.md).
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { facebook } from '../../../apps/worker/src/providers/facebook.js';
import { content, ctx, env, fetchDouble, form, json, media, quietLogs } from './helpers.js';

const page = { account_type: 'page', provider_account_id: '1001', metadata: { tasks: ['CREATE_CONTENT', 'ANALYZE'] }, granted_scopes: ['pages_show_list', 'pages_read_engagement', 'pages_manage_posts', 'read_insights'] };
const tokens = { account: 'PAGE_TOKEN' };
// Independent appsecret_proof computation (hex HMAC-SHA256 of the token keyed by the app secret).
const proofs: Record<string, string> = {};
async function computeProof(t: string) {
  const enc = new TextEncoder();
  const k = await crypto.subtle.importKey('raw', enc.encode('meta-secret'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  proofs[t] = [...new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(t)))].map((b) => b.toString(16).padStart(2, '0')).join('');
}
const proofOf = (t: string) => proofs[t]!;
const G = 'https://graph.facebook.com/v26.0';

beforeAll(async () => {
  await computeProof('LONG');
  await computeProof('PAGE_TOKEN');
});
beforeEach(quietLogs);

describe('facebook oauth', () => {
  it('authorizeUrl uses Facebook Login with state, exact redirect and Page scopes', () => {
    const u = new URL(facebook.authorizeUrl(env, { state: 's1', codeChallenge: 'c', redirectUri: 'https://app.example.test/cb/fb' }));
    expect(u.origin + u.pathname).toBe('https://www.facebook.com/v26.0/dialog/oauth');
    expect(u.searchParams.get('state')).toBe('s1');
    expect(u.searchParams.get('redirect_uri')).toBe('https://app.example.test/cb/fb');
    expect(u.searchParams.get('scope')).toBe('pages_show_list,pages_read_engagement,pages_manage_posts,read_insights');
    expect(u.searchParams.has('code_challenge')).toBe(false);
  });

  it('exchangeCode exchanges for a long-lived token and reads granted permissions', async () => {
    const { fetch, calls } = fetchDouble([
      { method: 'POST', match: '/oauth/access_token', times: 1, reply: () => json({ access_token: 'SHORT', expires_in: 3600 }) },
      { method: 'POST', match: '/oauth/access_token', times: 1, reply: () => json({ access_token: 'LONG', expires_in: 5183944 }) },
      { method: 'GET', match: '/me/permissions', reply: () => json({ data: [{ permission: 'pages_show_list', status: 'granted' }, { permission: 'pages_manage_posts', status: 'granted' }, { permission: 'read_insights', status: 'declined' }] }) },
      { method: 'GET', match: `${G}/me?`, reply: () => json({ id: 'u1' }) },
    ]);
    const t = await facebook.exchangeCode(env, 'CODE', '', 'https://app.example.test/cb/fb', fetch);
    expect(t.accessToken).toBe('LONG');
    expect(t.scopes).toEqual(['pages_show_list', 'pages_manage_posts']);
    expect(t.subject).toBe('u1');
    expect(Date.parse(t.expiresAt!) - Date.now()).toBeGreaterThan(5_000_000_000);
    expect(form(calls[0]!.body)).toMatchObject({ code: 'CODE', redirect_uri: 'https://app.example.test/cb/fb', client_id: 'meta-app' });
    expect(form(calls[1]!.body)).toMatchObject({ grant_type: 'fb_exchange_token', fb_exchange_token: 'SHORT' });
    expect(calls[2]!.url).toContain(`appsecret_proof=${proofOf('LONG')}`);
    expect(calls[2]!.url).not.toContain('LONG');
  });

  it('refreshOrReconnect reports reconnect near expiry (no refresh grant)', async () => {
    const { fetch, calls } = fetchDouble([]);
    const r = await facebook.refreshOrReconnect(ctx('facebook', fetch, page, { ...tokens, expiresAt: new Date(Date.now() + 86400_000).toISOString() }));
    expect(r.kind).toBe('reconnect_required');
    expect(calls).toHaveLength(0);
  });
});

describe('facebook discovery', () => {
  it('returns managed Pages with Page tokens; no personal profile', async () => {
    const { fetch, calls } = fetchDouble([{ match: '/me/accounts', reply: () => json({ data: [{ id: '1001', name: 'Cafe', access_token: 'PT1', tasks: ['CREATE_CONTENT', 'ANALYZE'] }, { id: '1002', name: 'Viewer page', access_token: 'PT2', tasks: ['ANALYZE'] }] }) }]);
    const accts = await facebook.discoverAccounts(env, { accessToken: 'UT', scopes: page.granted_scopes }, fetch);
    expect(accts.map((a) => [a.providerAccountId, a.type, a.accountAccessToken])).toEqual([
      ['1001', 'page', 'PT1'],
      ['1002', 'page', 'PT2'],
    ]);
    expect(accts[0]!.capabilities.find((c) => c.capability === 'publish_image')!.status).toBe('available');
    expect(accts[1]!.capabilities.find((c) => c.capability === 'publish_image')!.status).toBe('unavailable');
    expect(calls[0]!.headers.authorization).toBe('Bearer UT');
  });

  it('no Pages → capability error', async () => {
    const { fetch } = fetchDouble([{ match: '/me/accounts', reply: () => json({ data: [] }) }]);
    await expect(facebook.discoverAccounts(env, { accessToken: 'UT', scopes: [] }, fetch)).rejects.toMatchObject({ kind: 'capability', code: 'no_pages' });
  });
});

describe('facebook publishing', () => {
  it('text/link → /{page}/feed with page token + appsecret_proof; remoteId from response', async () => {
    const { fetch, calls } = fetchDouble([
      { method: 'POST', match: `${G}/1001/feed`, reply: () => json({ id: '1001_555' }) },
      { method: 'GET', match: `${G}/1001_555?`, reply: () => json({ permalink_url: 'https://www.facebook.com/1001/posts/555' }) },
    ]);
    const r = await facebook.submitPost(ctx('facebook', fetch, page, tokens), content('link', { caption: 'Read this', linkUrl: 'https://example.com/x' }), {});
    expect(r).toMatchObject({ kind: 'published', receipt: { remoteId: '1001_555', url: 'https://www.facebook.com/1001/posts/555' } });
    const f = form(calls[0]!.body);
    expect(f).toMatchObject({ message: 'Read this', link: 'https://example.com/x', appsecret_proof: proofOf('PAGE_TOKEN') });
    expect(calls[0]!.headers.authorization).toBe('Bearer PAGE_TOKEN');
  });

  it('single image → /{page}/photos with url = publicUrl; remoteId = post_id', async () => {
    const { fetch, calls } = fetchDouble([
      { method: 'POST', match: `${G}/1001/photos`, reply: () => json({ id: 'photo9', post_id: '1001_9' }) },
      { method: 'GET', match: 'permalink_url', reply: () => json({ status: 500 }, 500) },
    ]);
    const m = media();
    const r = await facebook.submitPost(ctx('facebook', fetch, page, tokens), content('image', { media: [m] }), {});
    expect(form(calls[0]!.body)).toMatchObject({ url: m.publicUrl, caption: 'Hello world' });
    expect(r).toMatchObject({ kind: 'published', receipt: { remoteId: '1001_9', url: null } });
  });

  it('multiple images → unpublished photos then attached_media on /feed', async () => {
    let n = 0;
    const { fetch, calls } = fetchDouble([
      { method: 'POST', match: `${G}/1001/photos`, reply: () => json({ id: `ph${++n}` }) },
      { method: 'POST', match: `${G}/1001/feed`, reply: () => json({ id: '1001_77' }) },
      { method: 'GET', match: 'permalink_url', reply: () => json({ permalink_url: '/1001/posts/77' }) },
    ]);
    const c = ctx('facebook', fetch, page, tokens);
    const post = content('image', { media: [media(), media()] });
    const up = await facebook.uploadMedia(c, post);
    expect(up).toEqual({ photoIds: ['ph1', 'ph2'] });
    expect(form(calls[0]!.body).published).toBe('false');
    const r = await facebook.submitPost(c, post, up);
    const f = form(calls[2]!.body);
    expect(f['attached_media[0]']).toBe('{"media_fbid":"ph1"}');
    expect(f['attached_media[1]']).toBe('{"media_fbid":"ph2"}');
    expect(r.receipt).toMatchObject({ remoteId: '1001_77', url: 'https://www.facebook.com/1001/posts/77' });
  });

  it('video → /{page}/videos (file_url) → processing → poll status ready → published', async () => {
    const { fetch, calls } = fetchDouble([
      { method: 'POST', match: 'https://graph-video.facebook.com/v26.0/1001/videos', reply: () => json({ id: 'vid1' }) },
      { method: 'GET', match: `${G}/vid1?`, times: 1, reply: () => json({ status: { video_status: 'processing' } }) },
      { method: 'GET', match: `${G}/vid1?`, reply: () => json({ status: { video_status: 'ready', publishing_phase: { status: 'complete' } }, permalink_url: '/1001/videos/vid1' }) },
    ]);
    const c = ctx('facebook', fetch, page, tokens);
    const m = media({ mime: 'video/mp4' });
    const s = await facebook.submitPost(c, content('video', { media: [m] }), {});
    expect(form(calls[0]!.body)).toMatchObject({ file_url: m.publicUrl, description: 'Hello world' });
    expect(s).toMatchObject({ kind: 'processing', receipt: { remoteId: 'vid1' } });
    const p1 = await facebook.pollStatus(c, s.receipt);
    expect(p1.kind).toBe('processing');
    const p2 = await facebook.pollStatus(c, p1.receipt);
    expect(p2).toMatchObject({ kind: 'published', receipt: { remoteId: 'vid1', url: 'https://www.facebook.com/1001/videos/vid1' } });
  });

  it('reel → start / rupload file_url / finish → processing; error status → failed', async () => {
    const { fetch, calls } = fetchDouble([
      { method: 'POST', match: `${G}/1001/video_reels`, times: 1, reply: () => json({ video_id: 'r1', upload_url: 'https://rupload.facebook.com/video-upload/v26.0/r1' }) },
      { method: 'POST', match: 'https://rupload.facebook.com/video-upload/v26.0/r1', reply: () => json({ success: true }) },
      { method: 'POST', match: `${G}/1001/video_reels`, reply: () => json({ success: true }) },
      { method: 'GET', match: `${G}/r1?`, reply: () => json({ status: { video_status: 'error', processing_phase: { status: 'error', error: { message: 'bad codec' } } } }) },
    ]);
    const c = ctx('facebook', fetch, page, tokens);
    const m = media({ mime: 'video/mp4', width: 1080, height: 1920, durationMs: 20_000 });
    const post = content('reel', { media: [m] });
    const up = await facebook.uploadMedia(c, post);
    expect(up).toEqual({ videoId: 'r1' });
    expect(form(calls[0]!.body).upload_phase).toBe('start');
    expect(calls[1]!.headers.file_url).toBe(m.publicUrl);
    expect(calls[1]!.headers.authorization).toBe('OAuth PAGE_TOKEN');
    const s = await facebook.submitPost(c, post, up);
    expect(form(calls[2]!.body)).toMatchObject({ upload_phase: 'finish', video_id: 'r1', video_state: 'PUBLISHED', description: 'Hello world' });
    expect(s).toMatchObject({ kind: 'processing', receipt: { remoteId: 'r1' } });
    expect(await facebook.pollStatus(c, s.receipt)).toMatchObject({ kind: 'failed', message: 'bad codec' });
  });

  it('personal profiles are rejected', () => {
    expect(facebook.validatePost(ctx('facebook', fetchDouble([]).fetch, { ...page, account_type: 'member' }), content('text')).join(' ')).toMatch(/personal profiles/);
  });
});

describe('facebook errors', () => {
  it('Graph code 190 (HTTP 400) → reconnect_required; 401 → reconnect_required', async () => {
    const a = fetchDouble([{ match: '/feed', reply: () => json({ error: { message: 'Error validating access token', type: 'OAuthException', code: 190 } }, 400) }]);
    await expect(facebook.submitPost(ctx('facebook', a.fetch, page, tokens), content('text'), {})).rejects.toMatchObject({ kind: 'reconnect_required', code: '190' });
    const b = fetchDouble([{ match: '/feed', reply: () => json({ error: { message: 'bad token', code: 190 } }, 401) }]);
    await expect(facebook.submitPost(ctx('facebook', b.fetch, page, tokens), content('text'), {})).rejects.toMatchObject({ kind: 'reconnect_required' });
  });

  it('429 with Retry-After and Meta throttling code 32 → rate_limited', async () => {
    const a = fetchDouble([{ match: '/feed', reply: () => json({ error: { message: 'slow down', code: 4 } }, 429, { 'retry-after': '90' }) }]);
    await expect(facebook.submitPost(ctx('facebook', a.fetch, page, tokens), content('text'), {})).rejects.toMatchObject({ kind: 'rate_limited', retryAfterSeconds: 90 });
    const b = fetchDouble([{ match: '/feed', reply: () => json({ error: { message: 'Page request limit reached', code: 32 } }, 400) }]);
    await expect(facebook.submitPost(ctx('facebook', b.fetch, page, tokens), content('text'), {})).rejects.toMatchObject({ kind: 'rate_limited' });
  });

  it('permission error (code 200) → capability', async () => {
    const { fetch } = fetchDouble([{ match: '/feed', reply: () => json({ error: { message: 'Requires pages_manage_posts', code: 200 } }, 403) }]);
    await expect(facebook.submitPost(ctx('facebook', fetch, page, tokens), content('text'), {})).rejects.toMatchObject({ kind: 'capability' });
  });

  it('timeout / 5xx on create → ambiguous', async () => {
    const a = fetchDouble([{ match: '/feed', reply: () => 'timeout' }]);
    await expect(facebook.submitPost(ctx('facebook', a.fetch, page, tokens), content('text'), {})).rejects.toMatchObject({ kind: 'ambiguous' });
    const b = fetchDouble([{ match: '/feed', reply: () => json({ error: { message: 'unknown', code: 1, is_transient: true } }, 500) }]);
    await expect(facebook.submitPost(ctx('facebook', b.fetch, page, tokens), content('text'), {})).rejects.toMatchObject({ kind: 'ambiguous' });
  });
});

describe('facebook metrics and disconnect', () => {
  it('maps only matching insights metrics; missing values produce no rows', async () => {
    const { fetch, calls } = fetchDouble([
      { match: '/1001_1/insights', reply: () => json({ data: [{ name: 'post_clicks', period: 'lifetime', values: [{ value: 4 }] }, { name: 'post_media_view', period: 'lifetime', values: [{ value: 100 }] }, { name: 'post_reactions_like_total', period: 'lifetime', values: [{}] }] }) },
    ]);
    const rows = await facebook.fetchMetrics(ctx('facebook', fetch, page, tokens), { objectIds: ['1001_1'], since: '2026-10-01', until: '2026-10-31' });
    expect(calls[0]!.url).toContain('metric=post_media_view%2Cpost_clicks%2Cpost_reactions_like_total');
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.rawMetric === 'post_clicks')!.metric).toBe('clicks');
    expect(rows.find((r) => r.rawMetric === 'post_media_view')!.metric).toBeNull();
  });

  it('metrics without read_insights → capability', async () => {
    await expect(facebook.fetchMetrics(ctx('facebook', fetchDouble([]).fetch, { ...page, granted_scopes: ['pages_manage_posts'] }, tokens), { objectIds: ['x'], since: '2026-10-01', until: '2026-10-31' })).rejects.toMatchObject({ kind: 'capability' });
  });

  it('disconnect revokes via DELETE /me/permissions', async () => {
    const { fetch, calls } = fetchDouble([{ method: 'DELETE', match: `${G}/me/permissions`, reply: () => json({ success: true }) }]);
    expect(await facebook.disconnect(ctx('facebook', fetch, page, tokens))).toEqual({ revoked: true });
    expect(calls[0]!.headers.authorization).toBe('Bearer USER_TOKEN');
  });
});
