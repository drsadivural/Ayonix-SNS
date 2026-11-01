#!/usr/bin/env node
// Deployed smoke checks (no secrets needed): health, OAuth discovery, MCP
// challenge, security headers. Usage: node scripts/verify-live.mjs https://staging.sns.ayonix.com
const origin = process.argv[2];
if (!origin?.startsWith('https://')) {
  console.error('Usage: verify-live.mjs https://<origin>');
  process.exit(2);
}
const results = [];
async function step(name, fn) {
  try {
    const detail = await fn();
    results.push({ name, status: 'PASS', detail });
  } catch (e) {
    results.push({ name, status: 'FAIL', detail: e.message });
  }
}
const must = (cond, msg) => {
  if (!cond) throw new Error(msg);
};
await step('health/live', async () => {
  const r = await fetch(`${origin}/health/live`);
  must(r.ok, `HTTP ${r.status}`);
  return 'ok';
});
await step('health/ready', async () => {
  const r = await fetch(`${origin}/health/ready`);
  const b = await r.json();
  must(r.ok, JSON.stringify(b));
  return JSON.stringify(b.checks);
});
await step('protected resource metadata', async () => {
  const b = await (await fetch(`${origin}/.well-known/oauth-protected-resource/mcp`)).json();
  must(b.resource === `${origin}/mcp`, `resource=${b.resource}`);
  return b.scopes_supported?.join(' ');
});
await step('authorization server metadata', async () => {
  const b = await (await fetch(`${origin}/.well-known/oauth-authorization-server`)).json();
  must(b.code_challenge_methods_supported?.includes('S256'), 'S256 missing');
  return `cimd=${b.client_id_metadata_document_supported}`;
});
await step('MCP 401 challenge', async () => {
  const r = await fetch(`${origin}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' });
  must(r.status === 401 && /resource_metadata/.test(r.headers.get('www-authenticate') ?? ''), `HTTP ${r.status}`);
  return 'ok';
});
await step('security headers on app shell', async () => {
  const r = await fetch(`${origin}/`);
  must(r.headers.get('x-content-type-options') === 'nosniff', 'nosniff missing');
  must(/frame-ancestors 'none'/.test(r.headers.get('content-security-policy') ?? ''), 'CSP missing');
  return 'ok';
});
await step('stripe webhook rejects unsigned', async () => {
  const r = await fetch(`${origin}/webhooks/stripe`, { method: 'POST', body: '{}' });
  must(r.status === 400 || r.status === 503, `HTTP ${r.status}`);
  return `HTTP ${r.status}`;
});
for (const r of results) console.log(`${r.status} ${r.name} — ${r.detail}`);
console.log(JSON.stringify({ origin, at: new Date().toISOString(), results }, null, 2));
process.exit(results.some((r) => r.status === 'FAIL') ? 1 : 0);
