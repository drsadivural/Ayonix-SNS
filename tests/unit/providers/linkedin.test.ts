// CONTRACT TEST with a fetch double. Not live provider evidence (docs/10-ACCEPTANCE.md).
import { beforeEach, describe, expect, it } from 'vitest';
import { escapeLittle, linkedin } from '../../../apps/worker/src/providers/linkedin.js';
import { content, ctx, empty, env, fetchDouble, form, json, media, quietLogs } from './helpers.js';

const member = { account_type: 'member', provider_account_id: 'urn:li:person:abc', metadata: { urn: 'urn:li:person:abc' }, granted_scopes: ['openid', 'profile', 'w_member_social'] };
const org = { account_type: 'organization', provider_account_id: 'urn:li:organization:42', metadata: { urn: 'urn:li:organization:42' }, granted_scopes: ['w_organization_social', 'rw_organization_admin'] };

beforeEach(quietLogs);

describe('linkedin oauth', () => {
  it('authorizeUrl carries state, exact redirect and minimal scopes (no PKCE in LinkedIn web flow)', () => {
    const u = new URL(linkedin.authorizeUrl(env, { state: 'st8', codeChallenge: 'ch', redirectUri: 'https://app.example.test/cb/linkedin' }));
    expect(u.origin + u.pathname).toBe('https://www.linkedin.com/oauth/v2/authorization');
    expect(u.searchParams.get('state')).toBe('st8');
    expect(u.searchParams.get('redirect_uri')).toBe('https://app.example.test/cb/linkedin');
    expect(u.searchParams.get('scope')).toBe('openid profile w_member_social');
    expect(u.searchParams.get('response_type')).toBe('code');
    expect(u.searchParams.has('code_challenge')).toBe(false);
  });

  it('requests organization scopes only when enabled', () => {
    expect(linkedin.scopes({ ...env, LINKEDIN_ENABLE_ORGANIZATIONS: 'true' } as typeof env)).toEqual(['openid', 'profile', 'w_member_social', 'w_organization_social', 'rw_organization_admin']);
  });

  it('exchangeCode parses expiry and granted scopes from the token response', async () => {
    const { fetch, calls } = fetchDouble([{ method: 'POST', match: '/oauth/v2/accessToken', reply: () => json({ access_token: 'AT', expires_in: 5184000, scope: 'openid,profile,w_member_social' }) }]);
    const t = await linkedin.exchangeCode(env, 'code1', 'verifier', 'https://app.example.test/cb', fetch);
    expect(t.scopes).toEqual(['openid', 'profile', 'w_member_social']);
    expect(Date.parse(t.expiresAt!) - Date.now()).toBeGreaterThan(5183000 * 1000);
    expect(t.refreshToken).toBeNull();
    const f = form(calls[0]!.body);
    expect(f).toMatchObject({ grant_type: 'authorization_code', code: 'code1', redirect_uri: 'https://app.example.test/cb', client_id: 'li-client' });
  });

  it('refreshOrReconnect requires reconnect when no refresh token was issued', async () => {
    const { fetch, calls } = fetchDouble([]);
    expect(await linkedin.refreshOrReconnect(ctx('linkedin', fetch, member))).toMatchObject({ kind: 'reconnect_required' });
    expect(calls).toHaveLength(0);
  });
});

describe('linkedin discovery', () => {
  it('returns the member from userinfo and administered organizations', async () => {
    const { fetch, calls } = fetchDouble([
      { match: '/v2/userinfo', reply: () => json({ sub: 'abc', name: 'Ada' }) },
      { match: '/rest/organizationAcls', reply: () => json({ elements: [{ role: 'ADMINISTRATOR', state: 'APPROVED', organization: 'urn:li:organization:42' }] }) },
      { match: '/rest/organizations/42', reply: () => json({ localizedName: 'Acme' }) },
    ]);
    const accts = await linkedin.discoverAccounts(env, { accessToken: 'AT', scopes: ['openid', 'profile', 'w_member_social', 'w_organization_social', 'rw_organization_admin'] }, fetch);
    expect(accts.map((a) => [a.providerAccountId, a.type, a.name])).toEqual([
      ['urn:li:person:abc', 'member', 'Ada'],
      ['urn:li:organization:42', 'organization', 'Acme'],
    ]);
    expect(calls[1]!.url).toContain('role=ADMINISTRATOR');
    expect(calls[1]!.headers['linkedin-version']).toBe('202610');
  });

  it('skips the organization lookup when the org scope was not granted', async () => {
    const { fetch, calls } = fetchDouble([{ match: '/v2/userinfo', reply: () => json({ sub: 'abc', name: 'Ada' }) }]);
    const accts = await linkedin.discoverAccounts(env, { accessToken: 'AT', scopes: ['openid', 'profile', 'w_member_social'] }, fetch);
    expect(accts).toHaveLength(1);
    expect(calls).toHaveLength(1);
    expect(accts[0]!.capabilities.find((c) => c.capability === 'publish_carousel')!.status).toBe('unavailable');
  });
});

