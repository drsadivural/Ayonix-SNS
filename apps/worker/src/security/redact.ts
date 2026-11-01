// Structured logging with redaction. Tokens, auth headers, signed URLs,
// captions and card data never reach logs.
const SECRET_KEYS = /token|secret|authorization|password|cookie|signature|caption|api[_-]?key|code_verifier|client_secret|card|cvc|iban/i;
const URL_QUERY = /([?&](?:access_token|token|signature|sig|X-Amz-[A-Za-z-]+|code|state|client_secret)=)[^&\s"]+/gi;
const BEARER = /Bearer\s+[A-Za-z0-9._~+/=-]+/g;

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[depth]';
  if (typeof value === 'string') return value.replace(BEARER, 'Bearer [redacted]').replace(URL_QUERY, '$1[redacted]');
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = SECRET_KEYS.test(k) ? '[redacted]' : redact(v, depth + 1);
    return out;
  }
  return value;
}

export function log(level: 'info' | 'warn' | 'error', event: string, fields: Record<string, unknown> = {}) {
  const line = JSON.stringify({ level, event, ts: new Date().toISOString(), ...(redact(fields) as object) });
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  // eslint-disable-next-line no-console
  else console.log(line);
}

/** Provider error text shown to users: bounded and stripped of identifiers. */
export function safeProviderMessage(message: string | undefined | null): string {
  if (!message) return 'The provider returned an error.';
  return String(redact(message)).replace(/\s+/g, ' ').slice(0, 300);
}
