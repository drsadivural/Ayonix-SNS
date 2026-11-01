// CONTRACT TEST with a fetch double. Not live provider evidence (docs/10-ACCEPTANCE.md).
import { beforeEach, describe, expect, it } from 'vitest';
import { instagram } from '../../../apps/worker/src/providers/instagram.js';
import { content, ctx, env, fetchDouble, form, json, media, quietLogs } from './helpers.js';

const ig = { account_type: 'ig_professional', provider_account_id: '1789', metadata: { page_id: '1001' }, granted_scopes: ['instagram_basic', 'instagram_content_publish', 'pages_show_list', 'pages_read_engagement', 'instagram_manage_insights'] };
const tokens = { account: 'PAGE_TOKEN' };
const G = 'https://graph.facebook.com/v26.0';

beforeEach(quietLogs);

describe('instagram oauth + discovery (Facebook Login path)', () => {
  it('authorizeUrl requests only Facebook-Login-path scopes', () => {
    const u = new URL(instagram.authorizeUrl(env, { state: 's', codeChallenge: 'c', redirectUri: 'https://app.example.test/cb/ig' }));
    expect(u.searchParams.get('scope')).toBe('instagram_basic,instagram_content_publish,pages_show_list,pages_read_engagement,instagram_manage_insights');
    expect(u.searchParams.get('scope')).not.toContain('instagram_business_');
    expect(u.searchParams.get('state')).toBe('s');
    expect(u.searchParams.get('redirect_uri')).toBe('https://app.example.test/cb/ig');
  });

  it('exchangeCode reads scopes from /me/permissions', async () => {
    const { fetch } = fetchDouble([
      { method: 'POST', match: '/oauth/access_token', times: 1, reply: () => json({ access_token: 'S', expires_in: 3600 }) },
      { method: 'POST', match: '/oauth/access_token', times: 1, reply: () => json({ access_token: 'L', expires_in: 5000000 }) },
      { match: '/me/permissions', reply: () => json({ data: [{ permission: 'instagram_basic', status: 'granted' }, { permission: 'instagram_content_publish', status: 'granted' }] }) },
      { match: `${G}/me?`, reply: () => json({ id: 'u1' }) },
    ]);
    const t = await instagram.exchangeCode(env, 'c', '', 'https://app.example.test/cb/ig', fetch);
    expect(t.scopes).toEqual(['instagram_basic', 'instagram_content_publish']);
    expect(t.expiresAt).not.toBeNull();
  });

  it('discovers IG Business/Creator accounts linked to Pages, storing page id and page token', async () => {
    const { fetch } = fetchDouble([
      {
        match: '/me/accounts',
        reply: () => json({ data: [{ id: '1001', name: 'Cafe', access_token: 'PT', tasks: ['CREATE_CONTENT'], instagram_business_account: { id: '1789', username: 'cafe.ig' } }, { id: '1002', name: 'No IG', access_token: 'PT2', tasks: ['CREATE_CONTENT'] }] }),
      },
    ]);
    const accts = await instagram.discoverAccounts(env, { accessToken: 'UT', scopes: ig.granted_scopes }, fetch);
    expect(accts).toHaveLength(1);
    expect(accts[0]).toMatchObject({ providerAccountId: '1789', name: 'cafe.ig', type: 'ig_professional', accountAccessToken: 'PT', metadata: { page_id: '1001' } });
  });

  it('rejects when only consumer/unlinked accounts exist, with a useful explanation', async () => {
    const { fetch } = fetchDouble([{ match: '/me/accounts', reply: () => json({ data: [{ id: '1002', name: 'No IG', access_token: 'PT2' }] }) }]);
    await expect(instagram.discoverAccounts(env, { accessToken: 'UT', scopes: [] }, fetch)).rejects.toMatchObject({ kind: 'capability', code: 'no_instagram_professional_account', message: expect.stringMatching(/Professional/) });
  });
});

