// Product marketing profiles: versioned, with claims that stay proposed until
// a human approves the exact reviewed version. Web-derived research text can
// only ever create proposed claims.
import type { Product, ProductClaim } from '@ayonix/contracts';
import { hashCanonical } from '@ayonix/domain';
import type { Env } from '../lib/env.js';
import { AppError, invalid, notFound } from '../lib/errors.js';
import { newId, nowIso } from '../lib/ids.js';
import { all, batchOrConflict, decodeCursor, encodeCursor, first, guardChanged, stmt } from '../lib/db.js';
import { assertPublicHttpsUrl } from '../security/safe-fetch.js';
import { auditStmt } from './audit.js';
import type { Actor } from './context.js';
import { authorize } from './context.js';
import { entitlementsFrom, getSubscription } from './workspace.js';
import { withIdempotency } from './idempotency.js';

interface ProductRow {
  id: string;
  name: string;
  audience: string;
  language: string;
  tone: string;
  status: Product['status'];
  version: number;
  approved_version: number | null;
  active: number;
  updated_at: string;
}

async function hydrate(env: Env, workspaceId: string, rows: ProductRow[]): Promise<Product[]> {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const marks = ids.map(() => '?').join(',');
  const claims = await all<ProductClaim & { product_id: string; version: number }>(
    env,
    `SELECT id, product_id, version, text, kind, status, source_url FROM product_claims WHERE workspace_id = ? AND product_id IN (${marks}) ORDER BY created_at`,
    workspaceId,
    ...ids,
  );
  const sources = await all<{ product_id: string; url: string }>(
    env,
    `SELECT product_id, url FROM product_sources WHERE workspace_id = ? AND kind = 'owned' AND product_id IN (${marks}) ORDER BY created_at`,
    workspaceId,
    ...ids,
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    audience: r.audience,
    language: r.language,
    tone: r.tone,
    status: r.status,
    version: r.version,
    approved_version: r.approved_version,
    source_urls: sources.filter((s) => s.product_id === r.id).map((s) => s.url),
    // Current version's claims plus anything still approved from the approved version.
    claims: claims
      .filter((c) => c.product_id === r.id && (c.version === r.version || (c.status === 'approved' && c.version === r.approved_version)))
      .map(({ id, text, kind, status, source_url }) => ({ id, text, kind, status, source_url })),
    updated_at: r.updated_at,
  }));
}

export async function listProducts(env: Env, actor: Actor, cursor?: string, limit = 50): Promise<{ items: Product[]; next_cursor: string | null }> {
  authorize(actor, 'read');
  const c = decodeCursor(cursor);
  const rows = await all<ProductRow>(
    env,
    `SELECT id, name, audience, language, tone, status, version, approved_version, active, updated_at FROM products
     WHERE workspace_id = ? ${c ? 'AND (name, id) > (?, ?)' : ''} ORDER BY name, id LIMIT ?`,
    ...(c ? [actor.workspaceId, c[0], c[1], limit + 1] : [actor.workspaceId, limit + 1]),
  );
  const page = rows.slice(0, limit);
  return { items: await hydrate(env, actor.workspaceId, page), next_cursor: rows.length > limit ? encodeCursor(page.at(-1)!.name, page.at(-1)!.id) : null };
}

export async function getProduct(env: Env, actor: Actor, id: string): Promise<Product> {
  authorize(actor, 'read');
  const row = await first<ProductRow>(env, 'SELECT id, name, audience, language, tone, status, version, approved_version, active, updated_at FROM products WHERE workspace_id = ? AND id = ?', actor.workspaceId, id);
  if (!row) throw notFound('Product');
  return (await hydrate(env, actor.workspaceId, [row]))[0]!;
}

export interface ProductInput {
  product_id?: string;
  expected_version?: number;
  name: string;
  audience: string;
  language: string;
  tone: string;
  source_urls: string[];
  proposed_claims: string[];
  prohibited_claims: string[];
}

function clean(input: ProductInput) {
  const errors: Record<string, string> = {};
  const name = String(input.name ?? '').trim();
  if (!name || name.length > 200) errors.name = 'Enter a product name (up to 200 characters)';
  const urls = (input.source_urls ?? []).map((u) => String(u).trim()).filter(Boolean);
  if (urls.length > 20) errors.source_urls = 'Up to 20 source URLs';
  for (const u of urls) {
    try {
      assertPublicHttpsUrl(u);
    } catch {
      errors.source_urls = `Not an allowed https URL: ${u.slice(0, 80)}`;
    }
  }
  const claims = (input.proposed_claims ?? []).map((t) => String(t).trim()).filter(Boolean);
  const prohibited = (input.prohibited_claims ?? []).map((t) => String(t).trim()).filter(Boolean);
  if (claims.length > 50 || prohibited.length > 50) errors.claims = 'Up to 50 claims of each kind';
  if ([...claims, ...prohibited].some((t) => t.length > 1000)) errors.claims = 'Claims are limited to 1000 characters';
  if (Object.keys(errors).length) throw invalid('Check the product details', errors);
  return {
    name,
    audience: String(input.audience ?? '').trim().slice(0, 2000),
    language: String(input.language ?? 'en').trim().slice(0, 35) || 'en',
    tone: String(input.tone ?? '').trim().slice(0, 500),
    urls: [...new Set(urls)],
    claims: [...new Set(claims)],
    prohibited: [...new Set(prohibited)],
  };
}

