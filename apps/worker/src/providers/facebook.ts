// Facebook Pages adapter (Facebook Login + Pages API). Publishes only to
// Pages the user can create content on; personal profiles are never targets.
// Verified against developers.facebook.com on 2026-11-01 (see SOURCES.md).
import { providerConfigured } from '../lib/env.js';
import { asString, cap, emptyReceipt, isHttps, request, utf16Len } from './common.js';
import {
  GRAPH_VIDEO,
  RUPLOAD,
  facebookAuthorizeUrl,
  graph,
  graphMajor,
  graphVersion,
  metaClassify,
  metaDisconnect,
  metaExchangeCode,
  metaRefreshOrReconnect,
  pageAccessToken,
  type GraphCall,
} from './meta.js';
import type { CapabilityRow } from '@ayonix/contracts';
import { ProviderError, type DiscoveredAccount, type MetricRow, type PollResult, type ProviderAdapter, type ProviderContext } from './types.js';

const P = 'facebook';
const SCOPES = ['pages_show_list', 'pages_read_engagement', 'pages_manage_posts', 'read_insights'];
const PUBLISH = ['publish_text', 'publish_link', 'publish_image', 'publish_video', 'publish_reel'];

function capabilities(scopes: string[], tasks: string[]): CapabilityRow[] {
  const missing = ['pages_show_list', 'pages_read_engagement', 'pages_manage_posts'].filter((s) => !scopes.includes(s));
  const canCreate = tasks.includes('CREATE_CONTENT') || tasks.includes('MANAGE');
  const detail = missing.length ? `Missing permission(s): ${missing.join(', ')}.` : canCreate ? 'Page token with CREATE_CONTENT task.' : 'Your role on this Page does not allow creating content.';
  const status = !missing.length && canCreate ? 'available' : 'unavailable';
  const rows = PUBLISH.map((c) => cap(c, status, detail));
  const analyze = tasks.includes('ANALYZE') || tasks.includes('MANAGE');
  rows.push(cap('metrics', scopes.includes('read_insights') && analyze ? 'available' : 'unavailable', scopes.includes('read_insights') ? (analyze ? 'read_insights granted.' : 'Your Page role lacks the ANALYZE task.') : 'read_insights was not granted.'));
  rows.push(cap('publish_personal_profile', 'unavailable', 'Publishing to personal Facebook profiles is not supported.'));
  return rows;
}

const pageCall = (ctx: ProviderContext): GraphCall => ({ env: ctx.env, fetch: ctx.fetch, token: pageAccessToken(ctx.tokens), correlationId: ctx.correlationId, provider: P });

function pageId(ctx: ProviderContext): string {
  if (ctx.connection.account_type !== 'page') throw new ProviderError('validation', 'not_a_page', 'Facebook publishing is limited to Pages; personal profiles are not supported.');
  return ctx.connection.provider_account_id;
}

/** Best-effort permalink read after a confirmed create. Never throws. */
async function permalink(ctx: ProviderContext, id: string): Promise<string | null> {
  try {
    const r = await graph<{ permalink_url?: string }>(pageCall(ctx), 'GET', id, { fields: 'permalink_url' }, { operation: 'permalink' });
    if (!r.permalink_url) return null;
    return r.permalink_url.startsWith('http') ? r.permalink_url : `https://www.facebook.com${r.permalink_url}`;
  } catch {
    return null;
  }
}

