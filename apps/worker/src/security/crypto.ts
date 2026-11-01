// Token envelope encryption (AES-256-GCM, random 96-bit IV, versioned key,
// tenant/connection bound AAD) and HMAC signing for short-lived handoffs.
import type { Env } from '../lib/env.js';
import { AppError } from '../lib/errors.js';

const enc = new TextEncoder();
const dec = new TextDecoder();

export function b64(bytes: ArrayBuffer | Uint8Array): string {
  const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s);
}
export function unb64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
export const b64url = (bytes: ArrayBuffer | Uint8Array) => b64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export function unb64url(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  return unb64(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
}

const keyCache = new Map<string, CryptoKey>();

async function aesKey(raw: string): Promise<CryptoKey> {
  let k = keyCache.get(raw);
  if (!k) {
    k = await crypto.subtle.importKey('raw', unb64(raw) as BufferSource, 'AES-GCM', false, ['encrypt', 'decrypt']);
    keyCache.set(raw, k);
  }
  return k;
}

function keyFor(env: Env, version: number): string {
  const current = Number(env.TOKEN_ENCRYPTION_KEY_VERSION ?? '1');
  if (version === current) {
    if (!env.TOKEN_ENCRYPTION_KEY) throw new AppError('not_configured', 'Token encryption is not configured');
    return env.TOKEN_ENCRYPTION_KEY;
  }
  const previous = env.TOKEN_ENCRYPTION_PREVIOUS_KEYS ? (JSON.parse(env.TOKEN_ENCRYPTION_PREVIOUS_KEYS) as Record<string, string>) : {};
  const k = previous[String(version)];
  if (!k) throw new AppError('internal', 'Credential key version unavailable');
  return k;
}

export interface Sealed {
  ciphertext: string;
  nonce: string;
  key_version: number;
}

export async function seal(env: Env, plaintext: string, aad: string): Promise<Sealed> {
  const version = Number(env.TOKEN_ENCRYPTION_KEY_VERSION ?? '1');
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await aesKey(keyFor(env, version));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(aad) }, key, enc.encode(plaintext));
  return { ciphertext: b64(ct), nonce: b64(iv), key_version: version };
}

export async function open(env: Env, sealed: Sealed, aad: string): Promise<string> {
  const key = await aesKey(keyFor(env, sealed.key_version));
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: unb64(sealed.nonce) as BufferSource, additionalData: enc.encode(aad) },
    key,
    unb64(sealed.ciphertext) as BufferSource,
  );
  return dec.decode(pt);
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  const cacheKey = `hmac:${secret}`;
  let k = keyCache.get(cacheKey);
  if (!k) {
    k = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
    keyCache.set(cacheKey, k);
  }
  return k;
}

export async function hmacHex(secret: string, data: string): Promise<string> {
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(data));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Compact signed token: base64url(json).base64url(hmac). `purpose` is mixed
 * into the MAC so a token minted for one flow cannot be replayed in another.
 */
export async function signToken(env: Env, purpose: string, payload: Record<string, unknown>, ttlSeconds: number): Promise<{ token: string; expires_at: string }> {
  if (!env.SIGNING_KEY) throw new AppError('not_configured', 'Signing is not configured');
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const body = b64url(enc.encode(JSON.stringify({ ...payload, purpose, exp })));
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(env.SIGNING_KEY), enc.encode(`${purpose}.${body}`));
  return { token: `${body}.${b64url(sig)}`, expires_at: new Date(exp * 1000).toISOString() };
}

export async function verifyToken<T extends Record<string, unknown>>(env: Env, purpose: string, token: string): Promise<T> {
  if (!env.SIGNING_KEY) throw new AppError('not_configured', 'Signing is not configured');
  if (typeof token !== 'string') throw new AppError('invalid_request', 'Token required');
  const [body, sig] = token.split('.');
  if (!body || !sig) throw new AppError('invalid_request', 'Malformed token');
  const ok = await crypto.subtle.verify('HMAC', await hmacKey(env.SIGNING_KEY), unb64url(sig) as BufferSource, enc.encode(`${purpose}.${body}`));
  if (!ok) throw new AppError('invalid_request', 'Token signature is invalid');
  const payload = JSON.parse(dec.decode(unb64url(body))) as T & { purpose: string; exp: number };
  if (payload.purpose !== purpose) throw new AppError('invalid_request', 'Token purpose mismatch');
  if (payload.exp * 1000 < Date.now()) throw new AppError('conflict', 'This approval has expired. Preview again.');
  return payload;
}

export async function pkcePair(): Promise<{ verifier: string; challenge: string }> {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(await crypto.subtle.digest('SHA-256', enc.encode(verifier)));
  return { verifier, challenge };
}