/** Create or revise a draft product. A revision bumps version and keeps the prior approval until re-approved. */
export async function saveProduct(env: Env, actor: Actor, input: ProductInput, idempotencyKey?: string): Promise<Product> {
  authorize(actor, 'draft');
  const exec = async () => {
    const c = clean(input);
    const now = nowIso();
    if (!input.product_id) {
      const ent = entitlementsFrom(await getSubscription(env, actor.workspaceId));
      const count = (await first<{ n: number }>(env, 'SELECT COUNT(*) AS n FROM products WHERE workspace_id = ? AND active = 1', actor.workspaceId))?.n ?? 0;
      if (count >= Math.max(ent.products, 1)) {
        throw new AppError('entitlement_required', `This plan includes ${Math.max(ent.products, 1)} active product(s). Pause another product first.`);
      }
      const id = newId('prd');
      const snapshot = { ...c, version: 1 };
      await env.DB.batch([
        stmt(env, 'INSERT INTO products(id, workspace_id, name, audience, language, tone, status, version, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)', id, actor.workspaceId, c.name, c.audience, c.language, c.tone, 'draft', 1, now, now),
        stmt(env, 'INSERT INTO product_revisions(id, workspace_id, product_id, version, snapshot_json, snapshot_hash, created_by, created_at) VALUES (?,?,?,?,?,?,?,?)', newId('prv'), actor.workspaceId, id, 1, JSON.stringify(snapshot), await hashCanonical(snapshot), actor.identityId, now),
        ...c.urls.map((u) => stmt(env, 'INSERT INTO product_sources(id, workspace_id, product_id, url, kind, added_by, created_at) VALUES (?,?,?,?,?,?,?)', newId('src'), actor.workspaceId, id, u, 'owned', actor.identityId, now)),
        ...c.claims.map((t) => stmt(env, 'INSERT INTO product_claims(id, workspace_id, product_id, version, text, kind, status, created_at) VALUES (?,?,?,?,?,?,?,?)', newId('clm'), actor.workspaceId, id, 1, t, 'claim', 'proposed', now)),
        ...c.prohibited.map((t) => stmt(env, 'INSERT INTO product_claims(id, workspace_id, product_id, version, text, kind, status, created_at) VALUES (?,?,?,?,?,?,?,?)', newId('clm'), actor.workspaceId, id, 1, t, 'prohibited', 'proposed', now)),
        auditStmt(env, actor, 'product.created', 'product', id, { name: c.name }, 1),
      ]);
      return getProduct(env, actor, id);
    }
    const existing = await first<{ version: number }>(env, 'SELECT version FROM products WHERE workspace_id = ? AND id = ?', actor.workspaceId, input.product_id);
    if (!existing) throw notFound('Product');
    if (input.expected_version !== undefined && input.expected_version !== existing.version) {
      throw new AppError('version_conflict', 'The product changed since you loaded it.', { current_version: existing.version });
    }
    const version = existing.version + 1;
    const snapshot = { ...c, version };
    await batchOrConflict(env, [
      stmt(env, `UPDATE products SET name=?, audience=?, language=?, tone=?, version=?, status=CASE WHEN approved_version IS NULL THEN 'draft' ELSE status END, updated_at=? WHERE workspace_id=? AND id=? AND version=?`, c.name, c.audience, c.language, c.tone, version, now, actor.workspaceId, input.product_id, existing.version),
      guardChanged(env),
      stmt(env, 'INSERT INTO product_revisions(id, workspace_id, product_id, version, snapshot_json, snapshot_hash, created_by, created_at) VALUES (?,?,?,?,?,?,?,?)', newId('prv'), actor.workspaceId, input.product_id, version, JSON.stringify(snapshot), await hashCanonical(snapshot), actor.identityId, now),
      stmt(env, `DELETE FROM product_sources WHERE workspace_id = ? AND product_id = ? AND kind = 'owned'`, actor.workspaceId, input.product_id),
      ...c.urls.map((u) => stmt(env, 'INSERT INTO product_sources(id, workspace_id, product_id, url, kind, added_by, created_at) VALUES (?,?,?,?,?,?,?)', newId('src'), actor.workspaceId, input.product_id, u, 'owned', actor.identityId, now)),
      // Claims already approved on the prior version carry forward as approved text only if unchanged.
      ...c.claims.map((t) => stmt(env, `INSERT INTO product_claims(id, workspace_id, product_id, version, text, kind, status, source_url, created_at)
        SELECT ?,?,?,?,?,'claim', CASE WHEN EXISTS(SELECT 1 FROM product_claims WHERE workspace_id=? AND product_id=? AND text=? AND kind='claim' AND status='approved') THEN 'approved' ELSE 'proposed' END, NULL, ?`,
        newId('clm'), actor.workspaceId, input.product_id, version, t, actor.workspaceId, input.product_id, t, now)),
      ...c.prohibited.map((t) => stmt(env, `INSERT INTO product_claims(id, workspace_id, product_id, version, text, kind, status, created_at) VALUES (?,?,?,?,?,'prohibited','proposed',?)`, newId('clm'), actor.workspaceId, input.product_id, version, t, now)),
      auditStmt(env, actor, 'product.revised', 'product', input.product_id, { name: c.name }, version),
    ], () => new AppError('version_conflict', 'The product changed since you loaded it.'));
    return getProduct(env, actor, input.product_id);
  };
  return idempotencyKey ? withIdempotency(env, actor.workspaceId, 'save_product', idempotencyKey, input, exec) : exec();
}

