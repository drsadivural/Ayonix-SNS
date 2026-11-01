// LinkedIn adapter: OAuth 2.0 3-legged flow, OpenID userinfo, organizationAcls,
// Images API / Videos API uploads and the versioned Posts API.
// Verified against learn.microsoft.com on 2026-11-01 (li-lms-2026-10). See SOURCES.md.
// No DMs, invitations, outreach or scraping. Passwords/cookies are never used.
import type { Env } from '../lib/env.js';
import { providerConfigured } from '../lib/env.js';
import { iso } from './http.js';
import { asString, cap, chunkStream, emptyReceipt, isHttps, parseScopes, readJson, request, requireConfig, utf16Len, type Classifier } from './common.js';
import {
  ProviderError,
  type DiscoveredAccount,
  type FetchLike,
  type MetricRow,
  type PollResult,
  type ProviderAdapter,
  type ProviderContext,
  type PublishContent,
  type TokenSet,
} from './types.js';

const API = 'https://api.linkedin.com';
const AUTH = 'https://www.linkedin.com/oauth/v2';
const P = 'linkedin';

/**
 * Organization publishing needs the Community Management API product. Its
 * scopes are only requested when the operator enables them, because LinkedIn
 * rejects the whole authorization if a scope is not assigned to the app.
 * (Env field LINKEDIN_ENABLE_ORGANIZATIONS is optional; see SOURCES.md.)
 */
type LinkedInEnv = Env & { LINKEDIN_ENABLE_ORGANIZATIONS?: string };

const MEMBER_SCOPES = ['openid', 'profile', 'w_member_social'];
const ORG_SCOPES = ['w_organization_social', 'rw_organization_admin'];

const classify: Classifier = (err) => err; // HTTP status mapping in http.ts matches LinkedIn's documented codes.

function version(env: Env): string {
  const v = requireConfig(env.LINKEDIN_API_VERSION, 'LINKEDIN_API_VERSION');
  if (!/^\d{6}$/.test(v)) throw new ProviderError('capability', 'invalid_api_version', 'LINKEDIN_API_VERSION must use the YYYYMM format.');
  return v;
}

function restHeaders(env: Env, token: string, json = true): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    'Linkedin-Version': version(env),
    'X-Restli-Protocol-Version': '2.0.0',
    ...(json ? { 'Content-Type': 'application/json' } : {}),
  };
}

const enc = encodeURIComponent;

/**
 * Escapes reserved characters of LinkedIn's "little" text format so captions
 * render literally. '#' is left alone so hashtags keep working.
 */
export function escapeLittle(text: string): string {
  return text.replace(/[\\|{}@[\]()<>*_~]/g, (c) => `\\${c}`);
}

function author(ctx: ProviderContext): string {
  const urn = asString(ctx.connection.metadata.urn);
  if (!urn || !/^urn:li:(person|organization):/.test(urn)) throw new ProviderError('validation', 'missing_author', 'The LinkedIn connection has no author URN. Reconnect the account.');
  return urn;
}

function isOrg(ctx: ProviderContext): boolean {
  return ctx.connection.account_type === 'organization';
}

function publishCapabilities(scopes: string[], type: 'member' | 'organization'): ReturnType<typeof cap>[] {
  const scope = type === 'member' ? 'w_member_social' : 'w_organization_social';
  const ok = scopes.includes(scope);
  const detail = ok ? `Granted ${scope}.` : `${scope} was not granted.`;
  const rows = ['publish_text', 'publish_link', 'publish_image', 'publish_multi_image', 'publish_video'].map((c) => cap(c, ok ? 'available' : 'unavailable', detail));
  rows.push(cap('publish_carousel', 'unavailable', 'LinkedIn does not support organic carousel posts through the Posts API.'));
  if (type === 'organization') {
    const stats = scopes.includes('rw_organization_admin');
    rows.push(cap('metrics', stats ? 'available' : 'unavailable', stats ? 'Organization share statistics (rw_organization_admin).' : 'rw_organization_admin was not granted.'));
  } else {
    rows.push(cap('metrics', 'unavailable', 'Member post analytics need a restricted LinkedIn permission that is not requested.'));
  }
  return rows;
}

