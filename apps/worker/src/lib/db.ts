import type { Env } from './env.js';

export type Row = Record<string, unknown>;

export async function first<T = Row>(env: Env, sql: string, ...binds: unknown[]): Promise<T | null> {
  return (await env.DB.prepare(sql).bind(...binds).first<T>()) ?? null;
}

export async function all<T = Row>(env: Env, sql: string, ...binds: unknown[]): Promise<T[]> {
  const r = await env.DB.prepare(sql).bind(...binds).all<T>();
  return r.results ?? [];
}

export async function run(env: Env, sql: string, ...binds: unknown[]): Promise<D1Result> {
  return env.DB.prepare(sql).bind(...binds).run();
}

export const stmt = (env: Env, sql: string, ...binds: unknown[]) => env.DB.prepare(sql).bind(...binds);

export function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string' || !value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

/** Opaque keyset cursor over (sort value, id). */
export function encodeCursor(sort: string, id: string): string {
  return btoa(JSON.stringify([sort, id])).replace(/=+$/, '');
}
export function decodeCursor(cursor: string | undefined | null): [string, string] | null {
  if (!cursor) return null;
  try {
    const v = JSON.parse(atob(cursor)) as unknown;
    if (Array.isArray(v) && v.length === 2 && typeof v[0] === 'string' && typeof v[1] === 'string') return [v[0], v[1]];
  } catch {
    /* fall through */
  }
  return null;
}

/** True when a D1 error is a constraint violation (CHECK/UNIQUE/FK). */
export function isConstraintError(e: unknown, kind?: 'CHECK' | 'UNIQUE' | 'FOREIGN KEY'): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  if (!/constraint failed|SQLITE_CONSTRAINT/i.test(msg)) return false;
  return kind ? msg.includes(kind) : true;
}

/**
 * Statement that aborts the enclosing D1 batch when the immediately preceding
 * statement changed no rows. D1 batches run in one transaction, so this turns
 * a conditional UPDATE into an all-or-nothing compare-and-swap.
 */
export const guardChanged = (env: Env) => env.DB.prepare('INSERT INTO batch_guards(ok) SELECT NULL WHERE changes() = 0');

export function isGuardError(e: unknown): boolean {
  return /batch_guards/.test(e instanceof Error ? e.message : String(e));
}

/** Run a batch, mapping a guard abort to the supplied error. */
export async function batchOrConflict(env: Env, statements: D1PreparedStatement[], onGuard: () => Error): Promise<D1Result[]> {
  try {
    return await env.DB.batch(statements);
  } catch (e) {
    if (isGuardError(e)) throw onGuard();
    throw e;
  }
}