export const facebook: ProviderAdapter = {
  provider: 'facebook',
  configured: (env) => providerConfigured(env, 'facebook'),
  scopes: () => [...SCOPES],
  authorizeUrl: (env, input) => facebookAuthorizeUrl(env, input, SCOPES, env.META_FACEBOOK_CONFIG_ID),
  exchangeCode: (env, code, _verifier, redirectUri, fetchImpl) => metaExchangeCode(env, code, redirectUri, fetchImpl, P),

  async discoverAccounts(env, tokens, fetchImpl) {
    const c: GraphCall = { env, fetch: fetchImpl, token: tokens.accessToken, correlationId: 'discover', provider: P };
    const r = await graph<{ data?: Array<{ id?: string; name?: string; access_token?: string; tasks?: string[]; category?: string }> }>(c, 'GET', 'me/accounts', { fields: 'id,name,access_token,tasks,category', limit: '100' }, { operation: 'me.accounts' });
    const pages = (r.data ?? []).filter((p) => p.id && p.access_token);
    if (!pages.length) throw new ProviderError('capability', 'no_pages', 'No Facebook Pages were shared with Ayonix. Personal profiles cannot be published to; select at least one Page you manage.');
    return pages.map(
      (p): DiscoveredAccount => ({
        providerAccountId: p.id!,
        name: p.name ?? p.id!,
        type: 'page',
        metadata: { tasks: p.tasks ?? [], category: p.category ?? null },
        accountAccessToken: p.access_token!,
        capabilities: capabilities(tokens.scopes, p.tasks ?? []),
      }),
    );
  },

  async probeCapabilities(ctx) {
    const tasks = Array.isArray(ctx.connection.metadata.tasks) ? (ctx.connection.metadata.tasks as string[]) : [];
    return capabilities(ctx.connection.granted_scopes, tasks);
  },

  refreshOrReconnect: (ctx) => metaRefreshOrReconnect(ctx, P),

  validatePost(ctx, content) {
    const problems: string[] = [];
    const n = content.media.length;
    const imgs = content.media.filter((m) => m.mime.startsWith('image/'));
    const vids = content.media.filter((m) => m.mime.startsWith('video/'));
    if (ctx && ctx.connection.account_type !== 'page') problems.push('Facebook publishing is limited to Pages; personal profiles are not supported.');
    switch (content.format) {
      case 'text':
        if (!content.caption.trim()) problems.push('A Facebook text post needs text.');
        if (n) problems.push('A Facebook text post cannot carry media.');
        break;
      case 'link':
        if (!content.linkUrl || !isHttps(content.linkUrl)) problems.push('A Facebook link post needs an https link URL.');
        if (n) problems.push('A Facebook link post cannot carry media.');
        break;
      case 'image':
        if (n < 1 || imgs.length !== n) problems.push('A Facebook image post needs at least one image and only images.');
        if (n > 20) problems.push('Ayonix limits Facebook multi-photo posts to 20 images.');
        break;
      case 'video':
        if (n !== 1 || vids.length !== 1) problems.push('A Facebook video post needs exactly one video.');
        break;
      case 'reel': {
        const v = vids[0];
        if (n !== 1 || !v) problems.push('A Facebook Reel needs exactly one video.');
        else {
          if (v.durationMs !== null && (v.durationMs < 3000 || v.durationMs > 90_000)) problems.push('Facebook Reels must be 3 to 90 seconds long.');
          if (v.width && v.height && Math.abs(v.width / v.height - 9 / 16) > 0.02) problems.push('Facebook Reels must be 9:16 vertical video.');
          if (v.width && v.height && (v.width < 540 || v.height < 960)) problems.push('Facebook Reels must be at least 540x960.');
        }
        break;
      }
      default:
        problems.push(`Facebook Pages do not support the ${content.format} format.`);
    }
    for (const m of content.media) if (!isHttps(m.publicUrl)) problems.push('Media must be served from an https URL Meta can fetch.');
    if (utf16Len(content.caption) > 63_206) problems.push('Facebook post text is limited to 63,206 characters.');
    if (content.publishAt) problems.push('Facebook posts are scheduled by Ayonix, not natively.');
    return [...new Set(problems)];
  },

  async uploadMedia(ctx, content) {
    const page = pageId(ctx);
    const c = pageCall(ctx);
    if (content.format === 'image' && content.media.length > 1) {
      // Unpublished photos (not visible) that are attached to one feed post.
      const photoIds: string[] = [];
      for (const m of content.media) {
        const r = await graph<{ id?: string }>(c, 'POST', `${page}/photos`, { url: m.publicUrl, published: 'false' }, { operation: 'photos.unpublished' });
        if (!r.id) throw new ProviderError('transient', 'invalid_upload_response', 'Facebook did not return a photo ID.');
        photoIds.push(r.id);
      }
      return { photoIds };
    }
    if (content.format === 'reel') {
      const m = content.media[0];
      if (!m) throw new ProviderError('validation', 'missing_media', 'A Reel needs a video.');
      const start = await graph<{ video_id?: string }>(c, 'POST', `${page}/video_reels`, { upload_phase: 'start' }, { operation: 'reels.start' });
      if (!start.video_id) throw new ProviderError('transient', 'invalid_upload_response', 'Facebook did not return a Reel video ID.');
      // Hosted-file transfer: Meta pulls media.publicUrl (the file_url header).
      const res = await request(
        ctx.fetch,
        `${RUPLOAD}/${graphVersion(ctx.env)}/${start.video_id}`,
        { method: 'POST', headers: { Authorization: `OAuth ${c.token}`, file_url: m.publicUrl } },
        { provider: P, operation: 'reels.transfer', correlationId: ctx.correlationId, timeoutMs: 300_000, classify: metaClassify },
      );
      const t = (await res.json().catch(() => ({}))) as { success?: boolean };
      if (t.success !== true) throw new ProviderError('transient', 'reel_transfer_failed', 'Facebook did not confirm the Reel transfer.');
      return { videoId: start.video_id };
    }
    return {};
  },

  async submitPost(ctx, content, uploaded) {
    const page = pageId(ctx);
    const c = pageCall(ctx);
    const create = { operation: 'post.create', creates: true } as const;
    switch (content.format) {
      case 'text':
      case 'link': {
        const params: Record<string, string> = { message: content.caption };
        if (content.format === 'link') {
          if (!content.linkUrl) throw new ProviderError('validation', 'missing_link', 'A link post needs a link URL.');
          params.link = content.linkUrl;
        }
        const r = await graph<{ id?: string }>(c, 'POST', `${page}/feed`, params, create);
        if (!r.id) throw new ProviderError('ambiguous', 'missing_post_id', 'Facebook returned no post ID. Reconcile before retrying.');
        return { kind: 'published', receipt: emptyReceipt({ remoteId: r.id, url: await permalink(ctx, r.id) }) };
      }
      case 'image': {
        const photoIds = Array.isArray(uploaded.photoIds) ? (uploaded.photoIds as string[]) : [];
        if (photoIds.length > 1) {
          const params: Record<string, string> = { message: content.caption };
          photoIds.forEach((id, i) => (params[`attached_media[${i}]`] = JSON.stringify({ media_fbid: id })));
          const r = await graph<{ id?: string }>(c, 'POST', `${page}/feed`, params, create);
          if (!r.id) throw new ProviderError('ambiguous', 'missing_post_id', 'Facebook returned no post ID. Reconcile before retrying.');
          return { kind: 'published', receipt: emptyReceipt({ remoteId: r.id, url: await permalink(ctx, r.id), state: { photo_ids: photoIds } }) };
        }
        const m = content.media[0];
        if (!m) throw new ProviderError('validation', 'missing_media', 'An image post needs an image.');
        const r = await graph<{ id?: string; post_id?: string }>(c, 'POST', `${page}/photos`, { url: m.publicUrl, caption: content.caption }, create);
        const id = r.post_id ?? r.id;
        if (!id) throw new ProviderError('ambiguous', 'missing_post_id', 'Facebook returned no photo ID. Reconcile before retrying.');
        return { kind: 'published', receipt: emptyReceipt({ remoteId: id, url: await permalink(ctx, id), state: { photo_id: r.id ?? null } }) };
      }
      case 'video': {
        const m = content.media[0];
        if (!m) throw new ProviderError('validation', 'missing_media', 'A video post needs a video.');
        const params: Record<string, string> = { file_url: m.publicUrl, description: content.caption };
        if (content.title) params.title = content.title;
        const r = await graph<{ id?: string }>(c, 'POST', `${page}/videos`, params, { ...create, host: GRAPH_VIDEO, timeoutMs: 120_000 });
        if (!r.id) throw new ProviderError('ambiguous', 'missing_video_id', 'Facebook returned no video ID. Reconcile before retrying.');
        return { kind: 'processing', pollAfterSeconds: 30, receipt: emptyReceipt({ remoteId: r.id, state: { kind: 'video' } }) };
      }
      case 'reel': {
        const videoId = asString(uploaded.videoId);
        if (!videoId) throw new ProviderError('validation', 'missing_media', 'The Reel was not uploaded.');
        const r = await graph<{ success?: boolean }>(c, 'POST', `${page}/video_reels`, { upload_phase: 'finish', video_id: videoId, video_state: 'PUBLISHED', description: content.caption }, create);
        if (r.success !== true) throw new ProviderError('ambiguous', 'reel_finish_unconfirmed', 'Facebook did not confirm the Reel publish request. Reconcile before retrying.');
        return { kind: 'processing', pollAfterSeconds: 30, receipt: emptyReceipt({ remoteId: videoId, state: { kind: 'reel' } }) };
      }
      default:
        throw new ProviderError('validation', 'unsupported_format', `Facebook Pages do not support the ${content.format} format.`);
    }
  },

  async pollStatus(ctx, receipt): Promise<PollResult> {
    if (!receipt.remoteId) return { kind: 'failed', code: 'missing_remote_id', message: 'No Facebook object ID was recorded.', receipt };
    const kind = receipt.state.kind;
    if (kind !== 'video' && kind !== 'reel') return { kind: 'published', receipt };
    const r = await graph<{ status?: { video_status?: string; processing_phase?: { status?: string; error?: { message?: string } }; publishing_phase?: { status?: string } }; permalink_url?: string }>(
      pageCall(ctx),
      'GET',
      receipt.remoteId,
      { fields: 'status,permalink_url' },
      { operation: 'video.status' },
    );
    const s = r.status ?? {};
    const vs = s.video_status;
    if (vs === 'error' || vs === 'upload_failed' || vs === 'expired' || s.publishing_phase?.status === 'error' || s.processing_phase?.status === 'error') {
      return { kind: 'failed', code: `video_${vs ?? 'error'}`, message: s.processing_phase?.error?.message ?? 'Facebook could not process the video.', receipt };
    }
    const publishedPhase = s.publishing_phase?.status;
    const ready = vs === 'ready' && (publishedPhase === undefined || publishedPhase === 'complete' || publishedPhase === 'published');
    if (ready) {
      const url = r.permalink_url ? (r.permalink_url.startsWith('http') ? r.permalink_url : `https://www.facebook.com${r.permalink_url}`) : null;
      return { kind: 'published', receipt: { ...receipt, url } };
    }
    return { kind: 'processing', pollAfterSeconds: 30, receipt };
  },

  async fetchMetrics(ctx, input): Promise<MetricRow[]> {
    if (!ctx.connection.granted_scopes.includes('read_insights')) throw new ProviderError('capability', 'metrics_unavailable', 'read_insights was not granted for this Page.');
    // post_impressions is deprecated from Graph v25; only requested on older versions.
    const metrics = ['post_media_view', 'post_clicks', 'post_reactions_like_total', ...(graphMajor(ctx.env) < 25 ? ['post_impressions'] : [])];
    const map: Record<string, MetricRow['metric']> = { post_impressions: 'impressions', post_clicks: 'clicks', post_reactions_like_total: 'likes', post_media_view: null };
    const rows: MetricRow[] = [];
    for (const id of input.objectIds) {
      let r: { data?: Array<{ name?: string; period?: string; values?: Array<{ value?: unknown; end_time?: string }> }> };
      try {
        r = await graph(pageCall(ctx), 'GET', `${id}/insights`, { metric: metrics.join(',') }, { operation: 'post.insights' });
      } catch (e) {
        if (e instanceof ProviderError && e.kind === 'validation') continue; // object type without post insights (e.g. a video ID)
        throw e;
      }
      for (const d of r.data ?? []) {
        const v = d.values?.[d.values.length - 1];
        if (!d.name || typeof v?.value !== 'number') continue;
        rows.push({ providerObjectId: id, rawMetric: d.name, metric: map[d.name] ?? null, value: v.value, date: (v.end_time ?? input.until).slice(0, 10), aggregation: d.period === 'day' ? 'day' : 'lifetime', estimated: false });
      }
    }
    return rows;
  },

  disconnect: (ctx) => metaDisconnect({ env: ctx.env, fetch: ctx.fetch, token: ctx.tokens.access, correlationId: ctx.correlationId, provider: P }),
};

