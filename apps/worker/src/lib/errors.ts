import type { ApiError } from '@ayonix/contracts';

export type ErrorCode =
  | 'invalid_request'
  | 'unauthenticated'
  | 'forbidden'
  | 'entitlement_required'
  | 'not_found'
  | 'conflict'
  | 'version_conflict'
  | 'idempotency_conflict'
  | 'unprocessable'
  | 'quota_exceeded'
  | 'rate_limited'
  | 'upstream_error'
  | 'unavailable'
  | 'not_configured'
  | 'internal';

const STATUS: Record<ErrorCode, number> = {
  invalid_request: 400,
  unauthenticated: 401,
  forbidden: 403,
  entitlement_required: 403,
  not_found: 404,
  conflict: 409,
  version_conflict: 409,
  idempotency_conflict: 409,
  unprocessable: 422,
  quota_exceeded: 422,
  rate_limited: 429,
  upstream_error: 502,
  unavailable: 503,
  not_configured: 503,
  internal: 500,
};

/** Application error carrying a safe, user-facing message only. */
export class AppError extends Error {
  readonly status: number;
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly extra: {
      field_errors?: Record<string, string>;
      retryable?: boolean;
      retry_after_seconds?: number;
      current_version?: number;
      details?: Record<string, unknown>;
    } = {},
  ) {
    super(message);
    this.name = 'AppError';
    this.status = STATUS[code];
  }
}

export const notFound = (what = 'Resource') => new AppError('not_found', `${what} not found`);
export const forbidden = (message = 'You do not have permission for this action') => new AppError('forbidden', message);
export const invalid = (message: string, field_errors?: Record<string, string>) =>
  new AppError('invalid_request', message, field_errors ? { field_errors } : {});

export function toErrorBody(err: AppError, requestId: string): ApiError {
  return {
    error: {
      code: err.code,
      message: err.message,
      request_id: requestId,
      retryable: err.extra.retryable ?? (err.status >= 500 || err.status === 429),
      ...(err.extra.field_errors ? { field_errors: err.extra.field_errors } : {}),
      ...(err.extra.retry_after_seconds !== undefined ? { retry_after_seconds: err.extra.retry_after_seconds } : {}),
      ...(err.extra.current_version !== undefined ? { current_version: err.extra.current_version } : {}),
      ...(err.extra.details ? { details: err.extra.details } : {}),
    },
  } as ApiError;
}
