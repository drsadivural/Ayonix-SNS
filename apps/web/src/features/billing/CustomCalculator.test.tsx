import { describe, expect, it } from 'vitest';
import { useState } from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { CustomSelection } from '@ayonix/contracts';
import { billingCatalog, customQuote } from '@ayonix/domain';
import { customTotalCents, defaultSelection, maxSelection } from '../../lib/pricing';
import { CustomCalculator } from './CustomCalculator';

const catalog = billingCatalog();

function Harness() {
  const [s, setS] = useState<CustomSelection>(() => defaultSelection(catalog));
  return <CustomCalculator catalog={catalog} value={s} onChange={setS} />;
}

describe('custom plan pricing', () => {
  it('matches the shared domain quote for every combination', () => {
    let combos = 0;
    for (const p of catalog.custom.post_tiers) {
      for (const pr of catalog.custom.product_tiers) {
        for (let mask = 0; mask < 8; mask++) {
          const s: CustomSelection = { posts: p.posts, products: pr.products, autoLearn: Boolean(mask & 1), competitorCheck: Boolean(mask & 2), similarResearch: Boolean(mask & 4) };
          expect(customTotalCents(catalog, s)).toBe(customQuote(s).priceCents);
          combos++;
        }
      }
    }
    expect(combos).toBe(catalog.custom.post_tiers.length * catalog.custom.product_tiers.length * 8);
  });

  it('defaults to the base price and maxes out at exactly $1,000', () => {
    expect(customTotalCents(catalog, defaultSelection(catalog))).toBe(4900);
    expect(customTotalCents(catalog, maxSelection(catalog))).toBe(100000);
    expect(catalog.custom.maximum_cents).toBe(100000);
  });

  it('rejects tiers that are not in the catalog instead of guessing', () => {
    expect(customTotalCents(catalog, { ...defaultSelection(catalog), posts: 999 })).toBeNull();
  });
});

describe('CustomCalculator', () => {
  it('shows incremental prices and a persistent total that reaches $1,000 with every maximum', () => {
    render(<Harness />);
    expect(screen.getByTestId('custom-total').textContent).toBe('$49 / month');
    const posts = screen.getByRole('group', { name: /posts \/ month/i });
    const products = screen.getByRole('group', { name: /active products/i });
    expect(within(posts).getByText('+$420')).toBeTruthy();
    expect(within(products).getByText('+$160')).toBeTruthy();
    for (const label of ['+$99', '+$129', '+$143']) expect(screen.getByText(label)).toBeTruthy();

    fireEvent.click(within(posts).getByRole('radio', { name: /1,000 posts/ }));
    fireEvent.click(within(products).getByRole('radio', { name: /50 products/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: /auto learn/i }));
    fireEvent.click(screen.getByRole('checkbox', { name: /competitor check/i }));
    fireEvent.click(screen.getByRole('checkbox', { name: /similar research/i }));
    expect(screen.getByTestId('custom-total').textContent).toBe('$1,000 / month');
    expect(screen.getByText(/Includes base \$49\. Pre-tax subscription maximum \$1,000\./)).toBeTruthy();
  });

  it('treats capacity tiers as exclusive groups', () => {
    render(<Harness />);
    const posts = screen.getByRole('group', { name: /posts \/ month/i });
    const r1000 = within(posts).getByRole('radio', { name: /1,000 posts/ }) as HTMLInputElement;
    const r600 = within(posts).getByRole('radio', { name: /600 posts/ }) as HTMLInputElement;
    fireEvent.click(r1000);
    expect(r1000.checked).toBe(true);
    fireEvent.click(r600);
    expect(r600.checked).toBe(true);
    expect(r1000.checked).toBe(false);
    expect(within(posts).getAllByRole('radio').filter((r) => (r as HTMLInputElement).checked)).toHaveLength(1);
    // 49 base + 300 for 600 posts; not cumulative with the 1,000 tier.
    expect(screen.getByTestId('custom-total').textContent).toBe('$349 / month');
  });
});
