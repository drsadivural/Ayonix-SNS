// Common adapter contract for the five networks (docs/04-PROVIDERS.md).
// Adapters talk to official APIs only. They never fabricate IDs, metrics or
// success; unsupported operations raise structured ProviderError values.
import type { CapabilityRow, Platform, PostFormat } from '@ayonix/contracts';
import type { Env } from '../lib/env.js';

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface TokenSet {
  accessToken: string;
  refreshToken?: string | null;
  /** ISO time the access token expires, when the provider says. */
  expiresAt?: string | null;
  refreshExpiresAt?: string | null;
  scopes: string[];
  /** Provider user/member identifier returned with the token, if any. */
  subject?: string | null;
}

export interface DiscoveredAccount {
  providerAccountId: string;
  name: string;
  /** e.g. member, organization, page, ig_professional, creator, channel */
  type: string;
  /** Non-secret metadata persisted with the connection (e.g. linked page id, URN). */
  metadata: Record<string, unknown>;
  /** Account-specific token (Facebook Page token) when different from the user token. */
  accountAccessToken?: string | null;
  capabilities: CapabilityRow[];
}

export interface ConnectionRecord {
  id: string;
  workspace_id: string;
  provider: Platform;
  provider_account_id: string;
  account_name: string;
  account_type: string;
  granted_scopes: string[];
  api_version: string | null;
  metadata: Record<string, unknown>;
}

export interface ProviderContext {
  env: Env;
  connection: ConnectionRecord;
  tokens: {
    access: string;
    refresh: string | null;
    /** Facebook Page / account-scoped token when applicable. */
    account: string | null;
    expiresAt: string | null;
  };
  correlationId: string;
  fetch: FetchLike;
}

export interface MediaItem {
  assetId: string;
  mime: string;
  bytes: number;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  filename: string;
  /** Short-lived signed HTTPS URL served by Ayonix for provider pull. */
  publicUrl: string;
  /** Streams the original bytes from R2 for push uploads. */
  open: () => Promise<ReadableStream<Uint8Array>>;
}

export interface PublishContent {
  format: PostFormat;
  caption: string;
  title: string | null;
  linkUrl: string | null;
  /**
   * Platform specific options captured at prepare/approval time, e.g.
   * youtube: { privacy_status, made_for_kids, contains_synthetic_media, category_id }
   * tiktok: { privacy_level, disable_comment, disable_duet, disable_stitch,
   *           brand_content_toggle, brand_organic_toggle, is_aigc }
   */
  options: Record<string, unknown>;
  media: MediaItem[];
  /** Native provider scheduling time (YouTube publishAt) when scheduling_owner is provider_native. */
  publishAt: string | null;
}

/** Opaque per-target receipt persisted between submit and poll. */
export interface Receipt {
  remoteId: string | null;
  containerId: string | null;
  publishId: string | null;
  url: string | null;
  /** Adapter-private, non-secret state needed to continue polling. */
  state: Record<string, unknown>;
}

export type SubmitResult =
  | { kind: 'published'; receipt: Receipt }
  | { kind: 'processing'; receipt: Receipt; pollAfterSeconds: number };

export type PollResult =
  | { kind: 'published'; receipt: Receipt }
  | { kind: 'processing'; receipt: Receipt; pollAfterSeconds: number }
  | { kind: 'failed'; code: string; message: string; receipt: Receipt };

export interface MetricRow {
  providerObjectId: string;
  /** Exact provider metric name. */
  rawMetric: string;
  /** Normalized name only where the definition matches; otherwise null. */
  metric: 'impressions' | 'reach' | 'views' | 'likes' | 'comments' | 'shares' | 'saves' | 'clicks' | 'followers' | 'engagements' | null;
  value: number | null;
  date: string;
  aggregation: 'lifetime' | 'day' | 'period';
  estimated: boolean;
}

export type ProviderErrorKind =
  /** Token revoked/expired beyond refresh, or permission removed. Pause and ask to reconnect. */
  | 'reconnect_required'
  /** 429 / quota. Retry after the given delay. */
  | 'rate_limited'
  /** Request was rejected before any content was created. Terminal for this content. */
  | 'validation'
  /** The app/account lacks the capability (scope not approved, app review). Terminal. */
  | 'capability'
  /** Failed before reaching the provider or with a response proving nothing was created. Safe to retry. */
  | 'transient'
  /** The provider may have created the content (timeout after create, 5xx after create). Reconcile, never blind retry. */
  | 'ambiguous';

export class ProviderError extends Error {
  constructor(
    readonly kind: ProviderErrorKind,
    readonly code: string,
    message: string,
    readonly retryAfterSeconds: number | null = null,
    readonly status: number | null = null,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

export interface AuthorizeInput {
  state: string;
  codeChallenge: string;
  redirectUri: string;
}

export interface ProviderAdapter {
  readonly provider: Platform;
  /** Operator configuration present (client credentials and API version). */
  configured(env: Env): boolean;
  /** Minimal scopes requested at authorization. */
  scopes(env: Env): string[];
  authorizeUrl(env: Env, input: AuthorizeInput): string;
  exchangeCode(env: Env, code: string, codeVerifier: string, redirectUri: string, fetch: FetchLike): Promise<TokenSet>;
  discoverAccounts(env: Env, tokens: TokenSet, fetch: FetchLike): Promise<DiscoveredAccount[]>;
  probeCapabilities(ctx: ProviderContext): Promise<CapabilityRow[]>;
  /** Refresh when supported; otherwise report that the user must reconnect. */
  refreshOrReconnect(ctx: ProviderContext): Promise<{ kind: 'refreshed'; tokens: TokenSet } | { kind: 'reconnect_required'; reason: string }>;
  /** Provider-specific validation beyond the generic domain rules; returns problems. */
  validatePost(ctx: ProviderContext | null, content: PublishContent): string[];
  /** Transfer media to the provider (upload init + transfer). Returns adapter-private refs. */
  uploadMedia(ctx: ProviderContext, content: PublishContent): Promise<Record<string, unknown>>;
  /** Create the post from uploaded refs. Must not be called twice for one target attempt. */
  submitPost(ctx: ProviderContext, content: PublishContent, uploaded: Record<string, unknown>): Promise<SubmitResult>;
  pollStatus(ctx: ProviderContext, receipt: Receipt): Promise<PollResult>;
  fetchMetrics(ctx: ProviderContext, input: { objectIds: string[]; since: string; until: string }): Promise<MetricRow[]>;
  disconnect(ctx: ProviderContext): Promise<{ revoked: boolean }>;
}

/** TikTok-only: creator constraints fetched at approval and revalidated at dispatch. */
export interface TikTokCreatorInfo {
  creator_nickname: string;
  creator_username: string | null;
  creator_avatar_url: string | null;
  privacy_level_options: string[];
  comment_disabled: boolean;
  duet_disabled: boolean;
  stitch_disabled: boolean;
  max_video_post_duration_sec: number | null;
}
