// INTEGRATION TEST against local D1/R2: media validation, SSRF guard, signed
// URLs, products/claims review, members and last-owner protection.
import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { actorFor, makeIdentity, makeWorkspace, testEnv } from './helpers.js';
import { completeAsset, createUploadIntent, receiveUpload, signedMediaUrl } from '../src/services/assets.js';
import { approveProduct, getProduct, saveProduct } from '../src/services/products.js';
import { changeRole, removeMember } from '../src/services/workspace.js';
import { assertPublicHttpsUrl } from '../src/security/safe-fetch.js';
import { probeMedia } from '../src/security/media-probe.js';

function png(w: number, h: number) {
  const b = new Uint8Array(33);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(b.buffer).setUint32(16, w);
  new DataView(b.buffer).setUint32(20, h);
  return b;
}

async function upload(f: Awaited<ReturnType<typeof makeWorkspace>>, bytes: Uint8Array, mime: string) {
  const intent = await createUploadIntent(testEnv, f.owner, { filename: 'x', mime, bytes: bytes.byteLength });
  const token = new URL(intent.upload_url).searchParams.get('token')!;
  await receiveUpload(testEnv, intent.asset_id, token, new Request('http://x', { method: 'PUT', body: bytes, headers: { 'content-length': String(bytes.byteLength) } }));
  return completeAsset(testEnv, f.owner, intent.asset_id);
}

describe('media', () => {
  it('MEDIA-01: validates by content, not declared type; rejects junk; signed URL serves only owned valid media', async () => {
    const f = await makeWorkspace();
    const ok = await upload(f, png(1080, 1350), 'image/png');
    expect(ok).toMatchObject({ validation_state: 'valid', mime: 'image/png', width: 1080, height: 1350 });
    expect(ok.checksum_sha256).toMatch(/^[0-9a-f]{64}$/);
    const junk = await upload(f, new TextEncoder().encode('<script>alert(1)</script>'), 'image/png');
    expect(junk.validation_state).toBe('rejected');
    const url = await signedMediaUrl(testEnv, f.workspaceId, ok.id, 60);
    const r = await SELF.fetch(url);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('image/png');
    const tampered = url.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A'));
    expect((await SELF.fetch(tampered)).status).toBeGreaterThanOrEqual(400);
  });

  it('rejects oversize declarations and wrong upload tokens', async () => {
    const f = await makeWorkspace();
    await expect(createUploadIntent(testEnv, f.owner, { filename: 'x', mime: 'video/mp4', bytes: 600 * 1024 * 1024 })).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(createUploadIntent(testEnv, f.owner, { filename: 'x', mime: 'application/x-msdownload', bytes: 10 })).rejects.toMatchObject({ code: 'invalid_request' });
    const a = await createUploadIntent(testEnv, f.owner, { filename: 'x', mime: 'image/png', bytes: 33 });
    const b = await createUploadIntent(testEnv, f.owner, { filename: 'y', mime: 'image/png', bytes: 33 });
    const tokenA = new URL(a.upload_url).searchParams.get('token')!;
    await expect(receiveUpload(testEnv, b.asset_id, tokenA, new Request('http://x', { method: 'PUT', body: png(1, 1), headers: { 'content-length': '33' } }))).rejects.toMatchObject({ code: 'forbidden' });
    await expect(receiveUpload(testEnv, a.asset_id, tokenA, new Request('http://x', { method: 'PUT', body: new Uint8Array(100), headers: { 'content-length': '100' } }))).rejects.toMatchObject({ code: 'unprocessable' });
  });

  it('SSRF guard blocks private, credentialed and non-https targets', () => {
    for (const u of ['http://example.com/a.png', 'https://127.0.0.1/a', 'https://10.0.0.5/x', 'https://169.254.169.254/latest', 'https://localhost/x', 'https://user:pw@example.com/', 'https://[::1]/x', 'https://2130706433/', 'https://printer.local/x', 'https://example.com:8443/x']) {
      expect(() => assertPublicHttpsUrl(u), u).toThrow();
    }
    expect(assertPublicHttpsUrl('https://cdn.example.com/a.png').hostname).toBe('cdn.example.com');
  });

  it('reads MP4 duration and dimensions', () => {
    // ftyp + moov{mvhd(v0, timescale 1000, duration 15000) + trak{tkhd(v0, 1080x1920)}}
    const box = (type: string, payload: Uint8Array) => {
      const b = new Uint8Array(8 + payload.length);
      new DataView(b.buffer).setUint32(0, b.length);
      b.set(new TextEncoder().encode(type), 4);
      b.set(payload, 8);
      return b;
    };
    const mvhd = new Uint8Array(100);
    new DataView(mvhd.buffer).setUint32(12, 1000);
    new DataView(mvhd.buffer).setUint32(16, 15000);
    const tkhd = new Uint8Array(84);
    new DataView(tkhd.buffer).setUint32(76, 1080 * 65536);
    new DataView(tkhd.buffer).setUint32(80, 1920 * 65536);
    const ftyp = box('ftyp', new TextEncoder().encode('isom\0\0\0\0isom'));
    const moov = box('moov', new Uint8Array([...box('mvhd', mvhd), ...box('trak', box('tkhd', tkhd))]));
    const file = new Uint8Array([...ftyp, ...moov]);
    expect(probeMedia(file)).toMatchObject({ mime: 'video/mp4', duration_ms: 15000, width: 1080, height: 1920 });
    // moov at the end of the file (iPhone MOV / default ffmpeg): head has ftyp+mdat, tail has moov.
    const mdat = box('mdat', new Uint8Array(4096));
    const late = new Uint8Array([...ftyp, ...mdat, ...moov]);
    expect(probeMedia(late.subarray(0, 1024), late.subarray(late.length - 512))).toMatchObject({ duration_ms: 15000, width: 1080 });
  });
});