describe('linkedin publishing', () => {
  it('text post: POST /rest/posts with version headers; remoteId from x-restli-id', async () => {
    const { fetch, calls } = fetchDouble([{ method: 'POST', match: 'https://api.linkedin.com/rest/posts', reply: () => empty(201, { 'x-restli-id': 'urn:li:share:777' }) }]);
    const c = ctx('linkedin', fetch, member);
    const r = await linkedin.submitPost(c, content('text', { caption: 'Hi (team) #launch' }), {});
    expect(r).toEqual({ kind: 'published', receipt: expect.objectContaining({ remoteId: 'urn:li:share:777', url: 'https://www.linkedin.com/feed/update/urn:li:share:777' }) });
    const req = calls[0]!;
    expect(req.headers['linkedin-version']).toBe('202610');
    expect(req.headers['x-restli-protocol-version']).toBe('2.0.0');
    const body = JSON.parse(req.body!);
    expect(body).toMatchObject({ author: 'urn:li:person:abc', commentary: 'Hi \\(team\\) #launch', visibility: 'PUBLIC', lifecycleState: 'PUBLISHED' });
  });

  it('link post uses content.article', async () => {
    const { fetch, calls } = fetchDouble([{ method: 'POST', match: '/rest/posts', reply: () => empty(201, { 'x-restli-id': 'urn:li:share:1' }) }]);
    await linkedin.submitPost(ctx('linkedin', fetch, org), content('link', { linkUrl: 'https://example.com/a', title: 'A' }), {});
    expect(JSON.parse(calls[0]!.body!).content).toEqual({ article: { source: 'https://example.com/a', title: 'A' } });
    expect(JSON.parse(calls[0]!.body!).author).toBe('urn:li:organization:42');
  });

  it('single image: initializeUpload → PUT bytes → post with content.media.id', async () => {
    const { fetch, calls } = fetchDouble([
      { method: 'POST', match: '/rest/images?action=initializeUpload', reply: () => json({ value: { uploadUrl: 'https://www.linkedin.com/dms-uploads/img1', image: 'urn:li:image:I1' } }) },
      { method: 'PUT', match: '/dms-uploads/img1', reply: () => empty(201) },
      { method: 'POST', match: '/rest/posts', reply: () => empty(201, { 'x-restli-id': 'urn:li:share:9' }) },
    ]);
    const c = ctx('linkedin', fetch, member);
    const post = content('image', { media: [media({ bytes: 20 })] });
    const up = await linkedin.uploadMedia(c, post);
    expect(up).toEqual({ images: ['urn:li:image:I1'] });
    expect(JSON.parse(calls[0]!.body!)).toEqual({ initializeUploadRequest: { owner: 'urn:li:person:abc' } });
    expect(calls[1]!.bodyBytes).toBe(20);
    const r = await linkedin.submitPost(c, post, up);
    expect(JSON.parse(calls[2]!.body!).content).toEqual({ media: { id: 'urn:li:image:I1' } });
    expect(r.receipt.remoteId).toBe('urn:li:share:9');
  });

  it('multiple images use content.multiImage', async () => {
    const { fetch, calls } = fetchDouble([{ method: 'POST', match: '/rest/posts', reply: () => empty(201, { 'x-restli-id': 'urn:li:share:10' }) }]);
    await linkedin.submitPost(ctx('linkedin', fetch, member), content('image', { media: [media(), media()] }), { images: ['urn:li:image:A', 'urn:li:image:B'] });
    expect(JSON.parse(calls[0]!.body!).content).toEqual({ multiImage: { images: [{ id: 'urn:li:image:A' }, { id: 'urn:li:image:B' }] } });
  });

  it('video: initialize → PUT parts per uploadInstructions → finalize with ETags → processing → poll → published', async () => {
    const { fetch, calls } = fetchDouble([
      {
        method: 'POST',
        match: '/rest/videos?action=initializeUpload',
        reply: () =>
          json({
            value: {
              video: 'urn:li:video:V1',
              uploadToken: 'tok',
              uploadInstructions: [
                { uploadUrl: 'https://www.linkedin.com/dms-uploads/v/part1', firstByte: 0, lastByte: 5 },
                { uploadUrl: 'https://www.linkedin.com/dms-uploads/v/part2', firstByte: 6, lastByte: 9 },
              ],
            },
          }),
      },
      { method: 'PUT', match: '/part1', reply: () => empty(200, { etag: 'e1' }) },
      { method: 'PUT', match: '/part2', reply: () => empty(200, { etag: 'e2' }) },
      { method: 'POST', match: '/rest/videos?action=finalizeUpload', reply: () => empty(200) },
      { method: 'POST', match: '/rest/posts', reply: () => empty(201, { 'x-restli-id': 'urn:li:ugcPost:55' }) },
      { method: 'GET', match: '/rest/videos/urn%3Ali%3Avideo%3AV1', times: 1, reply: () => json({ status: 'PROCESSING' }) },
      { method: 'GET', match: '/rest/videos/urn%3Ali%3Avideo%3AV1', reply: () => json({ status: 'AVAILABLE' }) },
    ]);
    const c = ctx('linkedin', fetch, member);
    const post = content('video', { media: [media({ mime: 'video/mp4', bytes: 10 })] });
    const up = await linkedin.uploadMedia(c, post);
    expect(up).toEqual({ video: 'urn:li:video:V1' });
    expect(calls[1]!.bodyBytes).toBe(6);
    expect(calls[2]!.bodyBytes).toBe(4);
    expect(JSON.parse(calls[3]!.body!)).toEqual({ finalizeUploadRequest: { video: 'urn:li:video:V1', uploadToken: 'tok', uploadedPartIds: ['e1', 'e2'] } });
    const s = await linkedin.submitPost(c, post, up);
    expect(s.kind).toBe('processing');
    expect(JSON.parse(calls[4]!.body!).content).toEqual({ media: { id: 'urn:li:video:V1' } });
    const p1 = await linkedin.pollStatus(c, s.receipt);
    expect(p1.kind).toBe('processing');
    const p2 = await linkedin.pollStatus(c, p1.receipt);
    expect(p2).toMatchObject({ kind: 'published', receipt: { remoteId: 'urn:li:ugcPost:55', url: 'https://www.linkedin.com/feed/update/urn:li:ugcPost:55' } });
  });

  it('never invents a post URN when x-restli-id is missing (ambiguous)', async () => {
    const { fetch } = fetchDouble([{ method: 'POST', match: '/rest/posts', reply: () => empty(201) }]);
    await expect(linkedin.submitPost(ctx('linkedin', fetch, member), content('text'), {})).rejects.toMatchObject({ kind: 'ambiguous' });
  });

  it('rejects organic carousel in validatePost', () => {
    expect(linkedin.validatePost(null, content('carousel', { media: [media(), media()] })).join(' ')).toMatch(/carousel/);
  });
});

