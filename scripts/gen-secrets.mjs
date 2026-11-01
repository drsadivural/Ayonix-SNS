#!/usr/bin/env node
// Generates local development secrets into .dev.vars (gitignored). Values are
// never printed. For staging/production use `wrangler secret put` instead.
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const target = new URL('../.dev.vars', import.meta.url);
if (existsSync(target)) {
  console.error('.dev.vars already exists; refusing to overwrite. Delete it first to regenerate.');
  process.exit(1);
}
const template = readFileSync(new URL('../.dev.vars.example', import.meta.url), 'utf8');
const values = {
  BETTER_AUTH_SECRET: randomBytes(32).toString('base64url'),
  TOKEN_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
  SIGNING_KEY: randomBytes(32).toString('base64url'),
};
const out = template.replace(/^(BETTER_AUTH_SECRET|TOKEN_ENCRYPTION_KEY|SIGNING_KEY)=$/gm, (_, k) => `${k}=${values[k]}`);
writeFileSync(target, out, { mode: 0o600 });
console.log('Wrote .dev.vars with fresh BETTER_AUTH_SECRET, TOKEN_ENCRYPTION_KEY and SIGNING_KEY (values not shown).');
