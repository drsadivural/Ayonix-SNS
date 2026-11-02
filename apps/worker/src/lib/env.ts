import type { OAuthHelpers } from '@cloudflare/workers-oauth-provider';
import type { Platform } from '@ayonix/contracts';

export interface Env {
  DB: D1Database;
  MEDIA: R2Bucket;
  OAUTH_KV: KVNamespace;
  COORDINATOR: DurableObjectNamespace;
  PUBLISH_QUEUE: Queue<QueueMessage>;
  JOBS_QUEUE: Queue<JobMessage>;
  ASSETS?: Fetcher;
  OAUTH_PROVIDER: OAuthHelpers;

  APP_ORIGIN: string;
  ENVIRONMENT: 'development' | 'test' | 'staging' | 'production';
  DEFAULT_TIMEZONE: string;

  BETTER_AUTH_SECRET?: string;
  TOKEN_ENCRYPTION_KEY?: string;
  TOKEN_ENCRYPTION_KEY_VERSION?: string;
  /** Previous key versions for decryption during rotation: JSON {"1":"base64..."} */
  TOKEN_ENCRYPTION_PREVIOUS_KEYS?: string;
  SIGNING_KEY?: string;

  AUTH_GOOGLE_CLIENT_ID?: string;
  AUTH_GOOGLE_CLIENT_SECRET?: string;

  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  STRIPE_BASIC_PRICE_ID?: string;
  STRIPE_STANDARD_PRICE_ID?: string;
  STRIPE_PREMIUM_PRICE_ID?: string;
  STRIPE_PRODUCT_ID?: string;

  LINKEDIN_CLIENT_ID?: string;
  LINKEDIN_CLIENT_SECRET?: string;
  LINKEDIN_API_VERSION?: string;
  /** 'true' only after LinkedIn approved organization (Page) scopes for the app. */
  LINKEDIN_ENABLE_ORGANIZATIONS?: string;
  META_APP_ID?: string;
  META_APP_SECRET?: string;
  META_GRAPH_VERSION?: string;
  /** Facebook Login for Business configuration IDs; when set they replace the scope list. */
  META_FACEBOOK_CONFIG_ID?: string;
  META_INSTAGRAM_CONFIG_ID?: string;
  TIKTOK_CLIENT_KEY?: string;
  TIKTOK_CLIENT_SECRET?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;

  EMAIL_API_KEY?: string;
  EMAIL_FROM?: string;
  RESEARCH_API_KEY?: string;
  AI_PROVIDER_API_KEY?: string;
  AI_MODEL?: string;
  SENTRY_DSN?: string;
}

export interface QueueMessage {
  kind: 'dispatch' | 'poll' | 'reconcile';
  workspace_id: string;
  target_id: string;
  revision: number;
  outbox_id: string;
}

export type JobMessage =
  | { kind: 'report'; workspace_id: string; job_id: string }
  | { kind: 'research'; workspace_id: string; job_id: string }
  | { kind: 'metrics'; workspace_id: string; connection_id: string }
  | { kind: 'privacy'; workspace_id: string; job_id: string }
  | { kind: 'notify'; workspace_id: string; template: string; dedupe_key: string; data: Record<string, string> };

export const isProduction = (env: Env) => env.ENVIRONMENT === 'production';
export const isLocal = (env: Env) => env.ENVIRONMENT === 'development' || env.ENVIRONMENT === 'test';

const REQUIRED_ALWAYS = ['BETTER_AUTH_SECRET', 'TOKEN_ENCRYPTION_KEY', 'SIGNING_KEY'] as const;
const REQUIRED_DEPLOYED = ['EMAIL_API_KEY', 'EMAIL_FROM'] as const;

/** Boot-time configuration validation. Missing required config fails closed. */
export function configProblems(env: Env): string[] {
  const problems: string[] = [];
  for (const key of REQUIRED_ALWAYS) if (!env[key]) problems.push(`${key} is not configured`);
  if (!isLocal(env)) for (const key of REQUIRED_DEPLOYED) if (!env[key]) problems.push(`${key} is not configured`);
  if (env.TOKEN_ENCRYPTION_KEY) {
    try {
      const raw = atob(env.TOKEN_ENCRYPTION_KEY);
      if (raw.length !== 32) problems.push('TOKEN_ENCRYPTION_KEY must be 32 random bytes, base64 encoded');
    } catch {
      problems.push('TOKEN_ENCRYPTION_KEY must be base64');
    }
  }
  if (env.BETTER_AUTH_SECRET && env.BETTER_AUTH_SECRET.length < 32) problems.push('BETTER_AUTH_SECRET must be at least 32 characters');
  if (env.SIGNING_KEY && env.SIGNING_KEY.length < 32) problems.push('SIGNING_KEY must be at least 32 characters');
  if (!isLocal(env) && !env.APP_ORIGIN.startsWith('https://')) problems.push('APP_ORIGIN must be https outside local development');
  return problems;
}

export function stripeConfigured(env: Env): boolean {
  return Boolean(env.STRIPE_SECRET_KEY && env.STRIPE_WEBHOOK_SECRET && env.STRIPE_BASIC_PRICE_ID && env.STRIPE_STANDARD_PRICE_ID && env.STRIPE_PREMIUM_PRICE_ID && env.STRIPE_PRODUCT_ID);
}

export function providerConfigured(env: Env, provider: Platform): boolean {
  switch (provider) {
    case 'linkedin':
      return Boolean(env.LINKEDIN_CLIENT_ID && env.LINKEDIN_CLIENT_SECRET && env.LINKEDIN_API_VERSION);
    case 'facebook':
    case 'instagram':
      return Boolean(env.META_APP_ID && env.META_APP_SECRET && env.META_GRAPH_VERSION);
    case 'tiktok':
      return Boolean(env.TIKTOK_CLIENT_KEY && env.TIKTOK_CLIENT_SECRET);
    case 'youtube':
      return Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
  }
}

export function emailConfigured(env: Env): boolean {
  return Boolean(env.EMAIL_API_KEY && env.EMAIL_FROM);
}

export function researchConfigured(env: Env): boolean {
  return Boolean(env.RESEARCH_API_KEY && env.AI_PROVIDER_API_KEY && env.AI_MODEL);
}

export function mcpResource(env: Env): string {
  return `${env.APP_ORIGIN}/mcp`;
}