describe('instagram validation', () => {
  it('requires media and enforces feed aspect ratio, JPEG and carousel size', () => {
    expect(instagram.validatePost(null, content('text')).join(' ')).toMatch(/media is required/);
    expect(instagram.validatePost(null, content('image', { media: [media({ width: 1000, height: 2000 })] })).join(' ')).toMatch(/4:5 and 1.91:1/);
    expect(instagram.validatePost(null, content('image', { media: [media({ mime: 'image/png' })] })).join(' ')).toMatch(/JPEG/);
    expect(instagram.validatePost(null, content('carousel', { media: [media()] })).join(' ')).toMatch(/2–10/);
    expect(instagram.validatePost(null, content('image', { media: [media({ width: 1080, height: 1350 })] }))).toEqual([]);
    expect(instagram.validatePost(null, content('reel', { media: [media({ mime: 'video/mp4', durationMs: 30_000, width: 1080, height: 1920 })] }))).toEqual([]);
  });
});

describe('instagram publishing', () => {
  it('image: container → processing → poll FINISHED → media_publish once → permalink', async () => {
    const { fetch, calls } = fetchDouble([
      { method: 'POST', match: /\/1789\/media$/, reply: () => json({ id: 'cont1' }) },
      { method: 'GET', match: `${G}/cont1?`, times: 1, reply: () => json({ status_code: 'IN_PROGRESS' }) },
      { method: 'GET', match: `${G}/cont1?`, reply: () => json({ status_code: 'FINISHED' }) },
      { method: 'POST', match: `${G}/1789/media_publish`, reply: () => json({ id: 'media99' }) },
      { method: 'GET', match: `${G}/media99?`, reply: () => json({ permalink: 'https://www.instagram.com/p/abc/' }) },
    ]);
    const c = ctx('instagram', fetch, ig, tokens);
    const m = media({ width: 1080, height: 1350 });
    const s = await instagram.submitPost(c, content('image', { media: [m], caption: 'cap' }), {});
    expect(calls[0]!.url).toBe(`${G}/1789/media`);
    expect(form(calls[0]!.body)).toMatchObject({ image_url: m.publicUrl, caption: 'cap' });
    expect(s).toMatchObject({ kind: 'processing', receipt: { containerId: 'cont1', remoteId: null } });
    const p1 = await instagram.pollStatus(c, s.receipt);
    expect(p1.kind).toBe('processing');
    const p2 = await instagram.pollStatus(c, p1.receipt);
    expect(form(calls.find((x) => x.url.includes('media_publish'))!.body).creation_id).toBe('cont1');
    expect(p2).toMatchObject({ kind: 'published', receipt: { containerId: 'cont1', remoteId: 'media99', url: 'https://www.instagram.com/p/abc/' } });
    // Already-published receipt never publishes again.
    const p3 = await instagram.pollStatus(c, p2.receipt);
    expect(p3.kind).toBe('published');
    expect(calls.filter((x) => x.url.includes('media_publish'))).toHaveLength(1);
  });

  it('double media_publish guard: lost publish response → ambiguous, second poll never publishes', async () => {
    const { fetch, calls } = fetchDouble([
      { method: 'GET', match: `${G}/cont2?`, reply: () => json({ status_code: 'FINISHED' }) },
      { method: 'POST', match: `${G}/1789/media_publish`, reply: () => 'timeout' },
    ]);
    const c = ctx('instagram', fetch, ig, tokens);
    const receipt = { remoteId: null, containerId: 'cont2', publishId: null, url: null, state: { ig_user_id: '1789', publish_requested: false } };
    await expect(instagram.pollStatus(c, receipt)).rejects.toMatchObject({ kind: 'ambiguous' });
    expect(receipt.state.publish_requested).toBe(true);
    await expect(instagram.pollStatus(c, receipt)).rejects.toMatchObject({ kind: 'ambiguous', code: 'publish_outcome_unknown' });
    expect(calls.filter((x) => x.url.includes('media_publish'))).toHaveLength(1);
  });

  it('carousel: child containers with is_carousel_item then CAROUSEL container with children', async () => {
    let n = 0;
    const { fetch, calls } = fetchDouble([{ method: 'POST', match: `${G}/1789/media`, reply: () => json({ id: `c${++n}` }) }]);
    const c = ctx('instagram', fetch, ig, tokens);
    const post = content('carousel', { media: [media(), media({ mime: 'video/mp4', durationMs: 10_000 })] });
    const up = await instagram.uploadMedia(c, post);
    expect(up).toEqual({ children: ['c1', 'c2'] });
    expect(form(calls[0]!.body)).toMatchObject({ is_carousel_item: 'true', image_url: post.media[0]!.publicUrl });
    expect(form(calls[1]!.body)).toMatchObject({ is_carousel_item: 'true', media_type: 'VIDEO', video_url: post.media[1]!.publicUrl });
    const s = await instagram.submitPost(c, post, up);
    expect(form(calls[2]!.body)).toMatchObject({ media_type: 'CAROUSEL', children: 'c1,c2', caption: 'Hello world' });
    expect(s.receipt.containerId).toBe('c3');
  });

  it('reel container uses media_type=REELS and video_url; ERROR → failed', async () => {
    const { fetch, calls } = fetchDouble([
      { method: 'POST', match: `${G}/1789/media`, reply: () => json({ id: 'rc' }) },
      { method: 'GET', match: `${G}/rc?`, reply: () => json({ status_code: 'ERROR', status: 'Error: unsupported codec' }) },
    ]);
    const c = ctx('instagram', fetch, ig, tokens);
    const m = media({ mime: 'video/mp4', durationMs: 20_000 });
    const s = await instagram.submitPost(c, content('reel', { media: [m] }), {});
    expect(form(calls[0]!.body)).toMatchObject({ media_type: 'REELS', video_url: m.publicUrl });
    expect(await instagram.pollStatus(c, s.receipt)).toMatchObject({ kind: 'failed', code: 'container_error' });
  });
});

