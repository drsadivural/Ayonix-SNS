// TikTok adapter: Login Kit v2 (web), Content Posting API Direct Post.
// Verified against developers.tiktok.com on 2026-11-01 (see SOURCES.md).
//
// - privacy_level is always explicit (no default) and revalidated against a
//   fresh creator_info query at dispatch time.
// - Video uses FILE_UPLOAD (chunked PUT with Content-Range). Photos must use
//   PULL_FROM_URL, which requires the media domain/URL prefix to be verified
//   with TikTok for this app (otherwise TikTok returns url_ownership_unverified).
// - publish_id is persisted; a post is never marked published from init.
// - Ayonix never adds a watermark or alters the media.
import type { CapabilityRow } from '@ayonix/contracts';
import { providerConfigured } from '../lib/env.js';
import { iso } from './http.js';
import { asString, cap, chunkStream, emptyReceipt, isBool, isHttps, parseScopes, readJson, request, requireConfig, type Classifier } from './common.js';
import {
  ProviderError,
  type FetchLike,
  type MetricRow,
  type PollResult,
  type ProviderAdapter,
  type ProviderContext,
  type PublishContent,
  type TikTokCreatorInfo,
  type TokenSet,
} from './types.js';

const API = 'https://open.tiktokapis.com';
const P = 'tiktok';
const SCOPES = ['user.info.basic', 'video.publish', 'video.list'];
const PRIVACY = ['PUBLIC_TO_EVERYONE', 'MUTUAL_FOLLOW_FRIENDS', 'FOLLOWER_OF_CREATOR', 'SELF_ONLY'];
const MIN_CHUNK = 5 * 1024 * 1024;
const CHUNK = 10 * 1024 * 1024;
/** After this long without a public post id for a public post, accept completion without one. */
const MODERATION_WAIT_MS = 6 * 3600 * 1000;

function kindForCode(code: string, httpKind: ProviderError['kind'], creates: boolean): ProviderError['kind'] {
  switch (code) {
    case 'access_token_invalid':
      return 'reconnect_required';
    case 'scope_not_authorized':
    case 'unaudited_client_can_only_post_to_private_accounts':
    case 'url_ownership_unverified':
    case 'spam_risk_user_banned_from_posting':
      return 'capability';
    case 'rate_limit_exceeded':
    case 'reached_active_user_cap':
      return 'rate_limited';
    case 'spam_risk_too_many_posts':
    case 'spam_risk_too_many_pending_share':
    case 'privacy_level_option_mismatch':
    case 'invalid_param':
    case 'invalid_file_upload':
    case 'file_format_check_failed':
    case 'duration_check_failed':
    case 'frame_rate_check_failed':
    case 'picture_size_check_failed':
      return 'validation';
    case 'internal_error':
      return creates ? 'ambiguous' : 'transient';
    default:
      return httpKind;
  }
}

const classify: Classifier = (err, body, status, creates) => {
  const e = body && typeof body === 'object' ? (body as Record<string, unknown>).error : undefined;
  const code = typeof e === 'string' ? e : e && typeof e === 'object' ? asString((e as Record<string, unknown>).code) : null;
  if (!code) return err;
  const kind = kindForCode(code, err.kind, creates);
  const retry = kind === 'rate_limited' ? (err.retryAfterSeconds ?? (code === 'reached_active_user_cap' ? 3600 : 60)) : err.retryAfterSeconds;
  return new ProviderError(kind, code, err.message, retry, status);
};

/** TikTok can report failures with HTTP 200 and error.code !== 'ok'. */
function checkBody(body: { error?: { code?: string; message?: string } }, creates: boolean): void {
  const code = body.error?.code;
  if (code && code !== 'ok') {
    const kind = kindForCode(code, creates ? 'ambiguous' : 'validation', creates);
    throw new ProviderError(kind, code, (body.error?.message || 'TikTok rejected the request.').slice(0, 300), kind === 'rate_limited' ? (code === 'reached_active_user_cap' ? 3600 : 60) : null, 200);
  }
}

