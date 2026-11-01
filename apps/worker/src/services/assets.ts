// Owned media: bounded signed uploads into workspace-prefixed R2 keys,
// content-based validation, checksums, storage limits and short-lived signed
// download URLs for provider pull. Remote ingestion goes through safeFetch.
import type { Asset } from '@ayonix/contracts';
import type { Env } from '../lib/env.js';
import { AppError, invalid, notFound } from '../lib/errors.js';
import { newId, nowIso } from '../lib/ids.js';
import { all, decodeCursor, encodeCursor, first, run, stmt } from '../lib/db.js';
import { MAX_UPLOAD_BYTES, MediaRejected, probeMedia } from '../security/media-probe.js';
import { safeFetch } from '../security/safe-fetch.js';
import { signToken, verifyToken } from '../security/crypto.js';
import { auditStmt } from './audit.js';
import type { Actor } from './context.js';
import { authorize } from './context.js';
import { entitlementsFrom, getSubscription } from './workspace.js';
import { withIdempotency } from './idempotency.js';

/** Remote ingestion is buffered in Worker memory, so it has a lower cap than direct upload. */
export const MAX_INGEST_BYTES = 100 * 1024 * 1024;
const ALLOWED_DECLARED = /^(image\/(png|jpeg|gif|webp)|video\/(mp4|quicktime))$/;

interface AssetRow {
  id: string;
  workspace_id: string;
  product_id: string | null;
  r2_key: string;
  filename: string;
  mime: string;
  bytes: number;
  max_bytes: number;
  width: number | null;
  height: number | null;
  duration_ms: number | null;
  checksum_sha256: string | null;
  validation_state: Asset['validation_state'];
  validation_error: string | null;
  created_at: string;
}

const toAsset = (r: AssetRow): Asset => ({
  id: r.id,
  product_id: r.product_id,
  filename: r.filename,
  mime: r.mime,
  bytes: r.bytes,
  width: r.width,
  height: r.height,
  duration_ms: r.duration_ms,
  checksum_sha256: r.checksum_sha256,
  validation_state: r.validation_state,
  validation_error: r.validation_error,
  created_at: r.created_at,
});

function safeFilename(name: string): string {
  // eslint-disable-next-line no-control-regex -- strip control characters from user filenames
  const n = String(name ?? '').replace(/[\\/\u0000-\u001f]/g, '_').trim().slice(0, 200);
  if (!n) throw invalid('A filename is required', { filename: 'Required' });
  return n;
}

async function assertProduct(env: Env, workspaceId: string, productId: string | null | undefined) {
  if (!productId) return null;
  const p = await first(env, 'SELECT id FROM products WHERE workspace_id = ? AND id = ?', workspaceId, productId);
  if (!p) throw notFound('Product');
  return productId;
}

async function storageUsed(env: Env, workspaceId: string): Promise<number> {
  // Pending uploads count at their declared maximum so parallel intents cannot exceed the limit.
  return (await first<{ n: number }>(env, `SELECT COALESCE(SUM(CASE WHEN validation_state = 'pending' THEN max_bytes ELSE bytes END),0) AS n FROM assets WHERE workspace_id = ? AND validation_state <> 'rejected'`, workspaceId))?.n ?? 0;
}

async function assertStorage(env: Env, workspaceId: string, extra: number) {
  const ent = entitlementsFrom(await getSubscription(env, workspaceId));
  const limit = ent.storage_bytes;
  if (!limit) throw new AppError('entitlement_required', 'Media storage requires an active plan.');
  if ((await storageUsed(env, workspaceId)) + extra > limit) {
    throw new AppError('quota_exceeded', `Media storage limit of ${Math.round(limit / 1024 ** 3)} GB reached. Remove unused media first.`);
  }
}