/** Approve the exact reviewed version. All current proposed claims of that version become approved. */
export async function approveProduct(env: Env, actor: Actor, productId: string, expectedVersion: number, idempotencyKey?: string): Promise<Product> {
  authorize(actor, 'schedule');
  const exec = async () => {
    const p = await first<{ version: number }>(env, 'SELECT version FROM products WHERE workspace_id = ? AND id = ?', actor.workspaceId, productId);
    if (!p) throw notFound('Product');
    if (p.version !== expectedVersion) throw new AppError('version_conflict', 'The product changed since it was reviewed. Review the latest version.', { current_version: p.version });
    const now = nowIso();
    await batchOrConflict(env, [
      stmt(env, `UPDATE products SET approved_version = version, status = 'approved', updated_at = ? WHERE workspace_id = ? AND id = ? AND version = ?`, now, actor.workspaceId, productId, expectedVersion),
      guardChanged(env),
      stmt(env, `UPDATE product_claims SET status = 'approved' WHERE workspace_id = ? AND product_id = ? AND version = ? AND status = 'proposed' AND research_job_id IS NULL`, actor.workspaceId, productId, expectedVersion),
      stmt(env, 'UPDATE product_revisions SET approved_by = ?, approved_at = ? WHERE workspace_id = ? AND product_id = ? AND version = ?', actor.identityId, now, actor.workspaceId, productId, expectedVersion),
      auditStmt(env, actor, 'product.approved', 'product', productId, {}, expectedVersion),
    ], () => new AppError('version_conflict', 'The product changed since it was reviewed.'));
    return getProduct(env, actor, productId);
  };
  return idempotencyKey ? withIdempotency(env, actor.workspaceId, 'approve_product', idempotencyKey, { productId, expectedVersion }, exec) : exec();
}

/** Individually approve or reject a research-proposed claim after human review. */
export async function reviewClaim(env: Env, actor: Actor, productId: string, claimId: string, decision: 'approved' | 'rejected') {
  authorize(actor, 'schedule');
  if (actor.via !== 'web') throw new AppError('forbidden', 'Review research claims on the Ayonix website');
  await batchOrConflict(env, [
    stmt(env, `UPDATE product_claims SET status = ? WHERE workspace_id = ? AND product_id = ? AND id = ? AND status = 'proposed'`, decision, actor.workspaceId, productId, claimId),
    guardChanged(env),
    auditStmt(env, actor, `product.claim_${decision}`, 'product_claim', claimId),
  ], () => notFound('Proposed claim'));
  return getProduct(env, actor, productId);
}

export async function setProductActive(env: Env, actor: Actor, productId: string, active: boolean) {
  authorize(actor, 'manage_workspace');
  if (active) {
    const ent = entitlementsFrom(await getSubscription(env, actor.workspaceId));
    const count = (await first<{ n: number }>(env, 'SELECT COUNT(*) AS n FROM products WHERE workspace_id = ? AND active = 1 AND id <> ?', actor.workspaceId, productId))?.n ?? 0;
    if (count >= Math.max(ent.products, 1)) throw new AppError('entitlement_required', `This plan includes ${Math.max(ent.products, 1)} active product(s).`);
  }
  await batchOrConflict(env, [
    stmt(env, `UPDATE products SET active = ?, status = CASE WHEN ? = 0 THEN 'paused' WHEN approved_version IS NULL THEN 'draft' ELSE 'approved' END, updated_at = ? WHERE workspace_id = ? AND id = ?`, active ? 1 : 0, active ? 1 : 0, nowIso(), actor.workspaceId, productId),
    guardChanged(env),
    auditStmt(env, actor, active ? 'product.activated' : 'product.paused', 'product', productId),
  ], () => notFound('Product'));
  return getProduct(env, actor, productId);
}
