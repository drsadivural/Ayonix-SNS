// Instagram Professional adapter using ONE login path: Facebook Login for
// Business (graph.facebook.com, Page-linked IG Business/Creator accounts,
// Page access token). Instagram Login scope names (instagram_business_*) are
// never mixed in. Verified against developers.facebook.com on 2026-11-01.
//
// Publishing: create container(s) → poll status_code → media_publish exactly
// once (guarded by receipt.state.publish_requested) → read permalink.
// Container IDs and the final media ID are stored separately.
import type { CapabilityRow } from '@ayonix/contracts';
import { providerConfigured } from '../lib/env.js';
import { asString, cap, emptyReceipt, isHttps, utf16Len } from './common.js';
import { facebookAuthorizeUrl, graph, metaDisconnect, metaExchangeCode, metaRefreshOrReconnect, pageAccessToken, type GraphCall } from './meta.js';
import { ProviderError, type DiscoveredAccount, type MetricRow, type PollResult, type ProviderAdapter, type ProviderContext, type PublishContent, type Receipt } from './types.js';

const P = 'instagram';
const SCOPES = ['instagram_basic', 'instagram_content_publish', 'pages_show_list', 'pages_read_engagement', 'instagram_manage_insights'];
const MIN_RATIO = 4 / 5;
const MAX_RATIO = 1.91;

function capabilities(scopes: string[]): CapabilityRow[] {
  const missing = ['instagram_basic', 'instagram_content_publish', 'pages_read_engagement'].filter((s) => !scopes.includes(s));
  const status = missing.length ? 'unavailable' : 'available';
  const detail = missing.length ? `Missing permission(s): ${missing.join(', ')}.` : 'Instagram content publishing via Facebook Login.';
  return [
    cap('publish_image', status, detail),
    cap('publish_carousel', status, detail),
    cap('publish_reel', status, detail),
    cap('publish_text', 'unavailable', 'Instagram does not support text-only posts.'),
    cap('publish_story', 'unavailable', 'Stories are not enabled in Ayonix.'),
    cap('metrics', scopes.includes('instagram_manage_insights') ? 'available' : 'unavailable', scopes.includes('instagram_manage_insights') ? 'instagram_manage_insights granted.' : 'instagram_manage_insights was not granted.'),
  ];
}

const call = (ctx: ProviderContext): GraphCall => ({ env: ctx.env, fetch: ctx.fetch, token: pageAccessToken(ctx.tokens), correlationId: ctx.correlationId, provider: P });
const igUser = (ctx: ProviderContext) => ctx.connection.provider_account_id;

function imageProblems(m: PublishContent['media'][number], feedRatio: boolean): string[] {
  const out: string[] = [];
  if (m.mime !== 'image/jpeg') out.push('Instagram images must be JPEG.');
  if (m.bytes > 8 * 1024 * 1024) out.push('Instagram images must be 8 MB or smaller.');
  if (!m.width || !m.height) out.push('Image dimensions must be known before publishing to Instagram.');
  else if (feedRatio) {
    const r = m.width / m.height;
    if (r < MIN_RATIO - 0.005 || r > MAX_RATIO + 0.005) out.push('Instagram feed images must have an aspect ratio between 4:5 and 1.91:1.');
  }
  return out;
}

function videoProblems(m: PublishContent['media'][number]): string[] {
  const out: string[] = [];
  if (!['video/mp4', 'video/quicktime'].includes(m.mime)) out.push('Instagram videos must be MP4 or MOV.');
  if (m.bytes > 300 * 1024 * 1024) out.push('Instagram Reels must be 300 MB or smaller.');
  if (m.durationMs === null) out.push('Video duration must be known before publishing to Instagram.');
  else if (m.durationMs < 3000 || m.durationMs > 15 * 60_000) out.push('Instagram Reels must be 3 seconds to 15 minutes long.');
  if (m.width && m.width > 1920) out.push('Instagram video width must be 1920 px or less.');
  return out;
}

