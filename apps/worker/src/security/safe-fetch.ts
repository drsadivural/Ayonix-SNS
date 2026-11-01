// Controlled remote ingestion: https only, no credentials in URL, no private
// or link-local targets, every redirect re-checked, strict size and time
// limits. global_fetch_strictly_public additionally prevents same-zone
// routing. Hostnames that are literal private IPs are rejected here; DNS
// rebinding to private ranges is blocked by the Workers runtime egress.
import { AppError } from '../lib/errors.js';

const PRIVATE_V4 = [
  /^10\./, /^127\./, /^0\./, /^169\.254\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, /^198\.1[89]\./, /^22[4-9]\./, /^2[3-5]\d\./,
];
const BLOCKED_HOSTS = /^(localhost|metadata\.google\.internal|metadata|instance-data)$|\.(local|internal|localhost|lan|home|corp)$/i;

export function assertPublicHttpsUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new AppError('invalid_request', 'Invalid URL');
  }
  if (url.protocol !== 'https:') throw new AppError('invalid_request', 'Only https URLs are accepted');
  if (url.username || url.password) throw new AppError('invalid_request', 'URLs with credentials are not accepted');
  if (url.port && url.port !== '443') throw new AppError('invalid_request', 'Non-standard ports are not accepted');
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (BLOCKED_HOSTS.test(host)) throw new AppError('invalid_request', 'Private hosts are not accepted');
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    if (PRIVATE_V4.some((r) => r.test(host)) || host === '255.255.255.255') throw new AppError('invalid_request', 'Private addresses are not accepted');
  }
  if (host.includes(':')) {
    if (host === '::1' || host === '::' || /^(fc|fd|fe8|fe9|fea|feb)/i.test(host) || host.startsWith('::ffff:')) {
      throw new AppError('invalid_request', 'Private addresses are not accepted');
    }
  }
  if (/^\d+$/.test(host) || /^0x/i.test(host)) throw new AppError('invalid_request', 'Numeric host forms are not accepted');
  return url;
}

export interface SafeFetchResult {
  bytes: Uint8Array;
  contentType: string | null;
  finalUrl: string;
}

export async function safeFetch(
  raw: string,
  opts: { maxBytes: number; timeoutMs?: number; maxRedirects?: number; accept?: string },
): Promise<SafeFetchResult> {
  let url = assertPublicHttpsUrl(raw);
  const deadline = Date.now() + (opts.timeoutMs ?? 20_000);
  for (let hop = 0; hop <= (opts.maxRedirects ?? 3); hop++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1, deadline - Date.now()));
    let res: Response;
    try {
      res = await fetch(url.toString(), {
        redirect: 'manual',
        signal: controller.signal,
        headers: { accept: opts.accept ?? '*/*', 'user-agent': 'Ayonix-SNS-Ingest/1.0' },
      });
    } catch {
      clearTimeout(timer);
      throw new AppError('upstream_error', 'The source could not be retrieved', { retryable: true });
    }
    if (res.status >= 300 && res.status < 400) {
      clearTimeout(timer);
      const loc = res.headers.get('location');
      if (!loc) throw new AppError('upstream_error', 'Redirect without location');
      url = assertPublicHttpsUrl(new URL(loc, url).toString());
      continue;
    }
    if (!res.ok || !res.body) {
      clearTimeout(timer);
      throw new AppError('upstream_error', `The source returned HTTP ${res.status}`, { retryable: res.status >= 500 });
    }
    const declared = Number(res.headers.get('content-length') ?? '0');
    if (declared > opts.maxBytes) {
      clearTimeout(timer);
      throw new AppError('unprocessable', `The source is larger than the ${Math.round(opts.maxBytes / 1024 / 1024)} MB limit`);
    }
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > opts.maxBytes) {
          await reader.cancel();
          throw new AppError('unprocessable', `The source is larger than the ${Math.round(opts.maxBytes / 1024 / 1024)} MB limit`);
        }
        chunks.push(value);
      }
    } finally {
      clearTimeout(timer);
    }
    const bytes = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
      bytes.set(c, off);
      off += c.byteLength;
    }
    return { bytes, contentType: res.headers.get('content-type'), finalUrl: url.toString() };
  }
  throw new AppError('upstream_error', 'Too many redirects');
}
