#!/usr/bin/env bash
# Provision Ayonix-SNS staging on Cloudflare. Requires `wrangler login` (or
# CLOUDFLARE_API_TOKEN with Workers/D1/R2/KV/Queues edit scope) and an
# operator decision on the domain. D1, R2 and KV are auto-provisioned by
# `wrangler deploy`; queues are created explicitly here.
set -euo pipefail
ENV=staging
for q in ayonix-sns-staging-publish ayonix-sns-staging-publish-dlq ayonix-sns-staging-jobs ayonix-sns-staging-jobs-dlq; do
  npx wrangler queues create "$q" || echo "queue $q exists"
done
echo "Set secrets (you will be prompted; values are never echoed):"
for s in BETTER_AUTH_SECRET TOKEN_ENCRYPTION_KEY SIGNING_KEY EMAIL_API_KEY; do
  npx wrangler secret put "$s" --env "$ENV"
done
echo "Optional integrations: run 'npx wrangler secret put <NAME> --env $ENV' for STRIPE_*, LINKEDIN_*, META_*, TIKTOK_*, GOOGLE_*, RESEARCH_API_KEY, AI_PROVIDER_API_KEY."
npm run build -w @ayonix/web
npx wrangler deploy --env "$ENV"
npx wrangler d1 migrations apply DB --env "$ENV" --remote
node scripts/verify-live.mjs "$(node -e "const c=require('fs').readFileSync('wrangler.jsonc','utf8');console.log(/\"staging\"[\s\S]*?\"APP_ORIGIN\":\s*\"([^\"]+)\"/.exec(c)[1])")"
