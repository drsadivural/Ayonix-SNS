// INTEGRATION TEST through the real Worker fetch handler in workerd with local
// D1/KV. Exercises website auth (Better Auth), CSRF, MCP OAuth 2.1 + PKCE via
// workers-oauth-provider and authenticated MCP tool calls. Local only: this is
// not evidence of a real ChatGPT installation or a deployed environment.
import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { testEnv } from './helpers.js';

const ORIGIN = 'http://localhost:8787';

class Jar {
  cookies = new Map<string, string>();
  take(res: Response) {
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const i = pair!.indexOf('=');
      this.cookies.set(pair!.slice(0, i), pair!.slice(i + 1));
    }
  }
  header() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }
}

async function call(jar: Jar, path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  if (jar.cookies.size) headers.set('cookie', jar.header());
  if (init.method && init.method !== 'GET' && !headers.has('origin')) headers.set('origin', ORIGIN);
  const res = await SELF.fetch(`${ORIGIN}${path}`, { ...init, headers, redirect: 'manual' });
  jar.take(res);
  return res;
}

const json = (body: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

async function signedInUser(email: string) {
  const jar = new Jar();
  const r = await call(jar, '/api/auth/sign-up/email', json({ email, password: 'correct horse battery', name: 'Owner' }));
  expect(r.status).toBe(200);
  // Unverified users cannot sign in.
  const blocked = await call(new Jar(), '/api/auth/sign-in/email', json({ email, password: 'correct horse battery' }));
  expect(blocked.status).toBe(403);
  const mail = await testEnv.DB.prepare(`SELECT dev_body FROM sent_notifications WHERE recipient = ? AND template = 'verify_email' ORDER BY created_at DESC LIMIT 1`).bind(email).first<{ dev_body: string }>();
  const link = /https?:\/\/\S+/.exec(mail!.dev_body)![0];
  const v = await call(jar, new URL(link).pathname + new URL(link).search);
  expect([200, 302]).toContain(v.status);
  const s = await call(jar, '/api/auth/sign-in/email', json({ email, password: 'correct horse battery' }));
  expect(s.status).toBe(200);
  return jar;
}

async function pkce() {
  const verifier = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replace(/[+/=]/g, (c) => ({ '+': '-', '/': '_', '=': '' })[c]!);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  const challenge = btoa(String.fromCharCode(...new Uint8Array(digest))).replace(/[+/=]/g, (c) => ({ '+': '-', '/': '_', '=': '' })[c]!);
  return { verifier, challenge };
}

describe('website', () => {
  it('health endpoints', async () => {
    expect((await SELF.fetch(`${ORIGIN}/health/live`)).status).toBe(200);
    const ready = await SELF.fetch(`${ORIGIN}/health/ready`);
    expect(await ready.json()).toMatchObject({ status: 'ready' });
  });

  it('AUTH-01 (local): register → verify → sign in → workspace; CSRF blocks cross-site mutations', async () => {
    const jar = await signedInUser(`owner-${Date.now()}@example.test`);
    const me = await (await call(jar, '/api/v1/me')).json() as { workspaces: unknown[] };
    expect(me.workspaces).toEqual([]);
    const csrf = await call(jar, '/api/v1/workspaces', { ...json({ name: 'Evil' }), headers: { 'content-type': 'application/json', origin: 'https://evil.example' } });
    expect(csrf.status).toBe(403);
    const ws = await call(jar, '/api/v1/workspaces', json({ name: 'Ayonix', timezone: 'Australia/Melbourne' }));
    expect(ws.status).toBe(201);
    const summary = await (await call(jar, '/api/v1/workspace')).json() as { role: string; entitlements: { can_confirm_schedules: boolean; restriction: string } };
    expect(summary.role).toBe('owner');
    expect(summary.entitlements.can_confirm_schedules).toBe(false);
    const unauth = await SELF.fetch(`${ORIGIN}/api/v1/workspace`);
    expect(unauth.status).toBe(401);
    const body = await unauth.json() as { error: { code: string; request_id: string } };
    expect(body.error.code).toBe('unauthenticated');
    expect(body.error.request_id).toBeTruthy();
  });

  it('trial is website-only, once per owner, and grants 5 publications', async () => {
    const jar = await signedInUser(`trial-${Date.now()}@example.test`);
    await call(jar, '/api/v1/workspaces', json({ name: 'Trial WS' }));
    const r = await call(jar, '/api/v1/workspace/trial', { method: 'POST' });
    expect(r.status).toBe(200);
    const s = await r.json() as { quota: { allowance: number }; entitlements: { plan: string } };
    expect(s.entitlements.plan).toBe('trial');
    expect(s.quota.allowance).toBe(5);
    const again = await call(jar, '/api/v1/workspace/trial', { method: 'POST' });
    expect(again.status).toBe(409);
  });
});

describe('MCP OAuth and tools', () => {
  it('unauthenticated MCP requests get a resource-metadata challenge', async () => {
    const r = await SELF.fetch(`${ORIGIN}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
    expect(r.status).toBe(401);
    expect(r.headers.get('www-authenticate')).toMatch(/resource_metadata=/);
    const prm = await (await SELF.fetch(`${ORIGIN}/.well-known/oauth-protected-resource/mcp`)).json() as { resource: string; scopes_supported: string[] };
    expect(prm.resource).toBe(`${ORIGIN}/mcp`);
    expect(prm.scopes_supported).toContain('sns:read');
    const as = await (await SELF.fetch(`${ORIGIN}/.well-known/oauth-authorization-server`)).json() as Record<string, unknown>;
    expect(as.code_challenge_methods_supported).toEqual(['S256']);
    expect(as.authorization_endpoint).toBe(`${ORIGIN}/authorize`);
  });

  it('MCP-01 (local): DCR client → PKCE consent with workspace choice → token → tools/list and tools/call; no purchase tools', async () => {
    const jar = await signedInUser(`mcp-${Date.now()}@example.test`);
    await call(jar, '/api/v1/workspaces', json({ name: 'MCP WS' }));
    const reg = await SELF.fetch(`${ORIGIN}/oauth/register`, json({ client_name: 'Test MCP client', redirect_uris: ['https://client.example/callback'], token_endpoint_auth_method: 'none' }));
    expect(reg.status).toBe(201);
    const client = await reg.json() as { client_id: string };
    const { verifier, challenge } = await pkce();
    const q = new URLSearchParams({ response_type: 'code', client_id: client.client_id, redirect_uri: 'https://client.example/callback', scope: 'sns:read sns:draft', state: 'st1', code_challenge: challenge, code_challenge_method: 'S256', resource: `${ORIGIN}/mcp` });
    const page = await call(jar, `/authorize?${q}`);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('MCP WS');
    expect(html).not.toMatch(/price|\$|checkout|upgrade|plan/i);
    const handle = /name="handle" value="([^"]+)"/.exec(html)![1]!;
    const wsId = /name="workspace_id"[^>]*><option value="([^"]+)"/.exec(html)![1]!;
    const form = new URLSearchParams({ handle, decision: 'approve', workspace_id: wsId });
    form.append('scope', 'sns:read');
    form.append('scope', 'sns:draft');
    const approve = await call(jar, '/authorize', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form.toString() });
    expect(approve.status).toBe(302);
    const loc = new URL(approve.headers.get('location')!);
    expect(loc.searchParams.get('state')).toBe('st1');
    const code = loc.searchParams.get('code')!;
    const tok = await SELF.fetch(`${ORIGIN}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: 'https://client.example/callback', client_id: client.client_id, code_verifier: verifier, resource: `${ORIGIN}/mcp` }).toString() });
    expect(tok.status).toBe(200);
    const { access_token } = await tok.json() as { access_token: string };
    const mcp = (body: unknown) => SELF.fetch(`${ORIGIN}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${access_token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify(body) });
    await mcp({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
    const list = await (await mcp({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).json() as { result: { tools: Array<{ name: string; annotations: Record<string, boolean> }> } };
    const names = list.result.tools.map((t) => t.name);
    expect(names).toHaveLength(17);
    expect(names.some((n) => /pay|checkout|purchase|plan|upgrade|billing/.test(n))).toBe(false);
    expect(list.result.tools.find((t) => t.name === 'cancel_schedule')!.annotations.destructiveHint).toBe(true);
    const status = await (await mcp({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_workspace_status', arguments: {} } })).json() as { result: { structuredContent: { status: string; workspace_id: string; result: { entitlement: { active: boolean } } } } };
    expect(status.result.structuredContent.workspace_id).toBe(wsId);
    expect(status.result.structuredContent.result.entitlement.active).toBe(false);
    expect(JSON.stringify(status)).not.toMatch(/https?:\/\/[^"]*(billing|checkout|pricing)/);
    // Schema validation happens server-side.
    const bad = await (await mcp({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'create_campaign_draft', arguments: { product_id: 'x' } } })).json() as { result: { isError: boolean } };
    expect(bad.result.isError).toBe(true);
    // Step-up: confirm_schedule needs sns:schedule, which this token lacks.
    const step = await mcp({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'confirm_schedule', arguments: { preview_token: 'x', confirmed: true, idempotency_key: 'k' } } });
    expect(step.status).toBe(403);
    expect(step.headers.get('www-authenticate')).toMatch(/insufficient_scope/);
    // Removing the membership revokes MCP access immediately.
    await testEnv.DB.prepare('DELETE FROM memberships WHERE workspace_id = ?').bind(wsId).run();
    const revoked = await mcp({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'get_workspace_status', arguments: {} } });
    expect(revoked.status).toBe(401);
  });
});