async function api<T extends { error?: { code?: string; message?: string } }>(fetchImpl: FetchLike, token: string, path: string, body: unknown, op: string, correlationId: string, creates = false): Promise<T> {
  const res = await request(
    fetchImpl,
    `${API}${path}`,
    { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=UTF-8' }, body: body === undefined ? null : JSON.stringify(body) },
    { provider: P, operation: op, correlationId, creates, classify },
  );
  const json = await readJson<T>(res);
  checkBody(json, creates);
  return json;
}

/** Fresh creator constraints (POST /v2/post/publish/creator_info/query/). */
export async function queryCreatorInfo(ctx: ProviderContext): Promise<TikTokCreatorInfo> {
  const r = await api<{ data?: Record<string, unknown>; error?: { code?: string; message?: string } }>(ctx.fetch, ctx.tokens.access, '/v2/post/publish/creator_info/query/', undefined, 'creator_info', ctx.correlationId);
  const d = r.data ?? {};
  const options = Array.isArray(d.privacy_level_options) ? d.privacy_level_options.filter((o): o is string => typeof o === 'string') : [];
  return {
    creator_nickname: asString(d.creator_nickname) ?? '',
    creator_username: asString(d.creator_username),
    creator_avatar_url: asString(d.creator_avatar_url),
    privacy_level_options: options,
    comment_disabled: d.comment_disabled === true,
    duet_disabled: d.duet_disabled === true,
    stitch_disabled: d.stitch_disabled === true,
    max_video_post_duration_sec: typeof d.max_video_post_duration_sec === 'number' ? d.max_video_post_duration_sec : null,
  };
}

async function tokenRequest(env: ProviderContext['env'], params: Record<string, string>, fetchImpl: FetchLike, correlationId: string): Promise<TokenSet> {
  const res = await request(
    fetchImpl,
    `${API}/v2/oauth/token/`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ ...params, client_key: requireConfig(env.TIKTOK_CLIENT_KEY, 'TIKTOK_CLIENT_KEY'), client_secret: requireConfig(env.TIKTOK_CLIENT_SECRET, 'TIKTOK_CLIENT_SECRET') }),
    },
    { provider: P, operation: 'oauth.token', correlationId, classify: (e, b, s) => (asString((b as Record<string, unknown> | null)?.error) === 'invalid_grant' ? new ProviderError('reconnect_required', 'invalid_grant', e.message, null, s) : classify(e, b, s, false)) },
  );
  const t = await readJson<{ access_token?: string; expires_in?: number; refresh_token?: string; refresh_expires_in?: number; scope?: string; open_id?: string; error?: string; error_description?: string }>(res);
  if (t.error) throw new ProviderError(t.error === 'invalid_grant' ? 'reconnect_required' : 'validation', t.error, (t.error_description ?? 'TikTok rejected the token request.').slice(0, 300));
  if (!t.access_token) throw new ProviderError('transient', 'invalid_token_response', 'TikTok did not return an access token.');
  return { accessToken: t.access_token, refreshToken: t.refresh_token ?? null, expiresAt: iso(t.expires_in), refreshExpiresAt: iso(t.refresh_expires_in), scopes: parseScopes(t.scope), subject: t.open_id ?? null };
}

function capabilities(scopes: string[], creator: TikTokCreatorInfo | null, banned: boolean): CapabilityRow[] {
  const pub = scopes.includes('video.publish');
  const detail = !pub
    ? 'video.publish was not granted.'
    : banned
      ? 'TikTok reports this creator is currently banned from posting.'
      : `Direct Post. Unaudited TikTok apps can only post privately (SELF_ONLY).${creator ? ` Allowed privacy: ${creator.privacy_level_options.join(', ') || 'none'}.` : ''}`;
  const status = pub && !banned ? 'available' : 'unavailable';
  return [
    cap('publish_video', status, detail),
    cap('publish_photo', status, pub && !banned ? `${detail} Photos are pulled from URL and need a TikTok-verified media domain.` : detail),
    cap('metrics', scopes.includes('video.list') ? 'available' : 'unavailable', scopes.includes('video.list') ? 'video.list granted (public post counts).' : 'video.list was not granted.'),
  ];
}

function postInfoProblems(content: PublishContent): string[] {
  const o = content.options;
  const problems: string[] = [];
  if (typeof o.privacy_level !== 'string' || !o.privacy_level) problems.push('Choose a TikTok privacy level explicitly; there is no default.');
  else if (!PRIVACY.includes(o.privacy_level)) problems.push('The TikTok privacy level is not recognised.');
  for (const k of ['disable_comment', 'disable_duet', 'disable_stitch', 'brand_content_toggle', 'brand_organic_toggle', 'is_aigc', 'auto_add_music']) {
    if (o[k] !== undefined && !isBool(o[k])) problems.push(`TikTok option ${k} must be true or false.`);
  }
  if (o.brand_content_toggle === true && o.privacy_level === 'SELF_ONLY') problems.push('Branded content cannot be posted with "Only me" privacy on TikTok.');
  return problems;
}

