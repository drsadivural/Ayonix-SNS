#!/usr/bin/env bash
# Production release (run only with operator authorization).
# 1) verify  2) backup  3) migrate (forward-compatible)  4) deploy  5) smoke.
set -euo pipefail
# Backups contain user data: keep them private to this user.
umask 077
ENV=${1:?usage: release.sh <staging|production>}
# The top-level wrangler config is local development; always pass the environment.
WENV="--env $ENV"
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
mkdir -p evidence/private/backups
npm ci
npm run typecheck && npm run lint && npm test
npm run build -w @ayonix/web
echo "Backing up D1 before migrating…"
npx wrangler d1 export DB $WENV --remote --output "evidence/private/backups/d1-$ENV-$STAMP.sql"
npx wrangler deployments list $WENV | head -20 > "evidence/private/backups/deployments-$ENV-$STAMP.txt"
npx wrangler d1 migrations apply DB $WENV --remote
npx wrangler deploy $WENV
echo "Rollback: npx wrangler rollback $WENV  (schema migrations are forward-compatible; restore data with scripts/restore.sh only into an isolated database first)"
