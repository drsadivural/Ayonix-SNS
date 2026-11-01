// Shared REST response shapes for /api/v1. The Worker produces these and the
// web app consumes them; neither side may invent fields that the other ignores.

export const PLATFORMS = ['linkedin', 'facebook', 'instagram', 'tiktok', 'youtube'] as const;
export type Platform = (typeof PLATFORMS)[number];

export const FORMATS = ['text', 'link', 'image', 'video', 'reel', 'carousel', 'photo'] as const;
export type PostFormat = (typeof FORMATS)[number];

export type Role = 'owner' | 'admin' | 'editor' | 'viewer';

export const TARGET_STATES = [
  'draft',
  'awaiting_approval',
  'scheduled',
  'queued',
  'submitting',
  'processing',
  'retry_wait',
  'reconnect_required',
  'outcome_unknown',
  'published',
  'failed',
  'canceled',
] as const;
export type TargetState = (typeof TARGET_STATES)[number];

export type ConnectionState =
  | 'disconnected'
  | 'authorizing'
  | 'pending_review'
  | 'connected'
  | 'expiring'
  | 'reconnect_required'
  | 'restricted'
  | 'error';

export type SubscriptionStatus =
  | 'none'
  | 'trialing'
  | 'active'
  | 'past_due'
  | 'suspended'
  | 'unpaid'
  | 'canceled'
  | 'incomplete'
  | 'expired';

export type PlanName = 'trial' | 'basic' | 'standard' | 'premium' | 'custom';

export interface ApiError {
  error: {
    code: string;
    message: string;
    request_id: string;
    field_errors?: Record<string, string>;
    retryable: boolean;
    retry_after_seconds?: number;
    current_version?: number;
  };
}

export interface Page<T> {
  items: T[];
  next_cursor: string | null;
}

export interface Entitlements {
  plan: PlanName | null;
  status: SubscriptionStatus;
  posts_per_cycle: number;
  products: number;
  auto_learn: boolean;
  competitor_check: boolean;
  similar_research: boolean;
  storage_bytes: number;
  can_confirm_schedules: boolean;
  /** Plain reason when can_confirm_schedules is false. Never a purchase link. */
  restriction: string | null;
}

export interface QuotaSummary {
  period_id: string | null;
  starts_at: string | null;
  ends_at: string | null;
  allowance: number;
  used: number;
  reserved: number;
  available: number;
}

export interface Me {
  identity: { id: string; email: string; name: string; email_verified: boolean };
  workspaces: Array<{ id: string; name: string; role: Role }>;
}

export interface WorkspaceSummary {
  id: string;
  name: string;
  timezone: string;
  locale: string;
  role: Role;
  entitlements: Entitlements;
  quota: QuotaSummary;
  /** Which optional server integrations are configured on this deployment. */
  integrations: Record<'email' | 'stripe' | 'research' | 'ai' | Platform, boolean>;
}

export interface ProductClaim {
  id: string;
  text: string;
  kind: 'claim' | 'prohibited';
  status: 'proposed' | 'approved' | 'rejected';
  source_url: string | null;
}

export interface Product {
  id: string;
  name: string;
  audience: string;
  language: string;
  tone: string;
  status: 'draft' | 'approved' | 'paused';
  version: number;
  approved_version: number | null;
  source_urls: string[];
  claims: ProductClaim[];
  updated_at: string;
}

export interface CapabilityRow {
  capability: string;
  status: 'available' | 'pending_review' | 'unavailable';
  detail: string | null;
}

export interface Connection {
  id: string;
  provider: Platform;
  account_name: string;
  account_type: string;
  provider_account_id: string;
  state: ConnectionState;
  granted_scopes: string[];
  token_expires_at: string | null;
  last_verified_at: string | null;
  api_version: string | null;
  capabilities: CapabilityRow[];
}

export interface ProviderStatus {
  provider: Platform;
  configured: boolean;
  /** Why the operator configuration prevents connecting, if it does. */
  restriction: string | null;
  connections: Connection[];
}

export interface Asset {
  id: string;
  product_id: string | null;
  filename: string;
  mime: string;
  bytes: number;
  width: number | null;
  height: number | null;
  duration_ms: number | null;
  checksum_sha256: string | null;
  validation_state: 'pending' | 'valid' | 'rejected';
  validation_error: string | null;
  created_at: string;
}

export interface DestinationInput {
  platform: Platform;
  connection_id: string;
  format: PostFormat;
  caption: string;
  asset_ids: string[];
  title?: string;
  link_url?: string;
  options?: Record<string, unknown>;
}

export interface Campaign {
  id: string;
  product_id: string;
  goal: string;
  audience: string;
  language: string;
  created_at: string;
}

export interface PostRevision {
  post_id: string;
  campaign_id: string;
  revision: number;
  destinations: Array<DestinationInput & { content_hash: string }>;
}

export interface PreviewTarget {
  post_id: string;
  revision: number;
  platform: Platform;
  connection_id: string;
  account_name: string;
  format: PostFormat;
  caption_preview: string;
  asset_ids: string[];
  scheduled_at_utc: string;
  local_time: string;
  utc_offset: string;
  timezone: string;
  quota_cost: number;
  approval_required: null | 'tiktok_creator_consent';
  scheduling_owner: 'ayonix' | 'provider_native';
  problems: string[];
}

export interface SchedulePreview {
  preview_token: string | null;
  expires_at: string | null;
  quota_cost: number;
  quota: QuotaSummary;
  targets: PreviewTarget[];
  approval_requirements: string[];
  blocking_problems: string[];
}

