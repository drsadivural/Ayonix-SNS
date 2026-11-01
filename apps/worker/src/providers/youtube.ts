// YouTube adapter: Google OAuth 2.0 (authorization code + PKCE S256),
// YouTube Data API v3 resumable upload, videos.list polling, YouTube
// Analytics reports.query. Verified against developers.google.com on
// 2026-11-01 (pages last updated 2026-10-15/2026-10-30). See SOURCES.md.
//
// Shorts are ordinary uploads; the API exposes no Shorts flag, so the
// canonical watch URL is always used. Community/text posts are not supported.
import type { CapabilityRow } from '@ayonix/contracts';
import { providerConfigured } from '../lib/env.js';
import { iso } from './http.js';
import { asString, cap, chunkStream, emptyReceipt, isBool, parseScopes, readJson, reclassify, request, requireConfig, utf8Len, type Classifier } from './common.js';
import { ProviderError, type FetchLike, type MetricRow, type PollResult, type ProviderAdapter, type ProviderContext, type PublishContent, type Receipt, type TokenSet } from './types.js';

const P = 'youtube';
const S = {
  upload: 'https://www.googleapis.com/auth/youtube.upload',
  readonly: 'https://www.googleapis.com/auth/youtube.readonly',
  analytics: 'https://www.googleapis.com/auth/yt-analytics.readonly',
  forceSsl: 'https://www.googleapis.com/auth/youtube.force-ssl',
  youtube: 'https://www.googleapis.com/auth/youtube',
  partner: 'https://www.googleapis.com/auth/youtubepartner',
};
/**
 * Minimal default scopes. Deleting videos (needed to cancel a native
 * schedule) requires youtube.force-ssl, which is broad and not requested by
 * default; native scheduling is therefore reported unavailable unless granted.
 */
const SCOPES = [S.upload, S.readonly, S.analytics];
const DELETE_SCOPES = [S.forceSsl, S.youtube, S.partner];
const PRIVACY = ['public', 'unlisted', 'private'];
/** Resumable chunks must be multiples of 256 KiB. */
const CHUNK = 32 * 256 * 1024; // 8 MiB

const quotaReasons = new Set(['quotaExceeded', 'rateLimitExceeded', 'userRateLimitExceeded', 'dailyLimitExceeded', 'uploadLimitExceeded']);
const capabilityReasons = new Set(['insufficientPermissions', 'forbidden', 'youtubeSignupRequired', 'accessNotConfigured', 'channelNotFound']);

const classify: Classifier = (err, body, status) => {
  const e = body && typeof body === 'object' ? (body as Record<string, unknown>).error : undefined;
  if (typeof e === 'string') {
    if (e === 'invalid_grant') return reclassify(err, 'reconnect_required', 'invalid_grant');
    return err;
  }
  const errors = e && typeof e === 'object' ? ((e as Record<string, unknown>).errors as Array<{ reason?: string }> | undefined) : undefined;
  const reason = errors?.[0]?.reason;
  if (!reason) return err;
  if (quotaReasons.has(reason)) return new ProviderError('rate_limited', reason, err.message, err.retryAfterSeconds ?? (reason === 'quotaExceeded' || reason === 'dailyLimitExceeded' || reason === 'uploadLimitExceeded' ? 3600 : 60), status);
  if (capabilityReasons.has(reason)) return reclassify(err, 'capability', reason);
  if (reason === 'authError') return reclassify(err, 'reconnect_required', reason);
  return reclassify(err, err.kind, reason);
};

const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

async function tokenRequest(env: ProviderContext['env'], params: Record<string, string>, fetchImpl: FetchLike, correlationId: string): Promise<TokenSet> {
  const res = await request(
    fetchImpl,
    'https://oauth2.googleapis.com/token',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ ...params, client_id: requireConfig(env.GOOGLE_CLIENT_ID, 'GOOGLE_CLIENT_ID'), client_secret: requireConfig(env.GOOGLE_CLIENT_SECRET, 'GOOGLE_CLIENT_SECRET') }),
    },
    { provider: P, operation: 'oauth.token', correlationId, classify },
  );
  const t = await readJson<{ access_token?: string; expires_in?: number; refresh_token?: string; refresh_token_expires_in?: number; scope?: string }>(res);
  if (!t.access_token) throw new ProviderError('transient', 'invalid_token_response', 'Google did not return an access token.');
  return { accessToken: t.access_token, refreshToken: t.refresh_token ?? null, expiresAt: iso(t.expires_in), refreshExpiresAt: iso(t.refresh_token_expires_in), scopes: parseScopes(t.scope), subject: null };
}

