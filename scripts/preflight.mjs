#!/usr/bin/env node
// Baseline preflight: toolchain, config sanity and which external
// integrations are configured (names only, never values).
import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const root = new URL('..', import.meta.url).pathname;
const results = [];
const check = (name, ok, detail = '') => results.push({ name, status: ok ? 'PASS' : 'FAIL', detail });

const major = Number(process.versions.node.split('.')[0]);
check('node >= 22', major >= 22, process.versions.node);
try {
  check('wrangler available', true, execSync('npx wrangler --version', { cwd: root, encoding: 'utf8' }).trim());
} catch {
  check('wrangler available', false);
}
const wrangler = readFileSync(`${root}wrangler.jsonc`, 'utf8');
check('no placeholder resource IDs in wrangler.jsonc', !/(database_id|id)"\s*:\s*"(xxx|placeholder|changeme|your-)/i.test(wrangler));
check('migrations present', existsSync(`${root}migrations/0001_auth.sql`) && existsSync(`${root}migrations/0002_core.sql`));
check('pricing contract matches handoff', readFileSync(`${root}packages/contracts/pricing.json`, 'utf8') === readFileSync(`${root}handoff/contracts/pricing.json`, 'utf8'));
check('MCP contract matches handoff', readFileSync(`${root}packages/contracts/mcp-tools.json`, 'utf8') === readFileSync(`${root}handoff/contracts/mcp-tools.json`, 'utf8'));

const env = existsSync(`${root}.dev.vars`) ? Object.fromEntries(readFileSync(`${root}.dev.vars`, 'utf8').split('\n').filter((l) => l.includes('=') && !l.startsWith('#')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)])) : {};
const groups = {
  core: ['BETTER_AUTH_SECRET', 'TOKEN_ENCRYPTION_KEY', 'SIGNING_KEY'],
  email: ['EMAIL_API_KEY'],
  stripe: ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'STRIPE_BASIC_PRICE_ID', 'STRIPE_STANDARD_PRICE_ID', 'STRIPE_PREMIUM_PRICE_ID', 'STRIPE_PRODUCT_ID'],
  linkedin: ['LINKEDIN_CLIENT_ID', 'LINKEDIN_CLIENT_SECRET'],
  meta: ['META_APP_ID', 'META_APP_SECRET'],
  tiktok: ['TIKTOK_CLIENT_KEY', 'TIKTOK_CLIENT_SECRET'],
  google: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'],
  research: ['RESEARCH_API_KEY', 'AI_PROVIDER_API_KEY'],
};
for (const [g, keys] of Object.entries(groups)) {
  const missing = keys.filter((k) => !env[k] && !process.env[k]);
  results.push({ name: `local config: ${g}`, status: missing.length ? 'BLOCKED' : 'PASS', detail: missing.length ? `missing ${missing.join(', ')}` : 'configured' });
}
for (const r of results) console.log(`${r.status.padEnd(8)} ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
process.exit(results.some((r) => r.status === 'FAIL') ? 1 : 0);