describe('products', () => {
  it('approval binds the exact reviewed version', async () => {
    const f = await makeWorkspace();
    await testEnv.DB.prepare('UPDATE products SET active = 0 WHERE workspace_id = ?').bind(f.workspaceId).run();
    const p = await saveProduct(testEnv, f.owner, { name: 'Edge AI', audience: 'Retail', language: 'en', tone: 'Plain', source_urls: ['https://ayonix.com/'], proposed_claims: ['Works with existing cameras'], prohibited_claims: ['Guaranteed theft reduction'] });
    expect(p.status).toBe('draft');
    expect(p.claims.every((c) => c.status === 'proposed')).toBe(true);
    const v2 = await saveProduct(testEnv, f.owner, { product_id: p.id, expected_version: 1, name: 'Edge AI', audience: 'Retail', language: 'en', tone: 'Plain', source_urls: [], proposed_claims: ['Works with existing cameras', 'Real-time alerts'], prohibited_claims: [] });
    expect(v2.version).toBe(2);
    await expect(approveProduct(testEnv, f.owner, p.id, 1)).rejects.toMatchObject({ code: 'version_conflict' });
    await expect(saveProduct(testEnv, f.owner, { product_id: p.id, expected_version: 1, name: 'Stale', audience: '', language: 'en', tone: '', source_urls: [], proposed_claims: [], prohibited_claims: [] })).rejects.toMatchObject({ code: 'version_conflict' });
    const approved = await approveProduct(testEnv, f.owner, p.id, 2);
    expect(approved).toMatchObject({ status: 'approved', approved_version: 2 });
    expect(approved.claims.filter((c) => c.status === 'approved').map((c) => c.text).sort()).toEqual(['Real-time alerts', 'Works with existing cameras']);
    const viewer = await makeIdentity();
    await expect(approveProduct(testEnv, actorFor(f.workspaceId, viewer, 'viewer'), p.id, 2)).rejects.toMatchObject({ code: 'forbidden' });
    expect((await getProduct(testEnv, f.owner, p.id)).version).toBe(2);
  });

  it('enforces the active product limit of the plan', async () => {
    const f = await makeWorkspace({ plan: 'basic' });
    await expect(saveProduct(testEnv, f.owner, { name: 'Second', audience: '', language: 'en', tone: '', source_urls: [], proposed_claims: [], prohibited_claims: [] })).rejects.toMatchObject({ code: 'entitlement_required' });
  });
});

describe('members', () => {
  it('AUTH-02: last owner cannot be removed or demoted', async () => {
    const f = await makeWorkspace();
    await expect(removeMember(testEnv, f.owner, f.owner.identityId)).rejects.toMatchObject({ code: 'conflict' });
    await expect(changeRole(testEnv, f.owner, f.owner.identityId, 'admin')).rejects.toMatchObject({ code: 'conflict' });
    const second = await makeIdentity();
    const t = new Date().toISOString();
    await testEnv.DB.prepare(`INSERT INTO memberships(workspace_id, identity_id, role, created_at, updated_at) VALUES (?,?,?,?,?)`).bind(f.workspaceId, second.id, 'admin', t, t).run();
    await expect(changeRole(testEnv, actorFor(f.workspaceId, second, 'admin'), second.id, 'owner')).rejects.toMatchObject({ code: 'forbidden' });
    await changeRole(testEnv, f.owner, second.id, 'owner');
    await removeMember(testEnv, f.owner, f.owner.identityId);
    const left = await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM memberships WHERE workspace_id = ?').bind(f.workspaceId).first<{ n: number }>();
    expect(left!.n).toBe(1);
  });
});
