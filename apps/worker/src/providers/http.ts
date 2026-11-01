// Shared HTTP helpers for adapters: timeouts, Retry-After, error mapping and
// redacted diagnostics. Adapters decide whether a failure after a create call
// is 'ambiguous' (may exist remotely) — this helper only classifies status.
import { log, safeProviderMessage } from '../security/redact.js';
import { ProviderError, type FetchLike, type ProviderErrorKind } from './types.js';

export function retryAfterSeconds(res: Response): number | null {
  const h = res.headers.get('retry-after');
  if (!h) return null;
  const n = Number(h);
  if (Number.isFinite(n)) return Math.max(0, Math.ceil(n));
  const t = Date.parse(h);
  return Number.isFinite(t) ? Math.max(0, Math.ceil((t - Date.now()) / 1000)) : null;
}

export interface CallOptions {
  /** True when this call creates remote content; failures after sending become 'ambiguous'. */
  creates?: boolean;
  timeoutMs?: number;
  correlationId: string;
  provider: string;
  operation: string;
}

/**
 * Perform a provider request. Throws ProviderError with a classified kind.
 * Never logs bodies, tokens or URLs with credentials.
 */
export async function call(fetchImpl: FetchLike, url: string, init: RequestInit, opts: CallOptions): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 30_000);
  let res: Response;
  try {
    res = await fetchImpl(url, { ...init, signal: controller.signal });
  } catch (e) {
    clearTimeout(timer);
    const aborted = e instanceof Error && e.name === 'AbortError';
    log('warn', 'provider.network_error', { provider: opts.provider, operation: opts.operation, correlation_id: opts.correlationId, aborted });
    // A timeout on a create call may have reached the provider.
    throw new ProviderError(opts.creates ? 'ambiguous' : 'transient', aborted ? 'timeout' : 'network_error', aborted ? 'The provider did not respond in time.' : 'The provider could not be reached.');
  }
  clearTimeout(timer);
  log('info', 'provider.response', { provider: opts.provider, operation: opts.operation, status: res.status, correlation_id: opts.correlationId });
  if (res.ok) return res;
  throw await toProviderError(res, opts);
}

export async function toProviderError(res: Response, opts: Pick<CallOptions, 'creates' | 'provider' | 'operation'>): Promise<ProviderError> {
  let message = `HTTP ${res.status}`;
  let code = `http_${res.status}`;
  try {
    const body = (await res.clone().json()) as Record<string, unknown>;
    const err = (body.error ?? body) as Record<string, unknown>;
    const m = err.message ?? err.error_description ?? body.message ?? body.error_description;
    if (typeof m === 'string') message = m;
    const c = err.code ?? err.error_subcode ?? body.serviceErrorCode ?? (typeof body.error === 'string' ? body.error : undefined);
    if (typeof c === 'string' || typeof c === 'number') code = String(c);
  } catch {
    /* non-JSON error body */
  }
  let kind: ProviderErrorKind;
  if (res.status === 429) kind = 'rate_limited';
  else if (res.status === 401) kind = 'reconnect_required';
  else if (res.status === 403) kind = 'capability';
  else if (res.status >= 500) kind = opts.creates ? 'ambiguous' : 'transient';
  else kind = 'validation';
  return new ProviderError(kind, code, safeProviderMessage(message), retryAfterSeconds(res), res.status);
}

export async function json<T>(res: Response): Promise<T> {
  try {
    return (await res.json()) as T;
  } catch {
    throw new ProviderError('ambiguous', 'invalid_response', 'The provider returned an unreadable response.');
  }
}

export function form(data: Record<string, string>): URLSearchParams {
  return new URLSearchParams(data);
}

export const iso = (secondsFromNow: number | null | undefined) =>
  typeof secondsFromNow === 'number' && Number.isFinite(secondsFromNow) ? new Date(Date.now() + secondsFromNow * 1000).toISOString() : null;