/** Throws creator_constraints_changed when approved settings no longer fit the creator's current constraints. */
function assertCreatorConstraints(content: PublishContent, info: TikTokCreatorInfo): void {
  const o = content.options;
  const changes: string[] = [];
  if (typeof o.privacy_level !== 'string' || !info.privacy_level_options.includes(o.privacy_level)) changes.push('privacy level is no longer offered');
  if (o.disable_comment === false && info.comment_disabled) changes.push('comments are now disabled');
  if (content.format === 'video') {
    if (o.disable_duet === false && info.duet_disabled) changes.push('duet is now disabled');
    if (o.disable_stitch === false && info.stitch_disabled) changes.push('stitch is now disabled');
    const d = content.media[0]?.durationMs;
    if (d != null && info.max_video_post_duration_sec != null && d / 1000 > info.max_video_post_duration_sec) changes.push('video is longer than the creator maximum');
  }
  if (changes.length) throw new ProviderError('validation', 'creator_constraints_changed', `TikTok creator settings changed since approval: ${changes.join('; ')}. Re-approve the post.`);
}

/** Chunk plan per TikTok media transfer guide: 5–64 MB chunks, final chunk absorbs the remainder (≤128 MB). */
export function chunkPlan(size: number): { chunkSize: number; count: number; sizes: number[] } {
  if (size < MIN_CHUNK) return { chunkSize: size, count: 1, sizes: [size] };
  const count = Math.max(1, Math.floor(size / CHUNK));
  const sizes = Array.from({ length: count }, (_, i) => (i === count - 1 ? size - CHUNK * (count - 1) : CHUNK));
  return { chunkSize: count === 1 ? size : CHUNK, count, sizes };
}

