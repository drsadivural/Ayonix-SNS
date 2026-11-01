// Shared adapter plumbing on top of http.ts: provider-aware error
// re-classification, accepted non-2xx statuses (e.g. YouTube 308 Resume
// Incomplete), chunked stream reading, scope parsing and HMAC helpers.
// Every provider request still goes through call() for timeouts, redacted
// logging and network-error classification.
import type { CapabilityRow } from '@ayonix/contracts';
import { call } from './http.js';
import { ProviderError, type FetchLike, type Receipt } from './types.js';

export interface RequestOptions {
  provider: string;
  operation: string;
  correlationId: string;
  /** True when this call creates remote content (failures become 'ambiguous'). */
  creates?: boolean;
  timeoutMs?: number;
  /** Non-2xx statuses that are expected protocol responses and returned as-is. */
  accept?: number[];
  /** Provider-specific re-classification using the parsed error body. */
  classify?: Classifier;
}

export type Classifier = (err: ProviderError, body: unknown, status: number, creates: boolean) => ProviderError;

/**
 * call() wrapper. Captures the JSON error body (without logging it) so the
 * adapter can map provider error codes (Meta 190/4/17/32/613, Google
 * quotaExceeded, TikTok error.code) onto ProviderError kinds.
 */
export async function request(fetchImpl: FetchLike, url: string, init: RequestInit, opts: RequestOptions): Promise<Response> {
  let captured: { status: number; body: unknown } | null = null;
  let passthrough: Response | null = null;
  const accept = opts.accept ?? [];
  const wrapped: FetchLike = async (input, i) => {
    const res = await fetchImpl(input, i);
    if (!res.ok) {
      if (accept.includes(res.status)) {
        passthrough = res;
        return new Response(null, { status: 200 });
      }
      let body: unknown;
      try {
        body = await res.clone().json();
      } catch {
        body = null;
      }
      captured = { status: res.status, body };
    }
    return res;
  };
  try {
    const res = await call(wrapped, url, init, {
      creates: opts.creates ?? false,
      timeoutMs: opts.timeoutMs ?? 30_000,
      correlationId: opts.correlationId,
      provider: opts.provider,
      operation: opts.operation,
    });
    return passthrough ?? res;
  } catch (e) {
    const c = captured as { status: number; body: unknown } | null;
    if (e instanceof ProviderError && c && opts.classify) throw opts.classify(e, c.body, c.status, opts.creates ?? false);
    throw e;
  }
}

export function reclassify(err: ProviderError, kind: ProviderError['kind'], code?: string, retryAfter?: number | null): ProviderError {
  return new ProviderError(kind, code ?? err.code, err.message, retryAfter === undefined ? err.retryAfterSeconds : retryAfter, err.status);
}

export async function readJson<T>(res: Response): Promise<T> {
  const text = await res.text();
  if (!text) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ProviderError('ambiguous', 'invalid_response', 'The provider returned an unreadable response.');
  }
}

/** Splits provider scope strings (space- or comma-delimited). */
export function parseScopes(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.filter((s): s is string => typeof s === 'string' && s.length > 0);
  if (typeof raw !== 'string') return [];
  return [...new Set(raw.split(/[\s,]+/).filter(Boolean))];
}

export const cap = (capability: string, status: CapabilityRow['status'], detail: string | null = null): CapabilityRow => ({ capability, status, detail });

export function emptyReceipt(partial: Partial<Receipt> = {}): Receipt {
  return { remoteId: null, containerId: null, publishId: null, url: null, state: {}, ...partial };
}

export function requireConfig(value: string | undefined, name: string): string {
  if (!value) throw new ProviderError('capability', 'not_configured', `${name} is not configured for this deployment.`);
  return value;
}

export async function hmacSha256Hex(key: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const k = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(message)));
  return [...sig].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Reads a byte stream and yields consecutive chunks of exactly the given
 * sizes. Only one chunk is buffered at a time. Throws a validation error when
 * the stream length differs from the declared total.
 */
export async function* chunkStream(stream: ReadableStream<Uint8Array>, sizes: number[]): AsyncGenerator<Uint8Array> {
  const reader = stream.getReader();
  let pending: Uint8Array[] = [];
  let pendingLen = 0;
  let done = false;
  try {
    for (const size of sizes) {
      while (pendingLen < size && !done) {
        const r = await reader.read();
        if (r.done) done = true;
        else if (r.value.byteLength) {
          pending.push(r.value);
          pendingLen += r.value.byteLength;
        }
      }
      if (pendingLen < size) throw new ProviderError('validation', 'media_size_mismatch', 'The media file is shorter than its recorded size.');
      const out = new Uint8Array(size);
      let off = 0;
      const rest: Uint8Array[] = [];
      for (const part of pending) {
        if (off >= size) {
          rest.push(part);
          continue;
        }
        const take = Math.min(part.byteLength, size - off);
        out.set(part.subarray(0, take), off);
        off += take;
        if (take < part.byteLength) rest.push(part.subarray(take));
      }
      pending = rest;
      pendingLen -= size;
      yield out;
    }
    if (!done) {
      const r = await reader.read();
      if (!r.done && r.value.byteLength) throw new ProviderError('validation', 'media_size_mismatch', 'The media file is longer than its recorded size.');
    }
    if (pendingLen > 0) throw new ProviderError('validation', 'media_size_mismatch', 'The media file is longer than its recorded size.');
  } finally {
    reader.releaseLock();
  }
}

export const isBool = (v: unknown): v is boolean => typeof v === 'boolean';
export const asString = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : typeof v === 'number' ? String(v) : null);
export const utf16Len = (s: string) => s.length;
export const utf8Len = (s: string) => new TextEncoder().encode(s).byteLength;
export const isHttps = (u: string) => /^https:\/\//i.test(u);