function capabilities(scopes: string[]): CapabilityRow[] {
  const upload = [S.upload, S.youtube, S.forceSsl, S.partner].some((s) => scopes.includes(s));
  const read = [S.readonly, S.youtube, S.forceSsl, S.partner].some((s) => scopes.includes(s));
  const del = DELETE_SCOPES.some((s) => scopes.includes(s));
  return [
    cap('publish_video', upload ? 'available' : 'unavailable', upload ? 'Resumable uploads via videos.insert.' : 'youtube.upload was not granted.'),
    cap('publish_short', upload ? 'available' : 'unavailable', upload ? 'Shorts are uploaded as regular videos; YouTube classifies them.' : 'youtube.upload was not granted.'),
    cap('status_polling', read ? 'available' : 'unavailable', read ? 'videos.list processing status.' : 'youtube.readonly was not granted; processing cannot be confirmed.'),
    cap('native_schedule', del && upload ? 'available' : 'unavailable', del ? 'publishAt scheduling with cancellation via videos.delete.' : 'Cancelling a native schedule needs youtube.force-ssl, which was not granted; Ayonix schedules instead.'),
    cap('publish_text', 'unavailable', 'YouTube community/text posts are not available through the Data API.'),
    cap('metrics', scopes.includes(S.analytics) && read ? 'available' : 'unavailable', scopes.includes(S.analytics) ? 'YouTube Analytics reports.' : 'yt-analytics.readonly was not granted.'),
  ];
}

const watchUrl = (id: string) => `https://www.youtube.com/watch?v=${encodeURIComponent(id)}`;

function videoResource(content: PublishContent) {
  const o = content.options;
  const status: Record<string, unknown> = {
    privacyStatus: content.publishAt ? 'private' : o.privacy_status,
    selfDeclaredMadeForKids: o.made_for_kids,
    containsSyntheticMedia: o.contains_synthetic_media,
  };
  if (content.publishAt) status.publishAt = new Date(content.publishAt).toISOString();
  return {
    snippet: { title: content.title ?? '', description: content.caption, categoryId: typeof o.category_id === 'string' && /^\d+$/.test(o.category_id) ? o.category_id : '22' },
    status,
  };
}

