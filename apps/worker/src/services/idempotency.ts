// Write tools/routes require idempotency keys. Same key + same payload returns
// the stored result; same key + different payload is a 409 conflict.
import { hashCanonical } from '@ayonix/domain';
import type { Env } from '../lib/env.js';
import { AppError } from '../lib/errors.js';
import { first, isConstraintError, run } from '../lib/db.js';
import { nowIso } from '../lib/ids.js';

export async function lookupIdempotent<T>(env: Env, workspaceId: string, operation: string, key: string, payload: unknown): Promise<{ hash: string; stored: T | null }> {
  if (!key || key.length > 128) throw new AppError('invalid_request', 'idempotency_key is required (max 128 characters)');
  const hash = await hashCanonical(payload);
  const row = await first<{ payload_hash: string; response_json: string }>(
    env,
    'SELECT payload_hash, response_json FROM idempotency_records WHERE workspace_id = ? AND operation = ? AND idempotency_key = ?',
    workspaceId, operation, key,
  );
  if (!row) return { hash, stored: null };
  if (row.payload_hash !== hash) throw new AppError('idempotency_conflict', 'This idempotency key was already used with different input.');
  return { hash, stored: JSON.parse(row.response_json) as T };
}

export function idempotencyInsert(env: Env, workspaceId: string, operation: string, key: string, hash: string, response: unknown) {
  return env.DB.prepare('INSERT INTO idempotency_records(workspace_id, operation, idempotency_key, payload_hash, response_json, created_at) VALUES (?,?,?,?,?,?)').bind(
    workspaceId, operation, key, hash, JSON.stringify(response), nowIso(),
  );
}

/** Generic wrapper for operations whose own writes are already atomic. */
export async function withIdempotency<T>(env: Env, workspaceId: string, operation: string, key: string, payload: unknown, exec: () => Promise<T>): Promise<T> {
  const { hash, stored } = await lookupIdempotent<T>(env, workspaceId, operation, key, payload);
  if (stored) return stored;
  const result = await exec();
  try {
    await run(env, 'INSERT INTO idempotency_records(workspace_id, operation, idempotency_key, payload_hash, response_json, created_at) VALUES (?,?,?,?,?,?)', workspaceId, operation, key, hash, JSON.stringify(result), nowIso());
  } catch (e) {
    if (!isConstraintError(e, 'UNIQUE')) throw e;
    // A concurrent duplicate stored first; return its result for consistency.
    const again = await lookupIdempotent<T>(env, workspaceId, operation, key, payload);
    if (again.stored) return again.stored;
  }
  return result;
}
