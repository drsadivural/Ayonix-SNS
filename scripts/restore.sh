#!/usr/bin/env bash
# Restore exercise: import a D1 export into an ISOLATED database and verify
# row counts and tenant constraints. Never restores over production.
set -euo pipefail
BACKUP=${1:?usage: restore.sh <backup.sql> [isolated-db-name]}
NAME=${2:-ayonix-sns-restore-check}
npx wrangler d1 create "$NAME" || true
npx wrangler d1 execute "$NAME" --remote --file "$BACKUP"
for t in workspaces memberships targets quota_ledger provider_receipts subscriptions; do
  npx wrangler d1 execute "$NAME" --remote --command "SELECT '$t' AS t, COUNT(*) AS n FROM $t" --json
done
npx wrangler d1 execute "$NAME" --remote --command "PRAGMA foreign_key_check" --json
npx wrangler d1 execute "$NAME" --remote --command "SELECT COUNT(*) AS bad FROM quota_periods WHERE used + reserved > allowance" --json
echo "Verify decryption of a sample credential with the production key version before declaring restore PASS."
