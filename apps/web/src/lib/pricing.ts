// Client-side display of the Custom plan price, computed only from the
// server catalog (GET /billing/catalog). The server quote is authoritative.
import type { BillingCatalog, CustomSelection } from '@ayonix/contracts';

export type FeatureKey = BillingCatalog['custom']['features'][number]['key'];

export const FEATURE_LABELS: Record<FeatureKey, string> = {
  autoLearn: 'Auto learn',
  competitorCheck: 'Competitor check',
  similarResearch: 'Similar research',
};

export function defaultSelection(catalog: BillingCatalog): CustomSelection {
  return {
    posts: catalog.custom.post_tiers[0]?.posts ?? 20,
    products: catalog.custom.product_tiers[0]?.products ?? 1,
    autoLearn: false,
    competitorCheck: false,
    similarResearch: false,
  };
}

/** Total in cents, or null if the selection is not in the catalog (never guessed). */
export function customTotalCents(catalog: BillingCatalog, s: CustomSelection): number | null {
  const post = catalog.custom.post_tiers.find((t) => t.posts === s.posts);
  const product = catalog.custom.product_tiers.find((t) => t.products === s.products);
  if (!post || !product) return null;
  let total = catalog.custom.base_cents + post.add_cents + product.add_cents;
  for (const f of catalog.custom.features) if (s[f.key]) total += f.add_cents;
  return total;
}

export function maxSelection(catalog: BillingCatalog): CustomSelection {
  const posts = catalog.custom.post_tiers.at(-1)?.posts ?? 20;
  const products = catalog.custom.product_tiers.at(-1)?.products ?? 1;
  return { posts, products, autoLearn: true, competitorCheck: true, similarResearch: true };
}