async function tokenRequest(env: Env, body: Record<string, string>, fetchImpl: FetchLike, correlationId: string): Promise<TokenSet> {
  const res = await request(
    fetchImpl,
    `${AUTH}/accessToken`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        ...body,
        client_id: requireConfig(env.LINKEDIN_CLIENT_ID, 'LINKEDIN_CLIENT_ID'),
        client_secret: requireConfig(env.LINKEDIN_CLIENT_SECRET, 'LINKEDIN_CLIENT_SECRET'),
      }),
    },
    { provider: P, operation: 'oauth.token', correlationId, classify: oauthClassify },
  );
  const t = await readJson<{ access_token?: string; expires_in?: number; refresh_token?: string; refresh_token_expires_in?: number; scope?: string }>(res);
  if (!t.access_token) throw new ProviderError('transient', 'invalid_token_response', 'LinkedIn did not return an access token.');
  return {
    accessToken: t.access_token,
    refreshToken: t.refresh_token ?? null,
    expiresAt: iso(t.expires_in),
    refreshExpiresAt: iso(t.refresh_token_expires_in),
    scopes: parseScopes(t.scope),
    subject: null,
  };
}

const oauthClassify: Classifier = (err, body) => {
  const code = body && typeof body === 'object' ? (body as Record<string, unknown>).error : undefined;
  if (code === 'invalid_grant' || code === 'invalid_request' || code === 'invalid_redirect_uri') return new ProviderError('reconnect_required', String(code), err.message, null, err.status);
  return err;
};

async function uploadImage(ctx: ProviderContext, owner: string, media: PublishContent['media'][number]): Promise<string> {
  const init = await request(
    ctx.fetch,
    `${API}/rest/images?action=initializeUpload`,
    { method: 'POST', headers: restHeaders(ctx.env, ctx.tokens.access), body: JSON.stringify({ initializeUploadRequest: { owner } }) },
    { provider: P, operation: 'images.initializeUpload', correlationId: ctx.correlationId, classify },
  );
  const v = (await readJson<{ value?: { uploadUrl?: string; image?: string } }>(init)).value;
  if (!v?.uploadUrl || !v.image) throw new ProviderError('transient', 'invalid_upload_response', 'LinkedIn did not return an image upload URL.');
  const body = await new Response(await media.open()).arrayBuffer();
  await request(
    ctx.fetch,
    v.uploadUrl,
    { method: 'PUT', headers: { Authorization: `Bearer ${ctx.tokens.access}`, 'Content-Type': 'application/octet-stream' }, body },
    { provider: P, operation: 'images.upload', correlationId: ctx.correlationId, timeoutMs: 120_000, classify },
  );
  return v.image;
}

async function uploadVideo(ctx: ProviderContext, owner: string, media: PublishContent['media'][number]): Promise<string> {
  const init = await request(
    ctx.fetch,
    `${API}/rest/videos?action=initializeUpload`,
    {
      method: 'POST',
      headers: restHeaders(ctx.env, ctx.tokens.access),
      body: JSON.stringify({ initializeUploadRequest: { owner, fileSizeBytes: media.bytes, uploadCaptions: false, uploadThumbnail: false } }),
    },
    { provider: P, operation: 'videos.initializeUpload', correlationId: ctx.correlationId, classify },
  );
  const v = (await readJson<{ value?: { video?: string; uploadToken?: string; uploadInstructions?: Array<{ uploadUrl: string; firstByte: number; lastByte: number }> } }>(init)).value;
  const parts = [...(v?.uploadInstructions ?? [])].sort((a, b) => a.firstByte - b.firstByte);
  if (!v?.video || !parts.length) throw new ProviderError('transient', 'invalid_upload_response', 'LinkedIn did not return video upload instructions.');
  const last = parts[parts.length - 1]!;
  if (parts[0]!.firstByte !== 0 || last.lastByte !== media.bytes - 1) throw new ProviderError('validation', 'media_size_mismatch', 'LinkedIn upload instructions do not match the video size.');
  const etags: string[] = [];
  let i = 0;
  for await (const chunk of chunkStream(await media.open(), parts.map((p) => p.lastByte - p.firstByte + 1))) {
    const part = parts[i++]!;
    const res = await request(
      ctx.fetch,
      part.uploadUrl,
      { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: chunk },
      { provider: P, operation: 'videos.uploadPart', correlationId: ctx.correlationId, timeoutMs: 300_000, classify },
    );
    const etag = res.headers.get('etag');
    if (!etag) throw new ProviderError('transient', 'missing_etag', 'LinkedIn did not acknowledge a video part.');
    etags.push(etag);
  }
  await request(
    ctx.fetch,
    `${API}/rest/videos?action=finalizeUpload`,
    {
      method: 'POST',
      headers: restHeaders(ctx.env, ctx.tokens.access),
      body: JSON.stringify({ finalizeUploadRequest: { video: v.video, uploadToken: v.uploadToken ?? '', uploadedPartIds: etags } }),
    },
    { provider: P, operation: 'videos.finalizeUpload', correlationId: ctx.correlationId, classify },
  );
  return v.video;
}

