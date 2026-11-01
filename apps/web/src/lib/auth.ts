// Website authentication (Better Auth, mounted by the Worker at /api/auth).
// Session cookies are HttpOnly; the client only calls the auth endpoints.
import { createAuthClient } from 'better-auth/react';

export const authClient = createAuthClient({
  baseURL: typeof window === 'undefined' ? 'http://localhost' : window.location.origin,
  basePath: '/api/auth',
  fetchOptions: { credentials: 'same-origin' },
});

export interface AuthFailure {
  message: string;
  code: string | null;
  status: number;
}

/** Normalise Better Auth's `{ error }` result into a user-facing failure. */
export function authFailure(error: { message?: string | undefined; code?: string | undefined; status?: number | undefined; statusText?: string | undefined } | null | undefined): AuthFailure {
  const status = error?.status ?? 0;
  const code = error?.code ?? null;
  let message = error?.message || error?.statusText || 'Something went wrong. Try again.';
  if (status === 0) message = 'Ayonix could not be reached. Check your connection and try again.';
  else if (status === 429) message = 'Too many attempts. Wait a minute and try again.';
  else if (status >= 500) message = 'The server could not complete this request. This can happen when an email cannot be sent. Try again in a moment.';
  return { message, code, status };
}
