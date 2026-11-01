// Campaign drafts and per-destination post content revisions. Revisions are
// immutable; editing content creates a new revision, which invalidates any
// preview or approval bound to the old one.
import type { Campaign, DestinationInput, PostRevision } from '@ayonix/contracts';
import { FORMATS, PLATFORMS } from '@ayonix/contracts';
import { destinationProblems, hashCanonical } from '@ayonix/domain';
import type { Env } from '../lib/env.js';
import { AppError, invalid, notFound } from '../lib/errors.js';
import { newId, nowIso } from '../lib/ids.js';
import { all, batchOrConflict, first, guardChanged, parseJson, stmt } from '../lib/db.js';
import { auditStmt } from './audit.js';
import type { Actor } from './context.js';
import { authorize } from './context.js';
import { withIdempotency } from './idempotency.js';

export async function createCampaign(
  env: Env,
  actor: Actor,
  input: { product_id: string; goal: string; audience: string; language: string; idempotency_key: string },
): Promise<Campaign> {
  authorize(actor, 'draft');
  return withIdempotency(env, actor.workspaceId, 'create_campaign_draft', input.idempotency_key, input, async () => {
    const errors: Record<string, string> = {};
    for (const f of ['goal', 'audience'] as const) if (!String(input[f] ?? '').trim()) errors[f] = 'Required';
    if (!/^[A-Za-z]{2,3}([-_][A-Za-z0-9]{2,8})*$/.test(input.language ?? '')) errors.language = 'Use a language tag like en or en-AU';
    if (Object.keys(errors).length) throw invalid('Check the campaign details', errors);
    const product = await first(env, 'SELECT id FROM products WHERE workspace_id = ? AND id = ?', actor.workspaceId, input.product_id);
    if (!product) throw notFound('Product');
    const id = newId('cmp');
    const now = nowIso();
    await env.DB.batch([
      stmt(env, 'INSERT INTO campaigns(id, workspace_id, product_id, goal, audience, language, created_by, created_at) VALUES (?,?,?,?,?,?,?,?)',
        id, actor.workspaceId, input.product_id, input.goal.trim().slice(0, 2000), input.audience.trim().slice(0, 2000), input.language, actor.identityId, now),
      auditStmt(env, actor, 'campaign.created', 'campaign', id),
    ]);
    return { id, product_id: input.product_id, goal: input.goal.trim(), audience: input.audience.trim(), language: input.language, created_at: now };
  });
}

export async function listCampaigns(env: Env, actor: Actor, productId?: string): Promise<Campaign[]> {
  authorize(actor, 'read');
  return all<Campaign>(
    env,
    `SELECT id, product_id, goal, audience, language, created_at FROM campaigns WHERE workspace_id = ? ${productId ? 'AND product_id = ?' : ''} ORDER BY created_at DESC LIMIT 100`,
    ...(productId ? [actor.workspaceId, productId] : [actor.workspaceId]),
  );
}

function normalizeDestination(d: DestinationInput, i: number) {
  const errors: Record<string, string> = {};
  if (!(PLATFORMS as readonly string[]).includes(d.platform)) errors[`targets.${i}.platform`] = 'Unsupported platform';
  if (!(FORMATS as readonly string[]).includes(d.format)) errors[`targets.${i}.format`] = 'Unsupported format';
  if (typeof d.connection_id !== 'string' || !d.connection_id) errors[`targets.${i}.connection_id`] = 'Required';
  if (typeof d.caption !== 'string' || d.caption.length > 10000) errors[`targets.${i}.caption`] = 'Caption up to 10,000 characters';
  if (!Array.isArray(d.asset_ids) || d.asset_ids.length > 35 || d.asset_ids.some((a) => typeof a !== 'string')) errors[`targets.${i}.asset_ids`] = 'Up to 35 asset IDs';
  if (d.title !== undefined && (typeof d.title !== 'string' || d.title.length > 100)) errors[`targets.${i}.title`] = 'Title up to 100 characters';
  if (d.link_url !== undefined && d.link_url !== null && typeof d.link_url !== 'string') errors[`targets.${i}.link_url`] = 'Invalid URL';
  if (d.options !== undefined && (typeof d.options !== 'object' || d.options === null || Array.isArray(d.options))) errors[`targets.${i}.options`] = 'Options must be an object';
  return errors;
}