/** Extracts publicaly_available_post_id[0] from raw JSON so int64 ids keep full precision. */
function publicPostId(raw: string): string | null {
  const m = /"publicaly_available_post_id"\s*:\s*\[\s*"?(\d+)"?/.exec(raw);
  return m ? m[1]! : null;
}

export const tiktok: ProviderAdapter = {
  provider: 'tiktok',
  configured: (env) => providerConfigured(env, 'tiktok'),
  scopes: () => [...SCOPES],

  authorizeUrl(env, input) {
    // Login Kit for Web documents state but not PKCE (TikTok's PKCE is for
    // desktop/mobile and uses a hex SHA-256 challenge), so code_challenge is
    // not sent here. See SOURCES.md.
    const q = new URLSearchParams({
      client_key: requireConfig(env.TIKTOK_CLIENT_KEY, 'TIKTOK_CLIENT_KEY'),
      scope: SCOPES.join(','),
      response_type: 'code',
      redirect_uri: input.redirectUri,
      state: input.state,
    });
    return `https://www.tiktok.com/v2/auth/authorize/?${q.toString()}`;
  },

  exchangeCode: (env, code, _verifier, redirectUri, fetchImpl) => tokenRequest(env, { code, grant_type: 'authorization_code', redirect_uri: redirectUri }, fetchImpl, 'oauth'),

  async discoverAccounts(_env, tokens, fetchImpl) {
    const res = await request(fetchImpl, `${API}/v2/user/info/?fields=open_id,avatar_url,display_name`, { headers: { Authorization: `Bearer ${tokens.accessToken}` } }, { provider: P, operation: 'user.info', correlationId: 'discover', classify });
    const body = await readJson<{ data?: { user?: { open_id?: string; display_name?: string; avatar_url?: string } }; error?: { code?: string; message?: string } }>(res);
    checkBody(body, false);
    const u = body.data?.user;
    if (!u?.open_id) throw new ProviderError('transient', 'invalid_user_info', 'TikTok did not return the creator identity.');
    return [{ providerAccountId: u.open_id, name: u.display_name ?? u.open_id, type: 'creator', metadata: { avatar_url: u.avatar_url ?? null }, capabilities: capabilities(tokens.scopes, null, false) }];
  },

  async probeCapabilities(ctx) {
    if (!ctx.connection.granted_scopes.includes('video.publish')) return capabilities(ctx.connection.granted_scopes, null, false);
    try {
      return capabilities(ctx.connection.granted_scopes, await queryCreatorInfo(ctx), false);
    } catch (e) {
      if (e instanceof ProviderError && e.code === 'spam_risk_user_banned_from_posting') return capabilities(ctx.connection.granted_scopes, null, true);
      throw e;
    }
  },

  async refreshOrReconnect(ctx) {
    if (!ctx.tokens.refresh) return { kind: 'reconnect_required', reason: 'No TikTok refresh token is stored.' };
    try {
      return { kind: 'refreshed', tokens: await tokenRequest(ctx.env, { grant_type: 'refresh_token', refresh_token: ctx.tokens.refresh }, ctx.fetch, ctx.correlationId) };
    } catch (e) {
      if (e instanceof ProviderError && (e.kind === 'reconnect_required' || e.kind === 'validation')) return { kind: 'reconnect_required', reason: 'TikTok rejected the refresh token.' };
      throw e;
    }
  },

  validatePost(_ctx, content) {
    const problems = postInfoProblems(content);
    const n = content.media.length;
    if (content.format === 'video') {
      const v = content.media[0];
      if (n !== 1 || !v || !v.mime.startsWith('video/')) problems.push('A TikTok video post needs exactly one video.');
      else {
        if (!['video/mp4', 'video/webm', 'video/quicktime'].includes(v.mime)) problems.push('TikTok videos must be MP4, WebM or MOV.');
        if (v.bytes > 4 * 1024 * 1024 * 1024) problems.push('TikTok videos must be 4 GB or smaller.');
        if (v.width && v.height && (Math.min(v.width, v.height) < 360 || Math.max(v.width, v.height) > 4096)) problems.push('TikTok video dimensions must be between 360 and 4096 px.');
        const max = typeof content.options.max_video_post_duration_sec === 'number' ? content.options.max_video_post_duration_sec : null;
        if (v.durationMs !== null && v.durationMs < 3000) problems.push('TikTok videos must be at least 3 seconds long.');
        if (v.durationMs !== null && max !== null && v.durationMs / 1000 > max) problems.push(`This creator can post videos up to ${max} seconds.`);
      }
      if (content.caption.length > 2200) problems.push('TikTok video captions are limited to 2200 characters.');
    } else if (content.format === 'photo') {
      if (n < 1 || n > 35) problems.push('TikTok photo posts need 1–35 images.');
      for (const m of content.media) {
        if (!['image/jpeg', 'image/webp'].includes(m.mime)) problems.push('TikTok photos must be JPEG or WebP.');
        if (m.bytes > 20 * 1024 * 1024) problems.push('TikTok photos must be 20 MB or smaller.');
        if (!isHttps(m.publicUrl)) problems.push('TikTok photos must be served from a verified https URL.');
      }
      if ((content.title ?? '').length > 90) problems.push('TikTok photo titles are limited to 90 characters.');
      if (content.caption.length > 4000) problems.push('TikTok photo descriptions are limited to 4000 characters.');
      const idx = content.options.photo_cover_index;
      if (idx !== undefined && (typeof idx !== 'number' || !Number.isInteger(idx) || idx < 0 || idx >= n)) problems.push('TikTok photo cover index is out of range.');
    } else {
      problems.push(`TikTok does not support the ${content.format} format.`);
    }
    if (content.publishAt) problems.push('TikTok posts are scheduled by Ayonix, not natively.');
    return [...new Set(problems)];
  },

  async uploadMedia() {
    // The upload URL is issued by the post init call (which carries the
    // approved post settings), so transfer happens inside submitPost.
    return {};
  },

  async submitPost(ctx, content) {
    const pre = postInfoProblems(content);
    if (pre.length) throw new ProviderError('validation', 'invalid_post_settings', pre.join(' '));
    const info = await queryCreatorInfo(ctx);
    assertCreatorConstraints(content, info);
    const o = content.options;
    const privacy = o.privacy_level as string;
    const flag = (k: string) => (isBool(o[k]) ? { [k]: o[k] } : {});

    if (content.format === 'photo') {
      const r = await api<{ data?: { publish_id?: string }; error?: { code?: string; message?: string } }>(
        ctx.fetch,
        ctx.tokens.access,
        '/v2/post/publish/content/init/',
        {
          media_type: 'PHOTO',
          post_mode: 'DIRECT_POST',
          post_info: {
            ...(content.title ? { title: content.title } : {}),
            description: content.caption,
            privacy_level: privacy,
            ...flag('disable_comment'),
            ...flag('auto_add_music'),
            ...flag('brand_content_toggle'),
            ...flag('brand_organic_toggle'),
            ...flag('is_aigc'),
          },
          source_info: { source: 'PULL_FROM_URL', photo_cover_index: typeof o.photo_cover_index === 'number' ? o.photo_cover_index : 0, photo_images: content.media.map((m) => m.publicUrl) },
        },
        'content.init',
        ctx.correlationId,
        true,
      );
      const publishId = r.data?.publish_id;
      if (!publishId) throw new ProviderError('ambiguous', 'missing_publish_id', 'TikTok returned no publish_id. Reconcile before retrying.');
      return { kind: 'processing', pollAfterSeconds: 15, receipt: emptyReceipt({ publishId, state: { privacy_level: privacy, format: 'photo', submitted_at: new Date().toISOString() } }) };
    }

    if (content.format !== 'video') throw new ProviderError('validation', 'unsupported_format', `TikTok does not support the ${content.format} format.`);
    const media = content.media[0];
    if (!media) throw new ProviderError('validation', 'missing_media', 'A TikTok video post needs a video.');
    const plan = chunkPlan(media.bytes);
    const init = await api<{ data?: { publish_id?: string; upload_url?: string }; error?: { code?: string; message?: string } }>(
      ctx.fetch,
      ctx.tokens.access,
      '/v2/post/publish/video/init/',
      {
        post_info: {
          title: content.caption,
          privacy_level: privacy,
          ...flag('disable_duet'),
          ...flag('disable_comment'),
          ...flag('disable_stitch'),
          ...flag('brand_content_toggle'),
          ...flag('brand_organic_toggle'),
          ...flag('is_aigc'),
          ...(typeof o.video_cover_timestamp_ms === 'number' ? { video_cover_timestamp_ms: o.video_cover_timestamp_ms } : {}),
        },
        source_info: { source: 'FILE_UPLOAD', video_size: media.bytes, chunk_size: plan.chunkSize, total_chunk_count: plan.count },
      },
      'video.init',
      ctx.correlationId,
    );
    const publishId = init.data?.publish_id;
    const uploadUrl = init.data?.upload_url;
    if (!publishId || !uploadUrl) throw new ProviderError('transient', 'invalid_init_response', 'TikTok did not return an upload URL.');
    let offset = 0;
    let i = 0;
    for await (const chunk of chunkStream(await media.open(), plan.sizes)) {
      const last = i === plan.count - 1;
      await request(
        ctx.fetch,
        uploadUrl,
        { method: 'PUT', headers: { 'Content-Type': media.mime, 'Content-Range': `bytes ${offset}-${offset + chunk.byteLength - 1}/${media.bytes}` }, body: chunk },
        // The final chunk triggers posting: a failure there may still publish.
        { provider: P, operation: 'video.upload', correlationId: ctx.correlationId, creates: last, timeoutMs: 300_000, classify },
      );
      offset += chunk.byteLength;
      i++;
    }
    return { kind: 'processing', pollAfterSeconds: 30, receipt: emptyReceipt({ publishId, state: { privacy_level: privacy, format: 'video', submitted_at: new Date().toISOString() } }) };
  },

  /**
   * PUBLISH_COMPLETE with publicaly_available_post_id → published with that id.
   * PUBLISH_COMPLETE without it: TikTok withholds the id for non-public posts
   * (and while a public post is in moderation). Non-public posts are recorded
   * as published with remoteId = publish_id and url null. Public posts keep
   * polling for the id for up to 6 hours, then are recorded the same way.
   */
  async pollStatus(ctx, receipt): Promise<PollResult> {
    if (!receipt.publishId) return { kind: 'failed', code: 'missing_publish_id', message: 'No TikTok publish_id was recorded.', receipt };
    const res = await request(
      ctx.fetch,
      `${API}/v2/post/publish/status/fetch/`,
      { method: 'POST', headers: { Authorization: `Bearer ${ctx.tokens.access}`, 'Content-Type': 'application/json; charset=UTF-8' }, body: JSON.stringify({ publish_id: receipt.publishId }) },
      { provider: P, operation: 'status.fetch', correlationId: ctx.correlationId, classify },
    );
    const raw = await res.text();
    let body: { data?: { status?: string; fail_reason?: string }; error?: { code?: string; message?: string } };
    try {
      body = JSON.parse(raw) as typeof body;
    } catch {
      throw new ProviderError('transient', 'invalid_response', 'TikTok returned an unreadable status response.');
    }
    checkBody(body, false);
    const status = body.data?.status;
    if (status === 'FAILED') return { kind: 'failed', code: body.data?.fail_reason ?? 'failed', message: `TikTok could not publish the post (${body.data?.fail_reason ?? 'unknown reason'}).`, receipt };
    if (status !== 'PUBLISH_COMPLETE') return { kind: 'processing', pollAfterSeconds: 30, receipt: { ...receipt, state: { ...receipt.state, last_status: status ?? null } } };
    const postId = publicPostId(raw);
    if (postId) return { kind: 'published', receipt: { ...receipt, remoteId: postId, url: null, state: { ...receipt.state, last_status: status, public_post_id: postId } } };
    const isPublic = receipt.state.privacy_level === 'PUBLIC_TO_EVERYONE';
    const since = Date.parse(asString(receipt.state.submitted_at) ?? '');
    if (isPublic && Number.isFinite(since) && Date.now() - since < MODERATION_WAIT_MS) {
      return { kind: 'processing', pollAfterSeconds: 300, receipt: { ...receipt, state: { ...receipt.state, last_status: status, awaiting_public_id: true } } };
    }
    return { kind: 'published', receipt: { ...receipt, remoteId: receipt.publishId, url: null, state: { ...receipt.state, last_status: status, public_post_id: null, remote_id_is_publish_id: true } } };
  },

  async fetchMetrics(ctx, input): Promise<MetricRow[]> {
    if (!ctx.connection.granted_scopes.includes('video.list')) throw new ProviderError('capability', 'metrics_unavailable', 'video.list was not granted.');
    const ids = input.objectIds.filter((i) => /^\d+$/.test(i)); // publish_ids (non-public posts) have no metrics
    const map: Record<string, MetricRow['metric']> = { view_count: 'views', like_count: 'likes', comment_count: 'comments', share_count: 'shares' };
    const rows: MetricRow[] = [];
    const date = input.until.slice(0, 10);
    for (let i = 0; i < ids.length; i += 20) {
      const batch = ids.slice(i, i + 20);
      const res = await request(
        ctx.fetch,
        `${API}/v2/video/query/?fields=id,view_count,like_count,comment_count,share_count`,
        { method: 'POST', headers: { Authorization: `Bearer ${ctx.tokens.access}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ filters: { video_ids: batch } }) },
        { provider: P, operation: 'video.query', correlationId: ctx.correlationId, classify },
      );
      const raw = await res.text();
      let body: { data?: { videos?: Array<Record<string, unknown>> }; error?: { code?: string; message?: string } };
      try {
        body = JSON.parse(raw.replace(/"id"\s*:\s*(\d{16,})/g, '"id":"$1"')) as typeof body;
      } catch {
        throw new ProviderError('transient', 'invalid_response', 'TikTok returned an unreadable metrics response.');
      }
      checkBody(body, false);
      for (const v of body.data?.videos ?? []) {
        const id = asString(v.id);
        if (!id) continue;
        for (const [raw2, metric] of Object.entries(map)) {
          if (typeof v[raw2] === 'number') rows.push({ providerObjectId: id, rawMetric: raw2, metric, value: v[raw2] as number, date, aggregation: 'lifetime', estimated: false });
        }
      }
    }
    return rows;
  },

  async disconnect(ctx) {
    await request(
      ctx.fetch,
      `${API}/v2/oauth/revoke/`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_key: requireConfig(ctx.env.TIKTOK_CLIENT_KEY, 'TIKTOK_CLIENT_KEY'), client_secret: requireConfig(ctx.env.TIKTOK_CLIENT_SECRET, 'TIKTOK_CLIENT_SECRET'), token: ctx.tokens.access }),
      },
      { provider: P, operation: 'oauth.revoke', correlationId: ctx.correlationId, classify },
    );
    return { revoked: true };
  },
};
