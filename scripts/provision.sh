#!/usr/bin/env bash
# Provision and first-deploy Ayonix-SNS on Cloudflare: scripts/provision.sh <staging|production>
# Requires `wrangler login` (or CLOUDFLARE_API_TOKEN with Workers/D1/R2/KV/Queues
# edit scope and Workers Routes edit on the zone). D1, R2 and KV are
# auto-provisioned by `wrangler deploy`; queues are created explicitly here.
#
# BETTER_AUTH_SECRET, TOKEN_ENCRYPTION_KEY and SIGNING_KEY are generated once
# into ~/.ayonix-sns/<env>-secrets.json (mode 600, never printed) and uploaded
# with the deploy. Keep that file: it is the only copy of the token key.
# EMAIL_API_KEY and integration keys are set afterwards by the operator with
# `npx wrangler secret put <NAME> --env <env>` (prompted, never echoed).
set -euo pipefail
ENV=${1:?usage: provision.sh <staging|production>}
PREFIX=$([ "$ENV" = production ] && echo ayonix-sns || echo "ayonix-sns-$ENV")
SECRETS="$HOME/.ayonix-sns/$ENV-secrets.json"

for q in "$PREFIX-publish" "$PREFIX-publish-dlq" "$PREFIX-jobs" "$PREFIX-jobs-dlq"; do
  npx wrangler queues create "$q" || echo "queue $q exists"
done

if [ ! -f "$SECRETS" ]; then
  mkdir -p "$(dirname "$SECRETS")" && chmod 700 "$(dirname "$SECRETS")"
  (umask 077 && node -e "
    const { randomBytes } = require('node:crypto');
    process.stdout.write(JSON.stringify({
      BETTER_AUTH_SECRET: randomBytes(32).toString('base64url'),
      TOKEN_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
      SIGNING_KEY: randomBytes(32).toString('base64url'),
    }));" > "$SECRETS")
  echo "Generated $SECRETS (values not shown)."
fi

npm run build -w @ayonix/web
npx wrangler deploy --env "$ENV" --secrets-file "$SECRETS"
npx wrangler d1 migrations apply DB --env "$ENV" --remote
echo "Next: npx wrangler secret put EMAIL_API_KEY --env $ENV"