export const youtube: ProviderAdapter & { cancelNativeSchedule: typeof cancelNativeSchedule } = {
  provider: 'youtube',
  configured: (env) => providerConfigured(env, 'youtube'),
  scopes: () => [...SCOPES],

  authorizeUrl(env, input) {
    const q = new URLSearchParams({
      client_id: requireConfig(env.GOOGLE_CLIENT_ID, 'GOOGLE_CLIENT_ID'),
      redirect_uri: input.redirectUri,
      response_type: 'code',
      scope: SCOPES.join(' '),
      state: input.state,
      access_type: 'offline',
      include_granted_scopes: 'true',
      prompt: 'consent',
      code_challenge: input.codeChallenge,
      code_challenge_method: 'S256',
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${q.toString()}`;
  },

  exchangeCode: (env, code, codeVerifier, redirectUri, fetchImpl) => tokenRequest(env, { code, code_verifier: codeVerifier, grant_type: 'authorization_code', redirect_uri: redirectUri }, fetchImpl, 'oauth'),

  async discoverAccounts(_env, tokens, fetchImpl) {
    const res = await request(fetchImpl, 'https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true&maxResults=50', { headers: bearer(tokens.accessToken) }, { provider: P, operation: 'channels.list', correlationId: 'discover', classify });
    const items = (await readJson<{ items?: Array<{ id?: string; snippet?: { title?: string; customUrl?: string } }> }>(res)).items ?? [];
    const channels = items.filter((i) => i.id);
    if (!channels.length) throw new ProviderError('capability', 'no_channel', 'This Google account has no YouTube channel. Create a channel, then reconnect.');
    return channels.map((c) => ({ providerAccountId: c.id!, name: c.snippet?.title ?? c.id!, type: 'channel', metadata: { custom_url: c.snippet?.customUrl ?? null }, capabilities: capabilities(tokens.scopes) }));
  },

  async probeCapabilities(ctx) {
    return capabilities(ctx.connection.granted_scopes);
  },

  async refreshOrReconnect(ctx) {
    if (!ctx.tokens.refresh) return { kind: 'reconnect_required', reason: 'Google did not issue a refresh token for this connection.' };
    try {
      const t = await tokenRequest(ctx.env, { grant_type: 'refresh_token', refresh_token: ctx.tokens.refresh }, ctx.fetch, ctx.correlationId);
      // Google usually omits refresh_token on refresh; keep the stored one.
      return { kind: 'refreshed', tokens: { ...t, refreshToken: t.refreshToken ?? ctx.tokens.refresh, scopes: t.scopes.length ? t.scopes : ctx.connection.granted_scopes } };
    } catch (e) {
      if (e instanceof ProviderError && (e.kind === 'reconnect_required' || e.code === 'invalid_grant')) return { kind: 'reconnect_required', reason: 'Google rejected the refresh token (revoked or expired).' };
      throw e;
    }
  },

  validatePost(ctx, content) {
    const problems: string[] = [];
    const o = content.options;
    if (content.format !== 'video') problems.push(`YouTube does not support the ${content.format} format.`);
    const v = content.media[0];
    if (content.media.length !== 1 || !v || !(v.mime.startsWith('video/') || v.mime === 'application/octet-stream')) problems.push('A YouTube upload needs exactly one video.');
    const title = content.title?.trim() ?? '';
    if (!title) problems.push('YouTube needs a title.');
    else if (title.length > 100) problems.push('YouTube titles are limited to 100 characters.');
    if (/[<>]/.test(content.title ?? '')) problems.push('YouTube titles cannot contain < or >.');
    if (utf8Len(content.caption) > 5000) problems.push('YouTube descriptions are limited to 5000 bytes.');
    if (/[<>]/.test(content.caption)) problems.push('YouTube descriptions cannot contain < or >.');
    if (typeof o.privacy_status !== 'string' || !PRIVACY.includes(o.privacy_status)) problems.push('Choose YouTube visibility: public, unlisted or private.');
    if (!isBool(o.made_for_kids)) problems.push('Declare whether the video is made for kids (made_for_kids true/false).');
    if (!isBool(o.contains_synthetic_media)) problems.push('Declare whether the video contains realistic altered or synthetic media (contains_synthetic_media true/false).');
    if (o.category_id !== undefined && (typeof o.category_id !== 'string' || !/^\d+$/.test(o.category_id))) problems.push('YouTube category_id must be a numeric string.');
    if (content.publishAt) {
      const t = Date.parse(content.publishAt);
      if (!Number.isFinite(t) || t <= Date.now()) problems.push('YouTube publishAt must be a future time.');
      if (o.privacy_status !== 'private') problems.push('Native YouTube scheduling (publishAt) requires privacy_status "private"; the video becomes public at publishAt.');
      if (ctx && !DELETE_SCOPES.some((s) => ctx.connection.granted_scopes.includes(s))) problems.push('Native YouTube scheduling is unavailable: cancellation needs the youtube.force-ssl permission. Let Ayonix schedule this post instead.');
    }
    return [...new Set(problems)];
  },

  async uploadMedia() {
    // videos.insert creates the video, so the resumable session and byte
    // transfer run in submitPost. The session URI (a bearer-like upload
    // capability) is never persisted.
    return {};
  },

  async submitPost(ctx, content) {
    const problems = youtube.validatePost(ctx, content);
    if (problems.length) throw new ProviderError('validation', 'invalid_post', problems.join(' '));
    const media = content.media[0]!;
    const type = media.mime.startsWith('video/') ? media.mime : 'application/octet-stream';
    const start = await request(
      ctx.fetch,
      'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status',
      {
        method: 'POST',
        headers: { ...bearer(ctx.tokens.access), 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Length': String(media.bytes), 'X-Upload-Content-Type': type },
        body: JSON.stringify(videoResource(content)),
      },
      { provider: P, operation: 'videos.insert.start', correlationId: ctx.correlationId, classify },
    );
    const session = start.headers.get('location');
    if (!session) throw new ProviderError('transient', 'missing_upload_session', 'YouTube did not return an upload session.');
    const sizes: number[] = [];
    for (let off = 0; off < media.bytes; off += CHUNK) sizes.push(Math.min(CHUNK, media.bytes - off));
    let offset = 0;
    let video: { id?: string; status?: { uploadStatus?: string } } | null = null;
    let i = 0;
    for await (const chunk of chunkStream(await media.open(), sizes)) {
      const last = i === sizes.length - 1;
      const res = await request(
        ctx.fetch,
        session,
        { method: 'PUT', redirect: 'manual', headers: { ...bearer(ctx.tokens.access), 'Content-Type': type, 'Content-Range': `bytes ${offset}-${offset + chunk.byteLength - 1}/${media.bytes}` }, body: chunk },
        // The final chunk creates the video: failures there are ambiguous.
        { provider: P, operation: 'videos.insert.upload', correlationId: ctx.correlationId, creates: last, timeoutMs: 300_000, accept: last ? [] : [308], classify },
      );
      offset += chunk.byteLength;
      i++;
      if (last) video = await readJson<{ id?: string; status?: { uploadStatus?: string } }>(res);
      else if (res.status !== 308) throw new ProviderError('ambiguous', 'unexpected_upload_status', 'YouTube finished the upload early. Reconcile before retrying.');
    }
    const id = video?.id;
    if (!id) throw new ProviderError('ambiguous', 'missing_video_id', 'YouTube accepted the upload but returned no video ID. Reconcile before retrying.');
    return {
      kind: 'processing',
      pollAfterSeconds: 60,
      receipt: emptyReceipt({ remoteId: id, state: { privacy_status: content.publishAt ? 'private' : content.options.privacy_status, publish_at: content.publishAt ?? null, upload_status: video?.status?.uploadStatus ?? null } }),
    };
  },

  async pollStatus(ctx, receipt): Promise<PollResult> {
    const id = receipt.remoteId;
    if (!id) return { kind: 'failed', code: 'missing_video_id', message: 'No YouTube video ID was recorded.', receipt };
    const res = await request(ctx.fetch, `https://www.googleapis.com/youtube/v3/videos?part=status,processingDetails&id=${encodeURIComponent(id)}`, { headers: bearer(ctx.tokens.access) }, { provider: P, operation: 'videos.list', correlationId: ctx.correlationId, classify });
    const item = (await readJson<{ items?: Array<{ status?: { uploadStatus?: string; failureReason?: string; rejectionReason?: string; privacyStatus?: string; publishAt?: string }; processingDetails?: { processingStatus?: string; processingFailureReason?: string } }> }>(res)).items?.[0];
    if (!item) {
      const misses = (typeof receipt.state.not_found_polls === 'number' ? receipt.state.not_found_polls : 0) + 1;
      if (misses >= 5) return { kind: 'failed', code: 'video_not_found', message: 'YouTube no longer lists the uploaded video (deleted or removed).', receipt: { ...receipt, state: { ...receipt.state, not_found_polls: misses } } };
      return { kind: 'processing', pollAfterSeconds: 60, receipt: { ...receipt, state: { ...receipt.state, not_found_polls: misses } } };
    }
    const st = item.status ?? {};
    const state = { ...receipt.state, upload_status: st.uploadStatus ?? null, privacy_status: st.privacyStatus ?? receipt.state.privacy_status ?? null, publish_at: st.publishAt ?? receipt.state.publish_at ?? null };
    if (st.uploadStatus === 'failed') return { kind: 'failed', code: `upload_failed${st.failureReason ? `:${st.failureReason}` : ''}`, message: 'YouTube could not process the upload.', receipt: { ...receipt, state } };
    if (st.uploadStatus === 'rejected') return { kind: 'failed', code: `rejected${st.rejectionReason ? `:${st.rejectionReason}` : ''}`, message: 'YouTube rejected the video.', receipt: { ...receipt, state } };
    if (st.uploadStatus === 'deleted') return { kind: 'failed', code: 'deleted', message: 'The video was deleted on YouTube.', receipt: { ...receipt, state } };
    if (item.processingDetails?.processingStatus === 'failed') return { kind: 'failed', code: 'processing_failed', message: item.processingDetails.processingFailureReason ?? 'YouTube processing failed.', receipt: { ...receipt, state } };
    if (st.uploadStatus === 'processed') return { kind: 'published', receipt: { ...receipt, url: watchUrl(id), state } };
    return { kind: 'processing', pollAfterSeconds: 60, receipt: { ...receipt, state } };
  },

  async fetchMetrics(ctx, input): Promise<MetricRow[]> {
    if (!ctx.connection.granted_scopes.includes(S.analytics)) throw new ProviderError('capability', 'metrics_unavailable', 'yt-analytics.readonly was not granted.');
    const ids = input.objectIds.filter((i) => /^[\w-]{6,}$/.test(i));
    if (!ids.length) return [];
    const map: Record<string, MetricRow['metric']> = { views: 'views', likes: 'likes', comments: 'comments', shares: 'shares' };
    const rows: MetricRow[] = [];
    for (let i = 0; i < ids.length; i += 200) {
      const q = new URLSearchParams({ ids: 'channel==MINE', startDate: input.since.slice(0, 10), endDate: input.until.slice(0, 10), metrics: Object.keys(map).join(','), dimensions: 'video', filters: `video==${ids.slice(i, i + 200).join(',')}` });
      const res = await request(ctx.fetch, `https://youtubeanalytics.googleapis.com/v2/reports?${q.toString()}`, { headers: bearer(ctx.tokens.access) }, { provider: P, operation: 'analytics.reports', correlationId: ctx.correlationId, classify });
      const body = await readJson<{ columnHeaders?: Array<{ name?: string }>; rows?: unknown[][] }>(res);
      const cols = (body.columnHeaders ?? []).map((c) => c.name ?? '');
      const vi = cols.indexOf('video');
      for (const r of body.rows ?? []) {
        const vid = asString(r[vi]);
        if (!vid) continue;
        cols.forEach((name, ci) => {
          if (ci === vi || !(name in map) || typeof r[ci] !== 'number') return;
          rows.push({ providerObjectId: vid, rawMetric: name, metric: map[name] ?? null, value: r[ci] as number, date: input.until.slice(0, 10), aggregation: 'period', estimated: false });
        });
      }
    }
    return rows;
  },

  async disconnect(ctx) {
    const token = ctx.tokens.refresh ?? ctx.tokens.access;
    await request(ctx.fetch, 'https://oauth2.googleapis.com/revoke', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token }) }, { provider: P, operation: 'oauth.revoke', correlationId: ctx.correlationId, classify });
    return { revoked: true };
  },

  cancelNativeSchedule: (ctx, receipt) => cancelNativeSchedule(ctx, receipt),
};