describe('instagram errors', () => {
  it('401 → reconnect_required; 429 → rate_limited; 5xx on media_publish → ambiguous', async () => {
    const a = fetchDouble([{ match: '/media', reply: () => json({ error: { message: 'expired', code: 190 } }, 401) }]);
    await expect(instagram.submitPost(ctx('instagram', a.fetch, ig, tokens), content('image', { media: [media()] }), {})).rejects.toMatchObject({ kind: 'reconnect_required' });
    const b = fetchDouble([{ match: '/media', reply: () => json({ error: { message: 'limit', code: 4 } }, 429, { 'retry-after': '30' }) }]);
    await expect(instagram.submitPost(ctx('instagram', b.fetch, ig, tokens), content('image', { media: [media()] }), {})).rejects.toMatchObject({ kind: 'rate_limited', retryAfterSeconds: 30 });
    const c = fetchDouble([
      { method: 'GET', match: '/cont3?', reply: () => json({ status_code: 'FINISHED' }) },
      { method: 'POST', match: '/media_publish', reply: () => json({ error: { message: 'oops', code: 2 } }, 503) },
    ]);
    await expect(instagram.pollStatus(ctx('instagram', c.fetch, ig, tokens), { remoteId: null, containerId: 'cont3', publishId: null, url: null, state: {} })).rejects.toMatchObject({ kind: 'ambiguous' });
  });
});

describe('instagram metrics', () => {
  it('maps reach/likes/saved and leaves total_interactions unnormalized', async () => {
    const { fetch } = fetchDouble([
      { match: '/media99/insights', reply: () => json({ data: [{ name: 'reach', period: 'lifetime', values: [{ value: 10 }] }, { name: 'saved', values: [{ value: 2 }] }, { name: 'total_interactions', values: [{ value: 5 }] }] }) },
    ]);
    const rows = await instagram.fetchMetrics(ctx('instagram', fetch, ig, tokens), { objectIds: ['media99'], since: '2026-10-01', until: '2026-10-31' });
    expect(rows.map((r) => [r.rawMetric, r.metric, r.value])).toEqual([
      ['reach', 'reach', 10],
      ['saved', 'saves', 2],
      ['total_interactions', null, 5],
    ]);
  });
});