export const instagram: ProviderAdapter = {
  provider: 'instagram',
  configured: (env) => providerConfigured(env, 'instagram'),
  scopes: () => [...SCOPES],
  authorizeUrl: (env, input) => facebookAuthorizeUrl(env, input, SCOPES, env.META_INSTAGRAM_CONFIG_ID),
  exchangeCode: (env, code, _verifier, redirectUri, fetchImpl) => metaExchangeCode(env, code, redirectUri, fetchImpl, P),

  async discoverAccounts(env, tokens, fetchImpl) {
    const c: GraphCall = { env, fetch: fetchImpl, token: tokens.accessToken, correlationId: 'discover', provider: P };
    const r = await graph<{ data?: Array<{ id?: string; name?: string; access_token?: string; tasks?: string[]; instagram_business_account?: { id?: string; username?: string; name?: string } }> }>(
      c,
      'GET',
      'me/accounts',
      { fields: 'id,name,access_token,tasks,instagram_business_account{id,username,name}', limit: '100' },
      { operation: 'me.accounts' },
    );
    const accounts: DiscoveredAccount[] = [];
    for (const p of r.data ?? []) {
      const ig = p.instagram_business_account;
      if (!p.id || !p.access_token || !ig?.id) continue;
      const tasks = p.tasks ?? [];
      const rows = capabilities(tokens.scopes);
      if (!tasks.includes('CREATE_CONTENT') && !tasks.includes('MANAGE')) {
        for (const row of rows) if (row.capability.startsWith('publish_') && row.status === 'available') Object.assign(row, { status: 'unavailable', detail: 'Your role on the linked Facebook Page lacks the CREATE_CONTENT task.' });
      }
      accounts.push({
        providerAccountId: ig.id,
        name: ig.username ?? ig.name ?? ig.id,
        type: 'ig_professional',
        metadata: { page_id: p.id, page_name: p.name ?? null, username: ig.username ?? null, page_tasks: tasks, login_path: 'facebook_login' },
        accountAccessToken: p.access_token,
        capabilities: rows,
      });
    }
    if (!accounts.length) {
      throw new ProviderError(
        'capability',
        'no_instagram_professional_account',
        'No Instagram Business or Creator account linked to a Facebook Page you manage was found. Personal Instagram accounts cannot publish through the API: switch to a Professional account, link it to a Facebook Page, then reconnect.',
      );
    }
    return accounts;
  },

  async probeCapabilities(ctx) {
    const rows = capabilities(ctx.connection.granted_scopes);
    if (!asString(ctx.connection.metadata.page_id)) {
      return rows.map((r) => (r.capability.startsWith('publish_') ? { ...r, status: 'unavailable' as const, detail: 'No linked Facebook Page is recorded; reconnect.' } : r));
    }
    return rows;
  },

  refreshOrReconnect: (ctx) => metaRefreshOrReconnect(ctx, P),

  validatePost(_ctx, content) {
    const problems: string[] = [];
    const n = content.media.length;
    switch (content.format) {
      case 'image':
        if (n !== 1 || !content.media[0]!.mime.startsWith('image/')) problems.push('An Instagram image post needs exactly one image.');
        else problems.push(...imageProblems(content.media[0]!, true));
        break;
      case 'carousel':
        if (n < 2 || n > 10) problems.push('Instagram carousels need 2–10 items.');
        for (const m of content.media) {
          if (m.mime.startsWith('image/')) problems.push(...imageProblems(m, true));
          else if (m.mime.startsWith('video/')) problems.push(...videoProblems(m));
          else problems.push(`${m.mime} is not allowed in an Instagram carousel.`);
        }
        break;
      case 'reel':
        if (n !== 1 || !content.media[0]!.mime.startsWith('video/')) problems.push('An Instagram Reel needs exactly one video.');
        else problems.push(...videoProblems(content.media[0]!));
        break;
      default:
        problems.push(`Instagram does not support the ${content.format} format${content.format === 'text' || content.format === 'link' ? ' (media is required)' : ''}.`);
    }
    for (const m of content.media) if (!isHttps(m.publicUrl)) problems.push('Media must be served from an https URL Meta can fetch.');
    if (utf16Len(content.caption) > 2200) problems.push('Instagram captions are limited to 2200 characters.');
    if ((content.caption.match(/(^|\s)#[\p{L}\p{N}_]+/gu) ?? []).length > 30) problems.push('Instagram captions allow at most 30 hashtags.');
    if ((content.caption.match(/(^|\s)@[\w.]+/g) ?? []).length > 20) problems.push('Instagram captions allow at most 20 @ mentions.');
    if (content.publishAt) problems.push('Instagram posts are scheduled by Ayonix, not natively.');
    return [...new Set(problems)];
  },

  async uploadMedia(ctx, content) {
    if (content.format !== 'carousel') return {};
    // Child containers are unpublished; Meta fetches each publicUrl.
    const children: string[] = [];
    for (const m of content.media) {
      const params: Record<string, string> = m.mime.startsWith('video/') ? { media_type: 'VIDEO', video_url: m.publicUrl, is_carousel_item: 'true' } : { image_url: m.publicUrl, is_carousel_item: 'true' };
      const r = await graph<{ id?: string }>(call(ctx), 'POST', `${igUser(ctx)}/media`, params, { operation: 'media.child' });
      if (!r.id) throw new ProviderError('transient', 'invalid_container_response', 'Instagram did not return a container ID.');
      children.push(r.id);
    }
    return { children };
  },

  async submitPost(ctx, content, uploaded) {
    let params: Record<string, string>;
    if (content.format === 'image') {
      const m = content.media[0];
      if (!m) throw new ProviderError('validation', 'missing_media', 'An image post needs an image.');
      params = { image_url: m.publicUrl, caption: content.caption };
    } else if (content.format === 'reel') {
      const m = content.media[0];
      if (!m) throw new ProviderError('validation', 'missing_media', 'A Reel needs a video.');
      params = { media_type: 'REELS', video_url: m.publicUrl, caption: content.caption };
      if (typeof content.options.share_to_feed === 'boolean') params.share_to_feed = String(content.options.share_to_feed);
    } else if (content.format === 'carousel') {
      const children = Array.isArray(uploaded.children) ? (uploaded.children as string[]) : [];
      if (children.length < 2) throw new ProviderError('validation', 'missing_media', 'Carousel items were not uploaded.');
      params = { media_type: 'CAROUSEL', children: children.join(','), caption: content.caption };
    } else {
      throw new ProviderError('validation', 'unsupported_format', `Instagram does not support the ${content.format} format.`);
    }
    // Container creation does not publish anything; media_publish happens in pollStatus.
    const r = await graph<{ id?: string }>(call(ctx), 'POST', `${igUser(ctx)}/media`, params, { operation: 'media.container' });
    if (!r.id) throw new ProviderError('transient', 'invalid_container_response', 'Instagram did not return a container ID.');
    return { kind: 'processing', pollAfterSeconds: content.format === 'image' ? 5 : 30, receipt: emptyReceipt({ containerId: r.id, state: { ig_user_id: igUser(ctx), publish_requested: false } }) };
  },

  /**
   * IMPORTANT for callers: when this marks `receipt.state.publish_requested`
   * it mutates the passed receipt before calling media_publish, so the caller
   * must persist the receipt even when this throws. A receipt with
   * publish_requested=true and no remoteId means a publish may have happened;
   * it raises 'ambiguous' and is never published again.
   */
  async pollStatus(ctx, receipt): Promise<PollResult> {
    const c = call(ctx);
    if (receipt.remoteId) {
      if (receipt.url) return { kind: 'published', receipt };
      return { kind: 'published', receipt: { ...receipt, url: await readPermalink(c, receipt.remoteId) } };
    }
    if (receipt.state.publish_requested === true) {
      throw new ProviderError('ambiguous', 'publish_outcome_unknown', 'An Instagram publish was requested but its result was not recorded. Reconcile before any retry.');
    }
    if (!receipt.containerId) return { kind: 'failed', code: 'missing_container', message: 'No Instagram container ID was recorded.', receipt };
    const s = await graph<{ status_code?: string; status?: string }>(c, 'GET', receipt.containerId, { fields: 'status_code,status' }, { operation: 'container.status' });
    switch (s.status_code) {
      case 'IN_PROGRESS':
        return { kind: 'processing', pollAfterSeconds: 30, receipt };
      case 'ERROR':
        return { kind: 'failed', code: 'container_error', message: s.status ?? 'Instagram could not process the media.', receipt };
      case 'EXPIRED':
        return { kind: 'failed', code: 'container_expired', message: 'The Instagram container expired before publishing (24 hours).', receipt };
      case 'PUBLISHED':
        throw new ProviderError('ambiguous', 'container_already_published', 'The container is already published but no media ID was recorded. Reconcile.');
      case 'FINISHED':
        break;
      default:
        return { kind: 'processing', pollAfterSeconds: 30, receipt };
    }
    receipt.state.publish_requested = true;
    receipt.state.publish_requested_at = new Date().toISOString();
    const userId = asString(receipt.state.ig_user_id) ?? igUser(ctx);
    const pub = await graph<{ id?: string }>(c, 'POST', `${userId}/media_publish`, { creation_id: receipt.containerId }, { operation: 'media_publish', creates: true });
    if (!pub.id) throw new ProviderError('ambiguous', 'missing_media_id', 'Instagram returned no media ID for the publish. Reconcile before retrying.');
    const next: Receipt = { ...receipt, remoteId: pub.id, state: { ...receipt.state } };
    next.url = await readPermalink(c, pub.id);
    return { kind: 'published', receipt: next };
  },

  async fetchMetrics(ctx, input): Promise<MetricRow[]> {
    if (!ctx.connection.granted_scopes.includes('instagram_manage_insights')) throw new ProviderError('capability', 'metrics_unavailable', 'instagram_manage_insights was not granted.');
    const map: Record<string, MetricRow['metric']> = { reach: 'reach', views: 'views', likes: 'likes', comments: 'comments', shares: 'shares', saved: 'saves', total_interactions: null };
    const all = Object.keys(map);
    const rows: MetricRow[] = [];
    const date = input.until.slice(0, 10);
    for (const id of input.objectIds) {
      const collect = (data: Array<{ name?: string; values?: Array<{ value?: unknown }> }> | undefined) => {
        for (const d of data ?? []) {
          const v = d.values?.[0]?.value;
          if (!d.name || typeof v !== 'number') continue;
          rows.push({ providerObjectId: id, rawMetric: d.name, metric: map[d.name] ?? null, value: v, date, aggregation: 'lifetime', estimated: false });
        }
      };
      try {
        const r = await graph<{ data?: Array<{ name?: string; values?: Array<{ value?: unknown }> }> }>(call(ctx), 'GET', `${id}/insights`, { metric: all.join(',') }, { operation: 'media.insights' });
        collect(r.data);
      } catch (e) {
        if (!(e instanceof ProviderError) || e.kind !== 'validation') throw e;
        // Some metrics are not available for every media type: request individually and skip unsupported ones.
        for (const m of all) {
          try {
            const r = await graph<{ data?: Array<{ name?: string; values?: Array<{ value?: unknown }> }> }>(call(ctx), 'GET', `${id}/insights`, { metric: m }, { operation: 'media.insights' });
            collect(r.data);
          } catch (e2) {
            if (!(e2 instanceof ProviderError) || e2.kind !== 'validation') throw e2;
          }
        }
      }
    }
    return rows;
  },

  disconnect: (ctx) => metaDisconnect({ env: ctx.env, fetch: ctx.fetch, token: ctx.tokens.access, correlationId: ctx.correlationId, provider: P }),
};

async function readPermalink(c: GraphCall, mediaId: string): Promise<string | null> {
  try {
    const r = await graph<{ permalink?: string }>(c, 'GET', mediaId, { fields: 'permalink' }, { operation: 'media.permalink' });
    return r.permalink ?? null;
  } catch {
    return null; // the media exists; a missing permalink must not turn a publish into a failure
  }
}