/**
 * Deletes a natively scheduled video that is still private.
 * MUST only be called before publishAt: it re-reads the video and refuses
 * (validation error) when the video is no longer private or publishAt has
 * passed, so an already-public video is never deleted by a schedule change.
 * Requires youtube.force-ssl (or youtube/youtubepartner).
 */
export async function cancelNativeSchedule(ctx: ProviderContext, receipt: Receipt): Promise<{ deleted: true }> {
  if (!DELETE_SCOPES.some((s) => ctx.connection.granted_scopes.includes(s))) throw new ProviderError('capability', 'delete_scope_missing', 'Cancelling a native YouTube schedule needs the youtube.force-ssl permission.');
  const id = receipt.remoteId;
  if (!id) throw new ProviderError('validation', 'missing_video_id', 'No YouTube video ID was recorded.');
  const res = await request(ctx.fetch, `https://www.googleapis.com/youtube/v3/videos?part=status&id=${encodeURIComponent(id)}`, { headers: bearer(ctx.tokens.access) }, { provider: P, operation: 'videos.list', correlationId: ctx.correlationId, classify });
  const st = (await readJson<{ items?: Array<{ status?: { privacyStatus?: string; publishAt?: string } }> }>(res)).items?.[0]?.status;
  if (!st) throw new ProviderError('validation', 'video_not_found', 'The scheduled YouTube video was not found.');
  const at = st.publishAt ? Date.parse(st.publishAt) : NaN;
  if (st.privacyStatus !== 'private' || !Number.isFinite(at) || at <= Date.now()) {
    throw new ProviderError('validation', 'schedule_not_cancellable', 'The YouTube video is no longer a pending private scheduled upload; it was not deleted.');
  }
  await request(ctx.fetch, `https://www.googleapis.com/youtube/v3/videos?id=${encodeURIComponent(id)}`, { method: 'DELETE', headers: bearer(ctx.tokens.access) }, { provider: P, operation: 'videos.delete', correlationId: ctx.correlationId, classify });
  return { deleted: true };
}