describe('linkedin errors', () => {
  it('401 → reconnect_required', async () => {
    const { fetch } = fetchDouble([{ match: '/rest/posts', reply: () => json({ message: 'Invalid access token', serviceErrorCode: 65600, status: 401 }, 401) }]);
    await expect(linkedin.submitPost(ctx('linkedin', fetch, member), content('text'), {})).rejects.toMatchObject({ kind: 'reconnect_required' });
  });

  it('429 with Retry-After → rate_limited with seconds', async () => {
    const { fetch } = fetchDouble([{ match: '/rest/posts', reply: () => json({ message: 'Too many requests', status: 429 }, 429, { 'retry-after': '120' }) }]);
    await expect(linkedin.submitPost(ctx('linkedin', fetch, member), content('text'), {})).rejects.toMatchObject({ kind: 'rate_limited', retryAfterSeconds: 120 });
  });

  it('timeout or 5xx on the create call → ambiguous', async () => {
    const t = fetchDouble([{ match: '/rest/posts', reply: () => 'timeout' }]);
    await expect(linkedin.submitPost(ctx('linkedin', t.fetch, member), content('text'), {})).rejects.toMatchObject({ kind: 'ambiguous', code: 'timeout' });
    const s = fetchDouble([{ match: '/rest/posts', reply: () => json({ message: 'boom' }, 503) }]);
    await expect(linkedin.submitPost(ctx('linkedin', s.fetch, member), content('text'), {})).rejects.toMatchObject({ kind: 'ambiguous' });
  });
});

describe('linkedin metrics', () => {
  it('organization share statistics map only matching definitions', async () => {
    const { fetch, calls } = fetchDouble([
      { match: '/rest/organizationalEntityShareStatistics', reply: () => json({ elements: [{ share: 'urn:li:share:1', totalShareStatistics: { impressionCount: 50, clickCount: 3, likeCount: 2, commentCount: 1, shareCount: 0, engagement: 0.12, uniqueImpressionsCount: 40 } }] }) },
    ]);
    const rows = await linkedin.fetchMetrics(ctx('linkedin', fetch, org), { objectIds: ['urn:li:share:1', 'urn:li:share:2'], since: '2026-10-01', until: '2026-10-31' });
    expect(calls[0]!.url).toContain('shares=List(urn%3Ali%3Ashare%3A1,urn%3Ali%3Ashare%3A2)');
    expect(rows.find((r) => r.rawMetric === 'impressionCount')).toMatchObject({ metric: 'impressions', value: 50 });
    expect(rows.find((r) => r.rawMetric === 'engagement')!.metric).toBeNull();
    expect(rows.every((r) => r.providerObjectId === 'urn:li:share:1')).toBe(true); // missing ≠ zero
  });

  it('member metrics are a capability error', async () => {
    const { fetch } = fetchDouble([]);
    await expect(linkedin.fetchMetrics(ctx('linkedin', fetch, member), { objectIds: ['urn:li:share:1'], since: '2026-10-01', until: '2026-10-31' })).rejects.toMatchObject({ kind: 'capability' });
  });

  it('disconnect reports no revocation', async () => {
    expect(await linkedin.disconnect(ctx('linkedin', fetchDouble([]).fetch, member))).toEqual({ revoked: false });
  });
});

it('escapeLittle escapes reserved characters but keeps hashtags', () => {
  expect(escapeLittle('a_b (c) @d [e] #tag')).toBe('a\\_b \\(c\\) \\@d \\[e\\] #tag');
});
