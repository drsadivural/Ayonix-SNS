// Custom plan calculator. Capacity tiers are exclusive groups (radio); the
// three features are independent checkboxes. Prices come only from the
// server catalog; the server quote remains authoritative.
import { useId } from 'react';
import type { BillingCatalog, CustomSelection } from '@ayonix/contracts';
import { formatUsd } from '@ayonix/domain';
import { formatNumber } from '../../lib/format';
import { FEATURE_LABELS, customTotalCents } from '../../lib/pricing';

export function CustomCalculator({
  catalog,
  value,
  onChange,
  disabled,
}: {
  catalog: BillingCatalog;
  value: CustomSelection;
  onChange: (s: CustomSelection) => void;
  disabled?: boolean;
}) {
  const id = useId();
  const total = customTotalCents(catalog, value);
  const isMax = total === catalog.custom.maximum_cents;
  return (
    <div className="stack">
      <div className="grid-2">
        <fieldset disabled={disabled}>
          <legend>Posts / month (destination publications)</legend>
          <div className="choice-group">
            {catalog.custom.post_tiers.map((t) => (
              <label key={t.posts} className="choice">
                <input type="radio" name={`${id}-posts`} value={t.posts} checked={value.posts === t.posts} onChange={() => onChange({ ...value, posts: t.posts })} />
                <span>{formatNumber(t.posts)} posts</span>
                <span className="price-delta">{t.add_cents ? `+${formatUsd(t.add_cents)}` : 'Included'}</span>
              </label>
            ))}
          </div>
        </fieldset>
        <fieldset disabled={disabled}>
          <legend>Active products</legend>
          <div className="choice-group">
            {catalog.custom.product_tiers.map((t) => (
              <label key={t.products} className="choice">
                <input type="radio" name={`${id}-products`} value={t.products} checked={value.products === t.products} onChange={() => onChange({ ...value, products: t.products })} />
                <span>
                  {formatNumber(t.products)} product{t.products === 1 ? '' : 's'}
                </span>
                <span className="price-delta">{t.add_cents ? `+${formatUsd(t.add_cents)}` : 'Included'}</span>
              </label>
            ))}
          </div>
        </fieldset>
      </div>
      <fieldset disabled={disabled}>
        <legend>Research features</legend>
        <div className="grid-3">
          {catalog.custom.features.map((f) => (
            <label key={f.key} className="choice">
              <input type="checkbox" checked={value[f.key]} onChange={(e) => onChange({ ...value, [f.key]: e.target.checked })} />
              <span>{FEATURE_LABELS[f.key]}</span>
              <span className="price-delta">+{formatUsd(f.add_cents)}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <div className="calc-total">
        <div className="stack-sm">
          <span className="muted">{isMax ? 'All highest options selected' : 'Custom plan total'}</span>
          <span className="small muted">
            Includes base {formatUsd(catalog.custom.base_cents)}. Pre-tax subscription maximum {formatUsd(catalog.custom.maximum_cents)}. Tax added where applicable.
          </span>
        </div>
        <output className="total" aria-live="polite" data-testid="custom-total">
          {total === null ? 'Choose an option' : `${formatUsd(total)} / month`}
        </output>
      </div>
    </div>
  );
}