export interface TargetReceipt {
  remote_id: string | null;
  container_id: string | null;
  url: string | null;
  verified_at: string | null;
  status: string;
}

export interface Target {
  id: string;
  schedule_id: string;
  schedule_version: number;
  /** Target compare-and-swap version; send as expected_version to reschedule/resolve. */
  version: number;
  post_id: string;
  revision: number;
  product_id: string;
  platform: Platform;
  connection_id: string;
  account_name: string;
  format: PostFormat;
  caption_preview: string;
  status: TargetState;
  due_at: string;
  local_time: string;
  timezone: string;
  approval_required: null | 'tiktok_creator_consent';
  next_action: string | null;
  error: { code: string; message: string } | null;
  receipt: TargetReceipt | null;
  attempts: number;
  updated_at: string;
}

export interface ScheduleConfirmation {
  schedule_id: string;
  version: number;
  target_ids: string[];
  states: Record<string, TargetState>;
}

export interface MetricPoint {
  date: string;
  value: number | null;
}

export interface AnalyticsResponse {
  period: { from: string; to: string };
  totals: {
    published: number;
    scheduled: number;
    impressions: number | null;
    engagements: number | null;
  };
  series: { metric: 'impressions' | 'engagements'; points: MetricPoint[] };
  by_channel: Array<{
    platform: Platform;
    impressions: number | null;
    engagements: number | null;
    retrieved_at: string | null;
    available: boolean;
    note: string | null;
  }>;
  top_posts: Array<{
    target_id: string;
    platform: Platform;
    caption_preview: string;
    url: string | null;
    impressions: number | null;
    engagements: number | null;
  }>;
  definitions: Record<string, string>;
  freshness: string | null;
}

export interface ReportJob {
  id: string;
  format: 'csv' | 'pdf';
  status: 'queued' | 'running' | 'ready' | 'failed';
  error: string | null;
  download_url: string | null;
  download_expires_at: string | null;
  created_at: string;
}

export interface ResearchJob {
  id: string;
  product_id: string;
  kind: 'auto_learn' | 'competitor_check' | 'similar_research';
  status: 'queued' | 'running' | 'completed' | 'failed' | 'blocked';
  error: string | null;
  sources: Array<{ url: string; title: string | null; retrieved_at: string; status: string }>;
  proposed_changes: Array<{ text: string; source_url: string; kind: string }>;
  created_at: string;
  completed_at: string | null;
}

export interface CatalogPlan {
  name: 'basic' | 'standard' | 'premium';
  price_cents: number;
  posts: number;
  products: number;
  auto_learn: boolean;
  competitor_check: boolean;
  similar_research: boolean;
}

export interface BillingCatalog {
  version: string;
  currency: string;
  interval: string;
  tax_included: boolean;
  plans: CatalogPlan[];
  custom: {
    base_cents: number;
    maximum_cents: number;
    post_tiers: Array<{ posts: number; add_cents: number }>;
    product_tiers: Array<{ products: number; add_cents: number }>;
    features: Array<{ key: 'autoLearn' | 'competitorCheck' | 'similarResearch'; add_cents: number }>;
  };
}

export interface CustomSelection {
  posts: number;
  products: number;
  autoLearn: boolean;
  competitorCheck: boolean;
  similarResearch: boolean;
}

export interface BillingQuote {
  quote_id: string;
  plan: 'basic' | 'standard' | 'premium' | 'custom';
  selection: CustomSelection | null;
  price_cents: number;
  currency: string;
  catalog_version: string;
  configuration_hash: string;
  better_value: 'standard' | null;
  expires_at: string;
}

export interface Subscription {
  plan: PlanName | null;
  status: SubscriptionStatus;
  price_cents: number | null;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
  pending_change: { plan: PlanName; effective_at: string } | null;
  trial_ends_at: string | null;
  portal_available: boolean;
}

export interface Invoice {
  id: string;
  number: string | null;
  status: string;
  amount_due_cents: number;
  amount_paid_cents: number;
  currency: string;
  hosted_invoice_url: string | null;
  period_start: string | null;
  period_end: string | null;
  created_at: string;
}

export interface Member {
  identity_id: string;
  email: string;
  name: string;
  role: Role;
  joined_at: string;
}

export interface Invitation {
  id: string;
  email: string;
  role: Role;
  expires_at: string;
  accepted_at: string | null;
}

export interface AuditEvent {
  id: string;
  actor: string | null;
  action: string;
  object_type: string;
  object_id: string | null;
  detail: Record<string, unknown>;
  created_at: string;
}

export interface NotificationPreference {
  event: 'publish_failed' | 'approval_needed' | 'reconnect_required' | 'payment_failed' | 'weekly_report';
  email: boolean;
}

export interface TikTokApprovalContext {
  target_id: string;
  approval_token: string;
  creator: {
    nickname: string;
    username: string | null;
    avatar_url: string | null;
    privacy_level_options: string[];
    comment_disabled: boolean;
    duet_disabled: boolean;
    stitch_disabled: boolean;
    max_video_post_duration_sec: number | null;
  };
  content: { caption: string; title: string | null; asset_ids: string[]; format: PostFormat };
  fetched_at: string;
}

export interface McpConsentContext {
  client_name: string;
  client_uri: string | null;
  scopes: string[];
  workspaces: Array<{ id: string; name: string; role: Role }>;
  request: string;
}