const postUrl = (urn: string) => `https://www.linkedin.com/feed/update/${urn}`;

export const linkedin: ProviderAdapter = {
  provider: 'linkedin',

  configured: (env) => providerConfigured(env, 'linkedin') && /^\d{6}$/.test(env.LINKEDIN_API_VERSION ?? ''),

  scopes(env) {
    return (env as LinkedInEnv).LINKEDIN_ENABLE_ORGANIZATIONS === 'true' ? [...MEMBER_SCOPES, ...ORG_SCOPES] : [...MEMBER_SCOPES];
  },

  authorizeUrl(env, input) {
    // LinkedIn's web authorization-code flow uses state + client secret;
    // PKCE is not part of this flow, so input.codeChallenge is not sent.
    const q = new URLSearchParams({
      response_type: 'code',
      client_id: requireConfig(env.LINKEDIN_CLIENT_ID, 'LINKEDIN_CLIENT_ID'),
      redirect_uri: input.redirectUri,
      state: input.state,
      scope: linkedin.scopes(env).join(' '),
    });
    return `${AUTH}/authorization?${q.toString()}`;
  },

  async exchangeCode(env, code, _codeVerifier, redirectUri, fetchImpl) {
    return tokenRequest(env, { grant_type: 'authorization_code', code, redirect_uri: redirectUri }, fetchImpl, 'oauth');
  },

  async discoverAccounts(env, tokens, fetchImpl) {
    const res = await request(fetchImpl, `${API}/v2/userinfo`, { headers: { Authorization: `Bearer ${tokens.accessToken}` } }, { provider: P, operation: 'userinfo', correlationId: 'discover', classify });
    const me = await readJson<{ sub?: string; name?: string }>(res);
    if (!me.sub) throw new ProviderError('transient', 'invalid_userinfo', 'LinkedIn did not return the member identifier.');
    const personUrn = `urn:li:person:${me.sub}`;
    const accounts: DiscoveredAccount[] = [
      { providerAccountId: personUrn, name: me.name ?? personUrn, type: 'member', metadata: { urn: personUrn }, capabilities: publishCapabilities(tokens.scopes, 'member') },
    ];
    if (tokens.scopes.includes('rw_organization_admin')) {
      const acl = await request(
        fetchImpl,
        `${API}/rest/organizationAcls?q=roleAssignee&role=ADMINISTRATOR&state=APPROVED&count=100`,
        { headers: restHeaders(env, tokens.accessToken, false) },
        { provider: P, operation: 'organizationAcls', correlationId: 'discover', classify },
      );
      const els = (await readJson<{ elements?: Array<{ organization?: string; organizationTarget?: string; role?: string; state?: string }> }>(acl)).elements ?? [];
      const orgs = [...new Set(els.filter((e) => e.role === 'ADMINISTRATOR' && e.state === 'APPROVED').map((e) => e.organization ?? e.organizationTarget).filter((u): u is string => !!u && u.startsWith('urn:li:organization:')))];
      for (const urn of orgs) {
        const id = urn.slice('urn:li:organization:'.length);
        const o = await request(fetchImpl, `${API}/rest/organizations/${enc(id)}`, { headers: restHeaders(env, tokens.accessToken, false) }, { provider: P, operation: 'organizations.get', correlationId: 'discover', classify });
        const org = await readJson<{ localizedName?: string }>(o);
        accounts.push({ providerAccountId: urn, name: org.localizedName ?? urn, type: 'organization', metadata: { urn, role: 'ADMINISTRATOR' }, capabilities: publishCapabilities(tokens.scopes, 'organization') });
      }
    }
    return accounts;
  },

  async probeCapabilities(ctx) {
    return publishCapabilities(ctx.connection.granted_scopes, isOrg(ctx) ? 'organization' : 'member');
  },

  async refreshOrReconnect(ctx) {
    // Programmatic refresh tokens are only issued to approved partners.
    if (!ctx.tokens.refresh) return { kind: 'reconnect_required', reason: 'LinkedIn did not issue a refresh token; the member must reconnect before the access token expires.' };
    try {
      const tokens = await tokenRequest(ctx.env, { grant_type: 'refresh_token', refresh_token: ctx.tokens.refresh }, ctx.fetch, ctx.correlationId);
      return { kind: 'refreshed', tokens };
    } catch (e) {
      if (e instanceof ProviderError && (e.kind === 'reconnect_required' || e.kind === 'validation')) return { kind: 'reconnect_required', reason: 'LinkedIn rejected the refresh token.' };
      throw e;
    }
  },

  validatePost(ctx, content) {
    const problems: string[] = [];
    const n = content.media.length;
    const images = content.media.filter((m) => m.mime.startsWith('image/'));
    const videos = content.media.filter((m) => m.mime.startsWith('video/'));
    switch (content.format) {
      case 'text':
        if (!content.caption.trim()) problems.push('A LinkedIn text post needs text.');
        if (n) problems.push('A LinkedIn text post cannot carry media.');
        break;
      case 'link':
        if (!content.linkUrl || !isHttps(content.linkUrl)) problems.push('A LinkedIn link post needs an https link URL.');
        if (n) problems.push('A LinkedIn link post cannot carry media (thumbnails are not uploaded).');
        break;
      case 'image':
        if (n < 1 || n > 20 || images.length !== n) problems.push('LinkedIn image posts need 1–20 images.');
        for (const m of images) if (!['image/jpeg', 'image/png', 'image/gif'].includes(m.mime)) problems.push('LinkedIn images must be JPG, PNG or GIF.');
        for (const m of images) if (m.width && m.height && m.width * m.height >= 36_152_320) problems.push('LinkedIn images must be under 36,152,320 pixels.');
        break;
      case 'video': {
        const v = videos[0];
        if (n !== 1 || !v) problems.push('A LinkedIn video post needs exactly one video.');
        else {
          if (v.mime !== 'video/mp4') problems.push('LinkedIn videos must be MP4.');
          if (v.bytes < 75 * 1024 || v.bytes > 500 * 1024 * 1024) problems.push('LinkedIn videos must be between 75 KB and 500 MB.');
          if (v.durationMs !== null && (v.durationMs < 3000 || v.durationMs > 30 * 60_000)) problems.push('LinkedIn videos must be 3 seconds to 30 minutes long.');
        }
        break;
      }
      case 'carousel':
        problems.push('LinkedIn does not support organic carousel posts.');
        break;
      default:
        problems.push(`LinkedIn does not support the ${content.format} format.`);
    }
    if (utf16Len(content.caption) > 3000) problems.push('LinkedIn post text is limited to 3000 characters.');
    if (content.publishAt) problems.push('LinkedIn posts are scheduled by Ayonix, not natively.');
    if (ctx && !publishCapabilities(ctx.connection.granted_scopes, isOrg(ctx) ? 'organization' : 'member').some((r) => r.capability === 'publish_text' && r.status === 'available')) {
      problems.push('This LinkedIn connection lacks publishing permission. Reconnect and grant posting access.');
    }
    return [...new Set(problems)];
  },

  async uploadMedia(ctx, content) {
    const owner = author(ctx);
    if (content.format === 'image') {
      const images: string[] = [];
      for (const m of content.media) images.push(await uploadImage(ctx, owner, m));
      return { images };
    }
    if (content.format === 'video') {
      const m = content.media[0];
      if (!m) throw new ProviderError('validation', 'missing_media', 'A LinkedIn video post needs a video.');
      return { video: await uploadVideo(ctx, owner, m) };
    }
    return {};
  },

  async submitPost(ctx, content, uploaded) {
    const body: Record<string, unknown> = {
      author: author(ctx),
      commentary: escapeLittle(content.caption),
      visibility: 'PUBLIC',
      distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] },
      lifecycleState: 'PUBLISHED',
      isReshareDisabledByAuthor: false,
    };
    const images = Array.isArray(uploaded.images) ? (uploaded.images as string[]) : [];
    const video = asString(uploaded.video);
    if (content.format === 'link') {
      if (!content.linkUrl) throw new ProviderError('validation', 'missing_link', 'A link post needs a link URL.');
      body.content = { article: { source: content.linkUrl, title: content.title?.trim() || new URL(content.linkUrl).hostname } };
    } else if (content.format === 'image') {
      if (!images.length) throw new ProviderError('validation', 'missing_media', 'Images were not uploaded.');
      body.content = images.length === 1 ? { media: { id: images[0] } } : { multiImage: { images: images.map((id) => ({ id })) } };
    } else if (content.format === 'video') {
      if (!video) throw new ProviderError('validation', 'missing_media', 'The video was not uploaded.');
      body.content = { media: { id: video, ...(content.title ? { title: content.title } : {}) } };
    } else if (content.format !== 'text') {
      throw new ProviderError('validation', 'unsupported_format', `LinkedIn does not support the ${content.format} format.`);
    }
    const res = await request(
      ctx.fetch,
      `${API}/rest/posts`,
      { method: 'POST', headers: restHeaders(ctx.env, ctx.tokens.access), body: JSON.stringify(body) },
      { provider: P, operation: 'posts.create', correlationId: ctx.correlationId, creates: true, classify },
    );
    const urn = res.headers.get('x-restli-id');
    if (!urn) throw new ProviderError('ambiguous', 'missing_post_id', 'LinkedIn accepted the post but returned no post ID. Reconcile before retrying.');
    if (video) {
      return { kind: 'processing', pollAfterSeconds: 30, receipt: emptyReceipt({ remoteId: urn, state: { video } }) };
    }
    return { kind: 'published', receipt: emptyReceipt({ remoteId: urn, url: postUrl(urn) }) };
  },

  async pollStatus(ctx, receipt): Promise<PollResult> {
    const urn = receipt.remoteId;
    if (!urn) return { kind: 'failed', code: 'missing_post_id', message: 'No LinkedIn post ID was recorded.', receipt };
    const video = asString(receipt.state.video);
    if (!video) return { kind: 'published', receipt: { ...receipt, url: postUrl(urn) } };
    try {
      const res = await request(ctx.fetch, `${API}/rest/videos/${enc(video)}`, { headers: restHeaders(ctx.env, ctx.tokens.access, false) }, { provider: P, operation: 'videos.get', correlationId: ctx.correlationId, classify });
      const v = await readJson<{ status?: string; processingFailureReason?: string }>(res);
      if (v.status === 'AVAILABLE') return { kind: 'published', receipt: { ...receipt, url: postUrl(urn), state: { ...receipt.state, video_status: 'AVAILABLE' } } };
      if (v.status === 'PROCESSING_FAILED') return { kind: 'failed', code: 'video_processing_failed', message: v.processingFailureReason ?? 'LinkedIn could not process the video.', receipt };
      return { kind: 'processing', pollAfterSeconds: 30, receipt };
    } catch (e) {
      // Tokens holding only w_member_social are write-only for /rest/videos.
      // The post URN was returned by LinkedIn (201), so record it as published
      // and flag that video processing could not be verified via the API.
      if (e instanceof ProviderError && e.kind === 'capability') {
        return { kind: 'published', receipt: { ...receipt, url: postUrl(urn), state: { ...receipt.state, video_status: 'unverifiable_with_granted_scopes' } } };
      }
      throw e;
    }
  },

  async fetchMetrics(ctx, input): Promise<MetricRow[]> {
    if (!isOrg(ctx)) throw new ProviderError('capability', 'metrics_unavailable', 'LinkedIn member post analytics require a restricted permission that this app does not request.');
    if (!ctx.connection.granted_scopes.includes('rw_organization_admin')) throw new ProviderError('capability', 'metrics_unavailable', 'rw_organization_admin was not granted for this organization.');
    const shares = input.objectIds.filter((i) => i.startsWith('urn:li:share:'));
    const ugc = input.objectIds.filter((i) => i.startsWith('urn:li:ugcPost:'));
    if (!shares.length && !ugc.length) return [];
    const params = [`q=organizationalEntity`, `organizationalEntity=${enc(author(ctx))}`];
    if (shares.length) params.push(`shares=List(${shares.map(enc).join(',')})`);
    if (ugc.length) params.push(`ugcPosts=List(${ugc.map(enc).join(',')})`);
    const res = await request(ctx.fetch, `${API}/rest/organizationalEntityShareStatistics?${params.join('&')}`, { headers: restHeaders(ctx.env, ctx.tokens.access, false) }, { provider: P, operation: 'shareStatistics', correlationId: ctx.correlationId, classify });
    const els = (await readJson<{ elements?: Array<{ share?: string; ugcPost?: string; totalShareStatistics?: Record<string, number> }> }>(res)).elements ?? [];
    const map: Record<string, MetricRow['metric']> = { impressionCount: 'impressions', clickCount: 'clicks', likeCount: 'likes', commentCount: 'comments', shareCount: 'shares', uniqueImpressionsCount: null, engagement: null };
    const date = input.until.slice(0, 10);
    const rows: MetricRow[] = [];
    // Posts absent from `elements` get no rows: missing is not recorded as zero.
    for (const el of els) {
      const id = el.share ?? el.ugcPost;
      if (!id || !el.totalShareStatistics) continue;
      for (const [raw, value] of Object.entries(el.totalShareStatistics)) {
        if (!(raw in map) || typeof value !== 'number') continue;
        rows.push({ providerObjectId: id, rawMetric: raw, metric: map[raw] ?? null, value, date, aggregation: 'lifetime', estimated: false });
      }
    }
    return rows;
  },

  async disconnect() {
    // No general-purpose revoke endpoint is used for LinkedIn; local tokens are destroyed by the caller.
    return { revoked: false };
  },
};

