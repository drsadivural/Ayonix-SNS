// Ported from handoff/tests/domain.test.mjs; assertions preserved.
import { describe, expect, it } from 'vitest';
import {
  betterValueRecommendation,
  billingCatalog,
  catalog,
  customQuote,
  quoteConfigurationHash,
  standardPlan,
} from '../src/index.js';
import handoffPricing from '../../../handoff/contracts/pricing.json' with { type: 'json' };

describe('pricing', () => {
  it('uses the handoff pricing contract byte-for-byte', () => {
    expect(catalog).toEqual(handoffPricing);
  });

  it('fixed plans match the requested price/capacity mapping', () => {
    for (const [name, price, posts, products] of [
      ['basic', 4900, 20, 1],
      ['standard', 9900, 60, 3],
      ['premium', 19900, 120, 10],
    ] as const) {
      const plan = standardPlan(name);
      expect(plan.priceCents).toBe(price);
      expect(plan.posts).toBe(posts);
      expect(plan.products).toBe(products);
    }
    expect(standardPlan('standard').autoLearn).toBe(true);
    expect(standardPlan('premium').similarResearch).toBe(true);
    expect(() => standardPlan('__proto__')).toThrow();
  });

  it('all 240 valid custom selections are bounded, monotonic and deterministic', async () => {
    let count = 0;
    for (const posts of Object.keys(catalog.custom.postTiers).map(Number))
      for (const products of Object.keys(catalog.custom.productTiers).map(Number))
        for (let bits = 0; bits < 8; bits++) {
          const q = customQuote({ posts, products, autoLearn: !!(bits & 1), competitorCheck: !!(bits & 2), similarResearch: !!(bits & 4) });
          expect(q.priceCents).toBeGreaterThanOrEqual(4900);
          expect(q.priceCents).toBeLessThanOrEqual(100000);
          const h = await quoteConfigurationHash(q);
          expect(h).toBe(await quoteConfigurationHash(customQuote(q.selection)));
          expect(h).toHaveLength(64);
          if (!q.selection.autoLearn) expect(customQuote({ ...q.selection, autoLearn: true }).priceCents - q.priceCents).toBe(9900);
          count++;
        }
    expect(count).toBe(240);
  });

  it('custom minimum, exact maximum and documented example', () => {
    expect(customQuote().priceCents).toBe(4900);
    expect(customQuote({ posts: 1000, products: 50, autoLearn: true, competitorCheck: true, similarResearch: true }).priceCents).toBe(100000);
    expect(customQuote({ posts: 120, products: 10, autoLearn: true }).priceCents).toBe(27800);
  });

  it('rejects browser price tampering and ambiguous checkbox inputs', () => {
    for (const x of [
      { priceCents: 1 },
      { posts: '120' },
      { posts: 121 },
      { products: 51 },
      { autoLearn: 'false' },
      { competitorCheck: 1 },
      { similarResearch: null },
      { posts: NaN },
      { priceId: 'price_123' },
      null,
      [],
    ])
      expect(() => customQuote(x)).toThrow();
  });

  it('quote hash unaffected by input field ordering', async () => {
    expect(await quoteConfigurationHash(customQuote({ posts: 60, autoLearn: true }))).toBe(
      await quoteConfigurationHash(customQuote({ autoLearn: true, posts: 60 })),
    );
  });

  it('recommends Standard only when a costlier Custom is covered by it', () => {
    const q = customQuote({ posts: 60, products: 3, autoLearn: true });
    expect(q.priceCents).toBe(4900 + 3000 + 2000 + 9900);
    expect(betterValueRecommendation(q.selection, q.priceCents)).toBe('standard');
    const base = customQuote();
    expect(betterValueRecommendation(base.selection, base.priceCents)).toBeNull();
  });

  it('catalog exposes exclusive tiers and the $1,000 ceiling', () => {
    const c = billingCatalog();
    expect(c.custom.maximum_cents).toBe(100000);
    const max =
      c.custom.base_cents +
      Math.max(...c.custom.post_tiers.map((t) => t.add_cents)) +
      Math.max(...c.custom.product_tiers.map((t) => t.add_cents)) +
      c.custom.features.reduce((s, f) => s + f.add_cents, 0);
    expect(max).toBe(100000);
    expect(c.interval).toBe('month');
    expect(c.tax_included).toBe(false);
  });
});
