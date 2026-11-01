// CONTRACT TEST with a fetch double. Not live provider evidence (docs/10-ACCEPTANCE.md).
// Shared fetch double and fixtures for provider adapter contract tests.
import { vi } from 'vitest';
import type { Platform, PostFormat } from '@ayonix/contracts';
import type { Env } from '../../../apps/worker/src/lib/env.js';
import type { ConnectionRecord, FetchLike, MediaItem, ProviderContext, PublishContent } from '../../../apps/worker/src/providers/types.js';

export interface Recorded {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string | null;
  bodyBytes: number;
}

type Reply = Response | 'timeout' | 'network';
export interface Route {
  method?: string;
  match: string | RegExp;
  reply: (req: Recorded) => Reply | Promise<Reply>;
  /** Number of times this route may answer (default unlimited). */
  times?: number;
}

export function fetchDouble(routes: Route[]) {
  const calls: Recorded[] = [];
  const remaining = routes.map((r) => r.times ?? Infinity);
  const fetch: FetchLike = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers: Record<string, string> = {};
    new Headers(init?.headers ?? {}).forEach((v, k) => (headers[k] = v));
    let body: string | null = null;
    let bodyBytes = 0;
    const b = init?.body;
    if (typeof b === 'string') body = b;
    else if (b instanceof URLSearchParams) body = b.toString();
    else if (b instanceof Uint8Array) bodyBytes = b.byteLength;
    else if (b instanceof ArrayBuffer) bodyBytes = b.byteLength;
    const rec: Recorded = { method, url, headers, body, bodyBytes };
    calls.push(rec);
    const idx = routes.findIndex((r, i) => remaining[i]! > 0 && (!r.method || r.method === method) && (typeof r.match === 'string' ? url.includes(r.match) : r.match.test(url)));
    if (idx < 0) throw new Error(`fetch double: no route for ${method} ${url}`);
    remaining[idx]!--;
    const out = await routes[idx]!.reply(rec);
    if (out === 'timeout') throw new DOMException('The operation was aborted.', 'AbortError');
    if (out === 'network') throw new TypeError('fetch failed');
    return out;
  };
  return { fetch, calls };
}

export const json = (data: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...headers } });
export const empty = (status = 200, headers: Record<string, string> = {}) => new Response(null, { status, headers });

export const env = {
  APP_ORIGIN: 'https://app.example.test',
  ENVIRONMENT: 'test',
  LINKEDIN_CLIENT_ID: 'li-client',
  LINKEDIN_CLIENT_SECRET: 'li-secret',
  LINKEDIN_API_VERSION: '202610',
  META_APP_ID: 'meta-app',
  META_APP_SECRET: 'meta-secret',
  META_GRAPH_VERSION: 'v26.0',
  TIKTOK_CLIENT_KEY: 'tt-key',
  TIKTOK_CLIENT_SECRET: 'tt-secret',
  GOOGLE_CLIENT_ID: 'g-client',
  GOOGLE_CLIENT_SECRET: 'g-secret',
} as unknown as Env;

export function connection(provider: Platform, over: Partial<ConnectionRecord> = {}): ConnectionRecord {
  return {
    id: 'conn_1',
    workspace_id: 'ws_1',
    provider,
    provider_account_id: 'acct_1',
    account_name: 'Account',
    account_type: 'member',
    granted_scopes: [],
    api_version: null,
    metadata: {},
    ...over,
  };
}

export function ctx(provider: Platform, fetch: FetchLike, over: Partial<ConnectionRecord> = {}, tokens: Partial<ProviderContext['tokens']> = {}): ProviderContext {
  return {
    env,
    connection: connection(provider, over),
    tokens: { access: 'USER_TOKEN', refresh: null, account: null, expiresAt: null, ...tokens },
    correlationId: 'corr_1',
    fetch,
  };
}

export function media(over: Partial<Omit<MediaItem, 'open'>> & { fill?: number } = {}): MediaItem {
  const bytes = over.bytes ?? 16;
  const data = new Uint8Array(bytes).fill(over.fill ?? 7);
  return {
    assetId: 'asset_1',
    mime: 'image/jpeg',
    width: 1080,
    height: 1080,
    durationMs: null,
    filename: 'file.bin',
    publicUrl: 'https://media.example.test/signed/asset_1',
    ...over,
    bytes,
    open: async () =>
      new ReadableStream<Uint8Array>({
        start(c) {
          // two pieces to exercise re-chunking
          const mid = Math.floor(bytes / 2);
          if (mid) c.enqueue(data.subarray(0, mid));
          c.enqueue(data.subarray(mid));
          c.close();
        },
      }),
  };
}

export function content(format: PostFormat, over: Partial<PublishContent> = {}): PublishContent {
  return { format, caption: 'Hello world', title: null, linkUrl: null, options: {}, media: [], publishAt: null, ...over };
}

export const form = (body: string | null) => Object.fromEntries(new URLSearchParams(body ?? ''));

export function quietLogs() {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
}