export async function createUploadIntent(env: Env, actor: Actor, input: { filename: string; mime: string; bytes: number; product_id?: string | null }) {
  authorize(actor, 'draft');
  const filename = safeFilename(input.filename);
  if (!ALLOWED_DECLARED.test(input.mime ?? '')) throw invalid('Upload PNG, JPEG, GIF, WebP, MP4 or MOV files', { mime: 'Unsupported type' });
  if (!Number.isSafeInteger(input.bytes) || input.bytes < 1 || input.bytes > MAX_UPLOAD_BYTES) {
    throw invalid(`Files must be between 1 byte and ${MAX_UPLOAD_BYTES / 1024 / 1024} MB`, { bytes: 'Too large' });
  }
  const productId = await assertProduct(env, actor.workspaceId, input.product_id);
  await assertStorage(env, actor.workspaceId, input.bytes);
  const id = newId('ast');
  const now = nowIso();
  const key = `ws/${actor.workspaceId}/assets/${id}`;
  await env.DB.batch([
    stmt(env, `INSERT INTO assets(id, workspace_id, product_id, r2_key, filename, declared_mime, max_bytes, source, rights_confirmed, created_by, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, id, actor.workspaceId, productId, key, filename, input.mime, input.bytes, 'upload', 1, actor.identityId, now, now),
    auditStmt(env, actor, 'asset.upload_intent', 'asset', id, { bytes: input.bytes, mime: input.mime }),
  ]);
  const { token, expires_at } = await signToken(env, 'upload', { ws: actor.workspaceId, asset: id, max: input.bytes }, 15 * 60);
  return {
    asset_id: id,
    upload_url: `${env.APP_ORIGIN}/api/v1/assets/${id}/content?token=${encodeURIComponent(token)}`,
    method: 'PUT' as const,
    headers: { 'content-type': input.mime },
    expires_at,
  };
}

/** Token-authorized upload body handler (no cookie needed, so the hosted handoff page works). */
export async function receiveUpload(env: Env, assetId: string, token: string, request: Request) {
  const claims = await verifyToken<{ ws: string; asset: string; max: number }>(env, 'upload', token);
  if (claims.asset !== assetId) throw new AppError('forbidden', 'Upload token does not match this asset');
  const asset = await first<AssetRow>(env, 'SELECT * FROM assets WHERE workspace_id = ? AND id = ?', claims.ws, assetId);
  if (!asset) throw notFound('Asset');
  if (asset.validation_state !== 'pending') throw new AppError('conflict', 'This upload was already completed');
  const length = Number(request.headers.get('content-length') ?? 'NaN');
  if (!Number.isSafeInteger(length) || length < 1) throw new AppError('invalid_request', 'Content-Length is required');
  if (length > Math.min(claims.max, asset.max_bytes)) throw new AppError('unprocessable', 'The file is larger than declared');
  if (!request.body) throw new AppError('invalid_request', 'Empty body');
  const fixed = new FixedLengthStream(length);
  const pipe = request.body.pipeTo(fixed.writable);
  await env.MEDIA.put(asset.r2_key, fixed.readable, { httpMetadata: { contentType: 'application/octet-stream' }, customMetadata: { workspace: claims.ws } });
  await pipe;
  await run(env, 'UPDATE assets SET bytes = ?, updated_at = ? WHERE workspace_id = ? AND id = ?', length, nowIso(), claims.ws, assetId);
  return { asset_id: assetId, bytes: length };
}

async function sha256OfObject(env: Env, key: string): Promise<string> {
  const obj = await env.MEDIA.get(key);
  if (!obj) throw new AppError('unprocessable', 'Uploaded file not found');
  const digest = new crypto.DigestStream('SHA-256');
  await obj.body.pipeTo(digest);
  const buf = await digest.digest;
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Probe the stored object by content, compute its checksum and mark it valid or rejected. */
export async function completeAsset(env: Env, actor: Actor, assetId: string): Promise<Asset> {
  authorize(actor, 'draft');
  const asset = await first<AssetRow>(env, 'SELECT * FROM assets WHERE workspace_id = ? AND id = ?', actor.workspaceId, assetId);
  if (!asset) throw notFound('Asset');
  if (asset.validation_state !== 'pending') return toAsset(asset);
  const head = await env.MEDIA.get(asset.r2_key, { range: { offset: 0, length: 256 * 1024 } });
  if (!head) throw new AppError('unprocessable', 'The file has not been uploaded yet');
  const size = head.size;
  const headBytes = new Uint8Array(await head.arrayBuffer());
  let tailBytes: Uint8Array | undefined;
  if (size > headBytes.length) {
    const tailLen = Math.min(size, 4 * 1024 * 1024);
    const tail = await env.MEDIA.get(asset.r2_key, { range: { offset: size - tailLen, length: tailLen } });
    if (tail) tailBytes = new Uint8Array(await tail.arrayBuffer());
  }
  const now = nowIso();
  try {
    const probe = probeMedia(headBytes, tailBytes);
    if (probe.kind === 'image' && size > 30 * 1024 * 1024) throw new MediaRejected('Images must be 30 MB or smaller');
    const checksum = await sha256OfObject(env, asset.r2_key);
    await env.DB.batch([
      stmt(env, `UPDATE assets SET mime=?, bytes=?, width=?, height=?, duration_ms=?, checksum_sha256=?, validation_state='valid', validation_error=NULL, updated_at=? WHERE workspace_id=? AND id=?`,
        probe.mime, size, probe.width, probe.height, probe.duration_ms, checksum, now, actor.workspaceId, assetId),
      auditStmt(env, actor, 'asset.validated', 'asset', assetId, { mime: probe.mime, bytes: size }),
    ]);
  } catch (e) {
    if (!(e instanceof MediaRejected)) throw e;
    await env.MEDIA.delete(asset.r2_key);
    await env.DB.batch([
      stmt(env, `UPDATE assets SET validation_state='rejected', validation_error=?, bytes=0, updated_at=? WHERE workspace_id=? AND id=?`, e.message, now, actor.workspaceId, assetId),
      auditStmt(env, actor, 'asset.rejected', 'asset', assetId, { reason: e.message }),
    ]);
  }
  return getAsset(env, actor, assetId);
}

export async function getAsset(env: Env, actor: Actor, assetId: string): Promise<Asset> {
  authorize(actor, 'read');
  const a = await first<AssetRow>(env, 'SELECT * FROM assets WHERE workspace_id = ? AND id = ?', actor.workspaceId, assetId);
  if (!a) throw notFound('Asset');
  return toAsset(a);
}

export async function listAssets(env: Env, actor: Actor, opts: { product_id?: string; cursor?: string; limit?: number }) {
  authorize(actor, 'read');
  const limit = Math.min(opts.limit ?? 50, 100);
  const c = decodeCursor(opts.cursor);
  const binds: unknown[] = [actor.workspaceId];
  let where = `workspace_id = ? AND validation_state = 'valid'`;
  if (opts.product_id) {
    where += ' AND product_id = ?';
    binds.push(opts.product_id);
  }
  if (c) {
    where += ' AND (created_at, id) < (?, ?)';
    binds.push(c[0], c[1]);
  }
  const rows = await all<AssetRow>(env, `SELECT * FROM assets WHERE ${where} ORDER BY created_at DESC, id DESC LIMIT ?`, ...binds, limit + 1);
  const page = rows.slice(0, limit);
  return { items: page.map(toAsset), next_cursor: rows.length > limit ? encodeCursor(page.at(-1)!.created_at, page.at(-1)!.id) : null };
}

/**
 * Ingest a user-selected HTTPS media URL. Without a retrievable URL, return an
 * authenticated upload handoff instead of pretending a file was attached.
 */
export async function ingestAsset(
  env: Env,
  actor: Actor,
  input: { source_url?: string; filename: string; product_id: string; rights_confirmed: boolean; idempotency_key: string },
) {
  authorize(actor, 'draft');
  if (input.rights_confirmed !== true) throw invalid('Confirm you have the rights to use this media', { rights_confirmed: 'Required' });
  return withIdempotency(env, actor.workspaceId, 'ingest_media', input.idempotency_key, input, async () => {
    const filename = safeFilename(input.filename);
    const productId = await assertProduct(env, actor.workspaceId, input.product_id);
    if (!input.source_url) {
      const id = newId('ast');
      const now = nowIso();
      await run(env, `INSERT INTO assets(id, workspace_id, product_id, r2_key, filename, max_bytes, source, rights_confirmed, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        id, actor.workspaceId, productId, `ws/${actor.workspaceId}/assets/${id}`, filename, MAX_UPLOAD_BYTES, 'upload', 1, actor.identityId, now, now);
      const { token, expires_at } = await signToken(env, 'upload-page', { ws: actor.workspaceId, asset: id }, 30 * 60);
      return {
        status: 'upload_required' as const,
        asset_id: id,
        upload_page_url: `${env.APP_ORIGIN}/upload/${id}?token=${encodeURIComponent(token)}`,
        expires_at,
        message: 'No retrievable media URL was provided. Open the upload page signed in to Ayonix to add the file, then use this asset ID.',
      };
    }
    await assertStorage(env, actor.workspaceId, 1);
    const fetched = await safeFetch(input.source_url, { maxBytes: MAX_INGEST_BYTES, timeoutMs: 60_000 });
    await assertStorage(env, actor.workspaceId, fetched.bytes.byteLength);
    const id = newId('ast');
    const key = `ws/${actor.workspaceId}/assets/${id}`;
    const now = nowIso();
    const host = new URL(fetched.finalUrl).hostname;
    await env.MEDIA.put(key, fetched.bytes, { customMetadata: { workspace: actor.workspaceId } });
    await env.DB.batch([
      stmt(env, `INSERT INTO assets(id, workspace_id, product_id, r2_key, filename, declared_mime, max_bytes, bytes, source, source_host, rights_confirmed, created_by, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, id, actor.workspaceId, productId, key, filename, fetched.contentType, MAX_INGEST_BYTES, fetched.bytes.byteLength, 'ingest', host, 1, actor.identityId, now, now),
      auditStmt(env, actor, 'asset.ingested', 'asset', id, { host, bytes: fetched.bytes.byteLength }),
    ]);
    const asset = await completeAsset(env, actor, id);
    return { status: asset.validation_state === 'valid' ? ('ingested' as const) : ('rejected' as const), asset };
  });
}

/** Short-lived signed URL for provider pull; tokens bind workspace + asset. */
export async function signedMediaUrl(env: Env, workspaceId: string, assetId: string, ttlSeconds = 3600): Promise<string> {
  const { token } = await signToken(env, 'media', { ws: workspaceId, asset: assetId }, ttlSeconds);
  return `${env.APP_ORIGIN}/u/media/${encodeURIComponent(token)}`;
}

export async function serveSignedMedia(env: Env, token: string, request: Request): Promise<Response> {
  const claims = await verifyToken<{ ws: string; asset: string }>(env, 'media', token);
  const asset = await first<AssetRow>(env, `SELECT * FROM assets WHERE workspace_id = ? AND id = ? AND validation_state = 'valid'`, claims.ws, claims.asset);
  if (!asset) throw notFound('Media');
  const range = request.headers.get('range');
  const m = range ? /^bytes=(\d+)-(\d*)$/.exec(range) : null;
  if (m && Number(m[1]) >= asset.bytes) return new Response(null, { status: 416, headers: { 'content-range': `bytes */${asset.bytes}` } });
  const clampEnd = m ? Math.min(m[2] ? Number(m[2]) : asset.bytes - 1, asset.bytes - 1) : 0;
  const opts: R2GetOptions = m ? { range: { offset: Number(m[1]), length: clampEnd - Number(m[1]) + 1 } } : {};
  const obj = await env.MEDIA.get(asset.r2_key, opts);
  if (!obj || !('body' in obj)) throw notFound('Media');
  const headers = new Headers({
    'content-type': asset.mime,
    'cache-control': 'private, max-age=300',
    'x-content-type-options': 'nosniff',
    'accept-ranges': 'bytes',
    'content-disposition': 'inline',
  });
  if (m) {
    const start = Number(m[1]);
    const end = Math.min(clampEnd, obj.size - 1);
    headers.set('content-range', `bytes ${start}-${end}/${obj.size}`);
    headers.set('content-length', String(end - start + 1));
    return new Response(obj.body, { status: 206, headers });
  }
  headers.set('content-length', String(obj.size));
  return new Response(obj.body, { headers });
}

export async function openAssetStream(env: Env, workspaceId: string, assetId: string): Promise<ReadableStream<Uint8Array>> {
  const asset = await first<AssetRow>(env, `SELECT r2_key FROM assets WHERE workspace_id = ? AND id = ? AND validation_state = 'valid'`, workspaceId, assetId);
  if (!asset) throw notFound('Asset');
  const obj = await env.MEDIA.get(asset.r2_key);
  if (!obj) throw notFound('Asset bytes');
  return obj.body;
}

/** Upload-page handoff: exchange a page token for an upload intent bound to the same asset (requires a signed-in member). */
export async function uploadIntentFromPage(env: Env, actor: Actor, assetId: string, pageToken: string, input: { mime: string; bytes: number }) {
  authorize(actor, 'draft');
  const claims = await verifyToken<{ ws: string; asset: string }>(env, 'upload-page', pageToken);
  if (claims.ws !== actor.workspaceId || claims.asset !== assetId) throw new AppError('forbidden', 'This upload link belongs to a different workspace');
  if (!ALLOWED_DECLARED.test(input.mime ?? '')) throw invalid('Upload PNG, JPEG, GIF, WebP, MP4 or MOV files');
  if (!Number.isSafeInteger(input.bytes) || input.bytes < 1 || input.bytes > MAX_UPLOAD_BYTES) throw invalid('File too large');
  await assertStorage(env, actor.workspaceId, input.bytes);
  await run(env, `UPDATE assets SET declared_mime = ?, max_bytes = ?, updated_at = ? WHERE workspace_id = ? AND id = ? AND validation_state = 'pending'`, input.mime, input.bytes, nowIso(), actor.workspaceId, assetId);
  const { token, expires_at } = await signToken(env, 'upload', { ws: actor.workspaceId, asset: assetId, max: input.bytes }, 15 * 60);
  return { asset_id: assetId, upload_url: `${env.APP_ORIGIN}/api/v1/assets/${assetId}/content?token=${encodeURIComponent(token)}`, method: 'PUT' as const, headers: { 'content-type': input.mime }, expires_at };
}
