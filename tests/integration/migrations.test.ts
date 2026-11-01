// Applies the real D1 migrations to SQLite (D1's engine) via node:sqlite and
// checks constraints on a populated database: tenant-linked FKs, quota CHECK,
// published-requires-receipt, ledger uniqueness and the batch guard.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const dir = new URL('../../migrations/', import.meta.url);
const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();

function db(upTo = files.length) {
  const d = new DatabaseSync(':memory:');
  d.exec('PRAGMA foreign_keys = ON');
  for (const f of files.slice(0, upTo)) d.exec(readFileSync(new URL(f, dir), 'utf8'));
  return d;
}
const T = '2026-11-01T00:00:00.000Z';

function seed(d: DatabaseSync, ws: string) {
  d.prepare('INSERT INTO workspaces(id, name, created_at, updated_at) VALUES (?,?,?,?)').run(ws, ws, T, T);
  d.prepare('INSERT INTO products(id, workspace_id, name, created_at, updated_at) VALUES (?,?,?,?,?)').run(`p_${ws}`, ws, 'P', T, T);
  d.prepare(`INSERT INTO connections(id, workspace_id, provider, provider_account_id, state, created_at, updated_at) VALUES (?,?,?,?,?,?,?)`).run(`c_${ws}`, ws, 'linkedin', 'acct', 'connected', T, T);
  d.prepare(`INSERT INTO quota_periods(id, workspace_id, source, starts_at, ends_at, allowance, created_at) VALUES (?,?,?,?,?,?,?)`).run(`q_${ws}`, ws, 'subscription', T, '2026-12-01T00:00:00.000Z', 1, T);
  d.prepare('INSERT INTO campaigns(id, workspace_id, product_id, goal, audience, language, created_at) VALUES (?,?,?,?,?,?,?)').run(`cm_${ws}`, ws, `p_${ws}`, 'g', 'a', 'en', T);
  d.prepare('INSERT INTO posts(id, workspace_id, campaign_id, created_at, updated_at) VALUES (?,?,?,?,?)').run(`po_${ws}`, ws, `cm_${ws}`, T, T);
  d.prepare(`INSERT INTO content_revisions(id, workspace_id, post_id, revision, position, platform, connection_id, format, content_hash, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`).run(`cr_${ws}`, ws, `po_${ws}`, 1, 0, 'linkedin', `c_${ws}`, 'text', 'h', T);
  d.prepare(`INSERT INTO schedules(id, workspace_id, preview_hash, created_via, created_at, updated_at) VALUES (?,?,?,?,?,?)`).run(`s_${ws}`, ws, 'h', 'web', T, T);
}
function target(d: DatabaseSync, ws: string, id: string, overrides: Partial<Record<string, string>> = {}) {
  const v = { product: `p_${ws}`, connection: `c_${ws}`, period: `q_${ws}`, status: 'scheduled', ...overrides };
  d.prepare(`INSERT INTO targets(id, workspace_id, schedule_id, post_id, revision, content_revision_id, product_id, connection_id, period_id, platform, format, status, due_at, local_time, timezone, utc_offset, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, ws, `s_${ws}`, `po_${ws}`, 1, `cr_${ws}`, v.product, v.connection, v.period, 'linkedin', 'text', v.status, T, 'x', 'UTC', '+00:00', T, T);
}

describe('D1 migrations on SQLite', () => {
  it('apply cleanly in order and record the schema version', () => {
    const d = db();
    expect((d.prepare(`SELECT value FROM schema_meta WHERE key = 'schema_version'`).get() as { value: string }).value).toBe('2');
  });

  it('upgrade from the auth-only schema keeps existing users (populated upgrade)', () => {
    const d = db(1);
    d.prepare(`INSERT INTO "user"(id, name, email, emailVerified, createdAt, updatedAt) VALUES (?,?,?,?,?,?)`).run('u1', 'A', 'a@x', 1, T, T);
    for (const f of files.slice(1)) d.exec(readFileSync(new URL(f, dir), 'utf8'));
    d.prepare('INSERT INTO identities(id, email, created_at) VALUES (?,?,?)').run('u1', 'a@x', T);
    expect((d.prepare('SELECT COUNT(*) AS n FROM "user"').get() as { n: number }).n).toBe(1);
  });

  it('prevents cross-tenant linkage through composite foreign keys', () => {
    const d = db();
    seed(d, 'a');
    seed(d, 'b');
    expect(() => target(d, 'a', 't1', { product: 'p_b' })).toThrow(/FOREIGN KEY/);
    expect(() => target(d, 'a', 't2', { connection: 'c_b' })).toThrow(/FOREIGN KEY/);
    expect(() => target(d, 'a', 't3', { period: 'q_b' })).toThrow(/FOREIGN KEY/);
    target(d, 'a', 't4');
  });

  it('enforces quota, receipts and single reservation per target', () => {
    const d = db();
    seed(d, 'a');
    target(d, 'a', 't1');
    expect(() => d.prepare(`UPDATE quota_periods SET reserved = 2 WHERE id = 'q_a'`).run()).toThrow(/CHECK/);
    expect(() => d.prepare(`UPDATE targets SET status = 'published' WHERE id = 't1'`).run()).toThrow(/CHECK/);
    d.prepare(`INSERT INTO quota_ledger(id, workspace_id, target_id, period_id, state, operation_key, created_at) VALUES ('l1','a','t1','q_a','reserved','k',?)`).run(T);
    expect(() => d.prepare(`INSERT INTO quota_ledger(id, workspace_id, target_id, period_id, state, operation_key, created_at) VALUES ('l2','a','t1','q_a','reserved','k',?)`).run(T)).toThrow(/UNIQUE/);
  });

  it('batch guard aborts when the preceding statement changed nothing', () => {
    const d = db();
    seed(d, 'a');
    d.prepare(`UPDATE products SET version = 2 WHERE id = 'p_a' AND version = 1`).run();
    expect(() => d.prepare('INSERT INTO batch_guards(ok) SELECT NULL WHERE changes() = 0').run()).not.toThrow();
    d.prepare(`UPDATE products SET version = 3 WHERE id = 'p_a' AND version = 1`).run();
    expect(() => d.prepare('INSERT INTO batch_guards(ok) SELECT NULL WHERE changes() = 0').run()).toThrow(/batch_guards/);
    expect((d.prepare('SELECT COUNT(*) AS n FROM batch_guards').get() as { n: number }).n).toBe(0);
  });
});
