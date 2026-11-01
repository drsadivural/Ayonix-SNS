// Commercial rules. contracts/pricing.json is the only price source; every
// amount is integer cents. Ported from the tested handoff reference
// (handoff/reference/domain.mjs) with its behavioral tests preserved.
import { pricing } from '@ayonix/contracts';
import type { BillingCatalog, CustomSelection } from '@ayonix/contracts';
import { hashCanonical } from './hash.js';

export const catalog = pricing;
export type StandardPlanName = keyof typeof pricing.plans;
export type FeatureKey = keyof typeof pricing.custom.features;

export const FEATURE_KEYS = Object.keys(pricing.custom.features) as FeatureKey[];
export const POST_TIERS = Object.keys(pricing.custom.postTiers).map(Number).sort((a, b) => a - b);
export const PRODUCT_TIERS = Object.keys(pricing.custom.productTiers).map(Number).sort((a, b) => a - b);

export class PricingError extends Error {
  constructor(
    message: string,
    readonly field?: string,
  ) {
    super(message);
    this.name = 'PricingError';
  }
}

const has = (obj: object, key: PropertyKey) => Object.hasOwn(obj, key);

export interface PlanEntitlement {
  priceCents: number;
  posts: number;
  products: number;
  autoLearn: boolean;
  competitorCheck: boolean;
  similarResearch: boolean;
}

export function standardPlan(name: string): PlanEntitlement {
  if (typeof name !== 'string' || !has(pricing.plans, name)) throw new PricingError('Unknown plan', 'plan');
  return { ...pricing.plans[name as StandardPlanName] };
}

export interface CustomQuote {
  catalogVersion: string;
  currency: string;
  interval: string;
  priceCents: number;
  selection: CustomSelection;
}

/**
 * Validate a browser-supplied Custom selection and compute its price. Unknown
 * fields, non-integer tiers, unsupported tiers and non-boolean features are
 * rejected rather than coerced, so a tampered request can never buy an
 * unpriced capability.
 */
export function customQuote(selection: unknown = {}): CustomQuote {
  if (!selection || typeof selection !== 'object' || Array.isArray(selection)) {
    throw new PricingError('Expected selection object');
  }
  const allowed = ['posts', 'products', ...FEATURE_KEYS];
  for (const key of Object.keys(selection)) {
    if (!allowed.includes(key)) throw new PricingError(`Unknown field: ${key}`, key);
  }
  const normalized = {
    posts: 20,
    products: 1,
    autoLearn: false,
    competitorCheck: false,
    similarResearch: false,
    ...(selection as Record<string, unknown>),
  } as Record<string, unknown>;
  const c = pricing.custom;
  for (const field of ['posts', 'products'] as const) {
    const v = normalized[field];
    if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 1) {
      throw new PricingError(`${field} must be a safe integer >= 1`, field);
    }
  }
  if (!has(c.postTiers, String(normalized.posts))) throw new PricingError('Unsupported capacity tier', 'posts');
  if (!has(c.productTiers, String(normalized.products))) throw new PricingError('Unsupported capacity tier', 'products');
  let priceCents =
    c.baseCents +
    c.postTiers[String(normalized.posts) as keyof typeof c.postTiers] +
    c.productTiers[String(normalized.products) as keyof typeof c.productTiers];
  for (const feature of FEATURE_KEYS) {
    if (typeof normalized[feature] !== 'boolean') throw new PricingError(`${feature} must be boolean`, feature);
    if (normalized[feature]) priceCents += c.features[feature];
  }
  if (!Number.isSafeInteger(priceCents) || priceCents > c.maximumCents) {
    throw new PricingError('Catalog exceeds maximum');
  }
  return {
    catalogVersion: pricing.version,
    currency: pricing.currency,
    interval: pricing.interval,
    priceCents,
    selection: normalized as unknown as CustomSelection,
  };
}

