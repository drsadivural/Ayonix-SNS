// Thin fetch wrapper for /api/v1. Cookies are HttpOnly and same-origin; the
// selected workspace travels in x-workspace-id (the Worker re-validates it
// against the caller's membership). Errors keep the server envelope so the
// UI can show the real message and request id.
import type { ApiError } from '@ayonix/contracts';

export type ApiErrorBody = ApiError['error'] & { details?: Record<string, unknown> };

export class ApiRequestError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId: string | null;
  readonly fieldErrors: Record<string, string>;
  readonly retryable: boolean;
  readonly retryAfterSeconds: number | null;
  readonly currentVersion: number | null;
  readonly details: Record<string, unknown>;

  constructor(status: number, body: Partial<ApiErrorBody> & { message: string; code: string }) {
    super(body.message);
    this.name = 'ApiRequestError';
    this.status = status;
    this.code = body.code;
    this.requestId = body.request_id ?? null;
    this.fieldErrors = body.field_errors ?? {};
    this.retryable = body.retryable ?? false;
    this.retryAfterSeconds = body.retry_after_seconds ?? null;
    this.currentVersion = body.current_version ?? null;
    this.details = body.details ?? {};
  }

  get isNetwork(): boolean {
    return this.status === 0;
  }
}

let currentWorkspace: string | null = null;

export function setApiWorkspace(id: string | null): void {
  currentWorkspace = id;
}

export function getApiWorkspace(): string | null {
  return currentWorkspace;
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  signal?: AbortSignal;
  /** Override the workspace header (e.g. right after creating a workspace). */
  workspaceId?: string | null;
}

export async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const method = options.method ?? 'GET';
  const headers: Record<string, string> = { accept: 'application/json' };
  const ws = options.workspaceId === undefined ? currentWorkspace : options.workspaceId;
  if (ws) headers['x-workspace-id'] = ws;
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  let res: Response;
  try {
    res = await fetch(`/api/v1${path}`, {
      method,
      headers,
      credentials: 'same-origin',
      body: options.body === undefined ? null : JSON.stringify(options.body),
      signal: options.signal ?? null,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    throw new ApiRequestError(0, {
      code: 'network',
      message: 'Ayonix could not be reached. Check your connection and try again.',
      retryable: true,
    });
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
  }
  if (!res.ok) {
    const body = (parsed as Partial<ApiError> | null)?.error;
    if (body && typeof body.message === 'string') {
      throw new ApiRequestError(res.status, body as ApiErrorBody);
    }
    throw new ApiRequestError(res.status, {
      code: res.status >= 500 ? 'internal' : 'http_error',
      message: res.status >= 500 ? 'Something went wrong on the server. Try again.' : `The request failed (HTTP ${res.status}).`,
      request_id: res.headers.get('x-request-id') ?? '',
      retryable: res.status >= 500,
    });
  }
  return parsed as T;
}

export function isApiError(e: unknown): e is ApiRequestError {
  return e instanceof ApiRequestError;
}

export function toApiError(e: unknown): ApiRequestError {
  if (e instanceof ApiRequestError) return e;
  return new ApiRequestError(0, { code: 'client_error', message: e instanceof Error ? e.message : 'Something went wrong.' });
}

/** Build a query string, dropping empty values. */
export function qs(params: Record<string, string | number | undefined | null | false>): string {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === false || v === '') continue;
    u.set(k, String(v));
  }
  const s = u.toString();
  return s ? `?${s}` : '';
}

export interface UploadInstruction {
  upload_url: string;
  method: 'PUT';
  headers: Record<string, string>;
}

/** PUT a file to a signed upload URL with progress (fetch has no upload progress). */
export function uploadWithProgress(target: UploadInstruction, file: File, onProgress: (fraction: number) => void, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(target.method, target.upload_url);
    for (const [k, v] of Object.entries(target.headers)) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress(1);
        resolve();
        return;
      }
      let body: Partial<ApiErrorBody> | undefined;
      try {
        body = (JSON.parse(xhr.responseText) as Partial<ApiError>).error;
      } catch {
        body = undefined;
      }
      reject(
        new ApiRequestError(xhr.status, {
          code: body?.code ?? 'upload_failed',
          message: body?.message ?? `Upload failed (HTTP ${xhr.status}).`,
          request_id: body?.request_id ?? xhr.getResponseHeader('x-request-id') ?? '',
          retryable: xhr.status >= 500,
        }),
      );
    };
    xhr.onerror = () => reject(new ApiRequestError(0, { code: 'network', message: 'The upload was interrupted. Check your connection and try again.', retryable: true }));
    xhr.onabort = () => reject(new DOMException('Upload canceled', 'AbortError'));
    signal?.addEventListener('abort', () => xhr.abort(), { once: true });
    xhr.send(file);
  });
}