const OPTION_KEYS: Record<string, string[]> = {
  youtube: ['privacy_status', 'made_for_kids', 'contains_synthetic_media', 'category_id', 'native_schedule'],
  tiktok: ['is_aigc'],
  facebook: [],
  instagram: ['share_to_feed'],
  linkedin: ['visibility'],
};

export interface PreparedDestination extends DestinationInput {
  content_hash: string;
  problems: string[];
}

/**
 * Persist exact per-destination content for a campaign as a new post (or a
 * new revision of `post_id`). Ownership is enforced; content problems are
 * returned so the composer can explain what must change before preview.
 */
export async function preparePost(
  env: Env,
  actor: Actor,
  input: { campaign_id: string; post_id?: string; targets: DestinationInput[]; idempotency_key: string },
): Promise<PostRevision & { destinations: PreparedDestination[] }> {
  authorize(actor, 'draft');
  return withIdempotency(env, actor.workspaceId, 'prepare_post', input.idempotency_key, input, async () => {
    if (!Array.isArray(input.targets) || input.targets.length < 1 || input.targets.length > 100) throw invalid('Provide 1–100 destinations');
    const errors = Object.assign({}, ...input.targets.map(normalizeDestination));
    if (Object.keys(errors).length) throw invalid('Check the destinations', errors);
    const campaign = await first<{ id: string }>(env, 'SELECT id FROM campaigns WHERE workspace_id = ? AND id = ?', actor.workspaceId, input.campaign_id);
    if (!campaign) throw notFound('Campaign');
    const seen = new Set<string>();
    const prepared: PreparedDestination[] = [];
    for (const d of input.targets) {
      if (seen.has(d.connection_id)) throw invalid('Each connected account can appear once per post');
      seen.add(d.connection_id);
      const conn = await first<{ provider: string }>(env, 'SELECT provider FROM connections WHERE workspace_id = ? AND id = ?', actor.workspaceId, d.connection_id);
      if (!conn) throw notFound('Connection');
      if (conn.provider !== d.platform) throw invalid(`Connection ${d.connection_id} is a ${conn.provider} account, not ${d.platform}`);
      const assets = [];
      for (const assetId of d.asset_ids) {
        const a = await first<{ mime: string; validation_state: string; duration_ms: number | null; width: number | null; height: number | null; checksum_sha256: string | null }>(
          env, 'SELECT mime, validation_state, duration_ms, width, height, checksum_sha256 FROM assets WHERE workspace_id = ? AND id = ?', actor.workspaceId, assetId);
        if (!a) throw notFound('Asset');
        assets.push({ ...a, id: assetId });
      }
      const allowed = OPTION_KEYS[d.platform] ?? [];
      const options = Object.fromEntries(Object.entries(d.options ?? {}).filter(([k]) => allowed.includes(k)));
      const normalized: DestinationInput = {
        platform: d.platform,
        connection_id: d.connection_id,
        format: d.format,
        caption: d.caption,
        asset_ids: d.asset_ids,
        ...(d.title ? { title: d.title } : {}),
        ...(d.link_url ? { link_url: d.link_url } : {}),
        options,
      };
      const content_hash = await hashCanonical({ ...normalized, asset_checksums: assets.map((a) => a.checksum_sha256) });
      prepared.push({
        ...normalized,
        content_hash,
        problems: destinationProblems({ platform: d.platform, format: d.format, caption: d.caption, title: d.title, link_url: d.link_url, assets }),
      });
    }
    const now = nowIso();
    let postId = input.post_id;
    let revision = 1;
    const statements = [];
    if (postId) {
      const post = await first<{ current_revision: number }>(env, 'SELECT current_revision FROM posts WHERE workspace_id = ? AND id = ? AND campaign_id = ?', actor.workspaceId, postId, input.campaign_id);
      if (!post) throw notFound('Post');
      revision = post.current_revision + 1;
      statements.push(
        stmt(env, 'UPDATE posts SET current_revision = ?, updated_at = ? WHERE workspace_id = ? AND id = ? AND current_revision = ?', revision, now, actor.workspaceId, postId, post.current_revision),
        guardChanged(env),
      );
    } else {
      postId = newId('pst');
      statements.push(stmt(env, 'INSERT INTO posts(id, workspace_id, campaign_id, current_revision, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?)', postId, actor.workspaceId, input.campaign_id, 1, actor.identityId, now, now));
    }
    prepared.forEach((d, position) => {
      const crId = newId('crv');
      statements.push(
        stmt(env, `INSERT INTO content_revisions(id, workspace_id, post_id, revision, position, platform, connection_id, format, caption, title, link_url, options_json, content_hash, created_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, crId, actor.workspaceId, postId, revision, position, d.platform, d.connection_id, d.format, d.caption, d.title ?? null, d.link_url ?? null, JSON.stringify(d.options ?? {}), d.content_hash, now),
        ...d.asset_ids.map((assetId, i) => stmt(env, 'INSERT INTO post_assets(workspace_id, content_revision_id, asset_id, position) VALUES (?,?,?,?)', actor.workspaceId, crId, assetId, i)),
      );
    });
    statements.push(auditStmt(env, actor, input.post_id ? 'post.revised' : 'post.created', 'post', postId, { destinations: prepared.length }, revision));
    await batchOrConflict(env, statements, () => new AppError('version_conflict', 'The post was revised concurrently. Reload and try again.'));
    return { post_id: postId, campaign_id: input.campaign_id, revision, destinations: prepared };
  });
}

export interface ContentRevisionRow {
  id: string;
  post_id: string;
  revision: number;
  position: number;
  platform: DestinationInput['platform'];
  connection_id: string;
  format: DestinationInput['format'];
  caption: string;
  title: string | null;
  link_url: string | null;
  options_json: string;
  content_hash: string;
}

export async function loadRevision(env: Env, workspaceId: string, postId: string, revision: number) {
  const rows = await all<ContentRevisionRow>(
    env,
    'SELECT id, post_id, revision, position, platform, connection_id, format, caption, title, link_url, options_json, content_hash FROM content_revisions WHERE workspace_id = ? AND post_id = ? AND revision = ? ORDER BY position',
    workspaceId, postId, revision,
  );
  const assets = rows.length
    ? await all<{ content_revision_id: string; asset_id: string; position: number }>(
        env,
        `SELECT content_revision_id, asset_id, position FROM post_assets WHERE workspace_id = ? AND content_revision_id IN (${rows.map(() => '?').join(',')}) ORDER BY position`,
        workspaceId, ...rows.map((r) => r.id),
      )
    : [];
  return rows.map((r) => ({ ...r, options: parseJson<Record<string, unknown>>(r.options_json, {}), asset_ids: assets.filter((a) => a.content_revision_id === r.id).map((a) => a.asset_id) }));
}

export async function getPost(env: Env, actor: Actor, postId: string): Promise<PostRevision> {
  authorize(actor, 'read');
  const post = await first<{ campaign_id: string; current_revision: number }>(env, 'SELECT campaign_id, current_revision FROM posts WHERE workspace_id = ? AND id = ?', actor.workspaceId, postId);
  if (!post) throw notFound('Post');
  const rows = await loadRevision(env, actor.workspaceId, postId, post.current_revision);
  return {
    post_id: postId,
    campaign_id: post.campaign_id,
    revision: post.current_revision,
    destinations: rows.map((r) => ({
      platform: r.platform,
      connection_id: r.connection_id,
      format: r.format,
      caption: r.caption,
      asset_ids: r.asset_ids,
      ...(r.title ? { title: r.title } : {}),
      ...(r.link_url ? { link_url: r.link_url } : {}),
      options: r.options,
      content_hash: r.content_hash,
    })),
  };
}