/** Identity hash of a quote (not an authorization token; quotes are also signed server side). */
export function quoteConfigurationHash(quote: CustomQuote): Promise<string> {
  return hashCanonical(quote);
}

/** Custom selection equivalent to, or exceeding, Standard while costing more. */
export function betterValueRecommendation(selection: CustomSelection, priceCents: number): 'standard' | null {
  const std = pricing.plans.standard;
  const coveredByStandard =
    selection.posts <= std.posts &&
    selection.products <= std.products &&
    (!selection.autoLearn || std.autoLearn) &&
    (!selection.competitorCheck || std.competitorCheck) &&
    (!selection.similarResearch || std.similarResearch);
  return coveredByStandard && priceCents > std.priceCents ? 'standard' : null;
}

export function entitlementFor(plan: 'trial' | StandardPlanName | 'custom', selection?: CustomSelection | null): PlanEntitlement {
  if (plan === 'trial') {
    return { priceCents: 0, posts: TRIAL.posts, products: TRIAL.products, autoLearn: false, competitorCheck: false, similarResearch: false };
  }
  if (plan === 'custom') {
    if (!selection) throw new PricingError('Custom plan requires a selection');
    const q = customQuote(selection);
    return { priceCents: q.priceCents, ...q.selection };
  }
  return standardPlan(plan);
}

/** Proposed trial terms (docs/01-PRODUCT.md "Trial assumption"); website only. */
export const TRIAL = { days: 7, posts: 5, products: 1 } as const;

/** Proposed included media storage (docs/05-BILLING.md). */
export const STORAGE_BYTES: Record<'trial' | StandardPlanName | 'custom', number> = {
  trial: 1 * 1024 ** 3,
  basic: 2 * 1024 ** 3,
  standard: 10 * 1024 ** 3,
  premium: 30 * 1024 ** 3,
  custom: 50 * 1024 ** 3,
};

/** Proposed research caps per active product per cycle (docs/01-PRODUCT.md). */
export const RESEARCH_CAPS = {
  standard: { learn: 4, competitorScans: 4, competitors: 3, briefs: 4 },
  premium: { learn: 4, competitorScans: 4, competitors: 5, briefs: 4 },
  custom: { learn: 4, competitorScans: 4, competitors: 5, briefs: 4 },
  maxPagesPerBrief: 20,
  maxInputTokensPerBrief: 30_000,
  maxSourceDocumentBytes: 5 * 1024 * 1024,
  maxCorpusBytesPerProduct: 50 * 1024 * 1024,
  rawRetentionDays: 90,
} as const;

export function billingCatalog(): BillingCatalog {
  const c = pricing.custom;
  return {
    version: pricing.version,
    currency: pricing.currency,
    interval: pricing.interval,
    tax_included: pricing.taxIncluded,
    plans: (Object.keys(pricing.plans) as StandardPlanName[]).map((name) => {
      const p = pricing.plans[name];
      return {
        name,
        price_cents: p.priceCents,
        posts: p.posts,
        products: p.products,
        auto_learn: p.autoLearn,
        competitor_check: p.competitorCheck,
        similar_research: p.similarResearch,
      };
    }),
    custom: {
      base_cents: c.baseCents,
      maximum_cents: c.maximumCents,
      post_tiers: POST_TIERS.map((posts) => ({ posts, add_cents: c.postTiers[String(posts) as keyof typeof c.postTiers] })),
      product_tiers: PRODUCT_TIERS.map((products) => ({
        products,
        add_cents: c.productTiers[String(products) as keyof typeof c.productTiers],
      })),
      features: FEATURE_KEYS.map((key) => ({ key, add_cents: c.features[key] })),
    },
  };
}

export function formatUsd(cents: number): string {
  const dollars = cents / 100;
  return `$${dollars.toLocaleString('en-US', { minimumFractionDigits: cents % 100 ? 2 : 0, maximumFractionDigits: 2 })}`;
}
