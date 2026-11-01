import { useRef, useState } from 'react';
import type { BillingCatalog, BillingQuote, CatalogPlan, CustomSelection, PlanName } from '@ayonix/contracts';
import { formatUsd } from '@ayonix/domain';
import { Dialog } from '../../components/overlay';
import { Banner, ErrorNotice } from '../../components/ui';
import { api } from '../../lib/api';
import { formatDateTime, formatNumber } from '../../lib/format';
import { useAction } from '../../lib/hooks';
import { PLAN_LABELS } from '../../lib/labels';
import { defaultSelection } from '../../lib/pricing';
import { CustomCalculator } from './CustomCalculator';

type CheckoutResult = { kind: 'redirect'; url: string } | { kind: 'changed'; effective_at: string; immediate: boolean };

function planFeatures(p: CatalogPlan): string[] {
  const research = p.auto_learn && p.competitor_check && p.similar_research;
  return [
    `${formatNumber(p.posts)} posts / month`,
    `${formatNumber(p.products)} product${p.products === 1 ? '' : 's'}`,
    'All five networks',
    research ? 'Auto learn + research' : 'Core publishing',
  ];
}

export function PlanChooser({
  catalog,
  currentPlan,
  canManage,
  billingConfigured,
  timezone,
  onChanged,
}: {
  catalog: BillingCatalog;
  currentPlan: PlanName | null;
  canManage: boolean;
  billingConfigured: boolean;
  timezone: string;
  onChanged?: (message: string) => void;
}) {
  const [selection, setSelection] = useState<CustomSelection>(() => defaultSelection(catalog));
  const [quote, setQuote] = useState<BillingQuote | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const calcRef = useRef<HTMLElement>(null);
  const quoteAction = useAction((body: { plan: string; selection?: CustomSelection }) => api<BillingQuote>('/billing/quote', { method: 'POST', body }));
  const checkoutAction = useAction((quoteId: string) => api<CheckoutResult>('/billing/checkout', { method: 'POST', body: { quote_id: quoteId } }));

  const disabled = !canManage || !billingConfigured;
  const disabledReason = !billingConfigured ? 'Billing is not configured on this deployment.' : !canManage ? 'Only a workspace owner can change the plan.' : null;
  const minPrice = catalog.custom.base_cents;
  const maxPrice = catalog.custom.maximum_cents;

  async function choose(plan: string) {
    setMessage(null);
    checkoutAction.clear();
    const q = await quoteAction.run(plan === 'custom' ? { plan, selection } : { plan });
    if (q) setQuote(q);
  }

  async function proceed() {
    if (!quote) return;
    const r = await checkoutAction.run(quote.quote_id);
    if (!r) return;
    if (r.kind === 'redirect') {
      window.location.assign(r.url);
      return;
    }
    const text = r.immediate ? `Upgraded now to ${PLAN_LABELS[quote.plan]}.` : `Plan change to ${PLAN_LABELS[quote.plan]} scheduled for ${formatDateTime(r.effective_at, timezone)}.`;
    setQuote(null);
    setMessage(text);
    onChanged?.(text);
  }

  return (
    <div className="stack">
      {disabledReason ? <Banner tone="info">{disabledReason}</Banner> : null}
      {message ? (
        <Banner tone="success" title="Plan updated">
          {message}
        </Banner>
      ) : null}
      {quoteAction.error ? <ErrorNotice error={quoteAction.error} /> : null}
      <div className="grid-4">
        {catalog.plans.map((p) => (
          <section key={p.name} className={`card plan-card ${currentPlan === p.name ? 'current' : ''}`} aria-labelledby={`plan-${p.name}`}>
            <div className="row-between">
              <h2 id={`plan-${p.name}`} style={{ fontSize: 22 }}>
                {PLAN_LABELS[p.name]}
              </h2>
              {currentPlan === p.name ? <span className="badge tone-success">Current plan</span> : null}
            </div>
            <div>
              <p className="plan-price">{formatUsd(p.price_cents)}</p>
              <p className="small muted">per month</p>
            </div>
            <ul className="plan-features">
              {planFeatures(p).map((f) => (
                <li key={f}>{f}</li>
              ))}
            </ul>
            <button type="button" className={`btn ${p.name === 'standard' ? 'btn-primary' : ''}`} disabled={disabled || quoteAction.pending || currentPlan === p.name} onClick={() => choose(p.name)}>
              {currentPlan === p.name ? 'Current plan' : 'Choose plan'}
            </button>
          </section>
        ))}
        <section className={`card plan-card ${currentPlan === 'custom' ? 'current' : ''}`} aria-labelledby="plan-custom">
          <div className="row-between">
            <h2 id="plan-custom" style={{ fontSize: 22 }}>
              Custom
            </h2>
            {currentPlan === 'custom' ? <span className="badge tone-success">Current plan</span> : null}
          </div>
          <div>
            <p className="plan-price">
              {formatUsd(minPrice)}–{formatUsd(maxPrice)}
            </p>
            <p className="small muted">per month</p>
          </div>
          <ul className="plan-features">
            <li>Choose capacity</li>
            <li>Choose product count</li>
            <li>Select research features</li>
            <li>Maximum {formatUsd(maxPrice)} / month</li>
          </ul>
          <button
            type="button"
            className="btn"
            onClick={() => {
              calcRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
              calcRef.current?.focus();
            }}
          >
            Customize
          </button>
        </section>
      </div>
      <section className="card" ref={calcRef} tabIndex={-1} aria-labelledby="custom-h">
        <div className="card-header">
          <h2 id="custom-h">Build your Custom plan</h2>
        </div>
        <CustomCalculator catalog={catalog} value={selection} onChange={setSelection} />
        <div className="form-actions" style={{ marginTop: 16 }}>
          <button type="button" className="btn btn-primary" disabled={disabled || quoteAction.pending} onClick={() => choose('custom')}>
            {quoteAction.pending ? 'Preparing quote…' : 'Choose Custom plan'}
          </button>
        </div>
      </section>

      <Dialog
        open={quote !== null}
        onClose={() => setQuote(null)}
        title={quote ? `Review: ${PLAN_LABELS[quote.plan]}` : 'Review'}
        description="Prices are monthly in USD. Tax added where applicable."
        footer={
          <>
            <button type="button" className="btn btn-ghost" onClick={() => setQuote(null)}>
              Back
            </button>
            <button type="button" className="btn btn-primary" onClick={proceed} disabled={checkoutAction.pending}>
              {checkoutAction.pending ? 'Contacting Stripe…' : currentPlan && currentPlan !== 'trial' ? 'Confirm plan change' : 'Continue to secure checkout'}
            </button>
          </>
        }
      >
        {quote ? (
          <div className="stack">
            <p className="plan-price">{formatUsd(quote.price_cents)} / month</p>
            {quote.selection ? (
              <ul className="plan-features">
                <li>{formatNumber(quote.selection.posts)} posts / month</li>
                <li>{formatNumber(quote.selection.products)} active products</li>
                {quote.selection.autoLearn ? <li>Auto learn</li> : null}
                {quote.selection.competitorCheck ? <li>Competitor check</li> : null}
                {quote.selection.similarResearch ? <li>Similar-product research</li> : null}
              </ul>
            ) : null}
            {quote.better_value === 'standard' ? (
              <Banner tone="info" title="Standard offers better value">
                The Standard plan covers this selection for less. Your Custom selection has not been changed; you can continue or choose Standard instead.
              </Banner>
            ) : null}
            <p className="small muted">
              Upgrades take effect now with a prorated charge. Downgrades take effect at the next renewal. New subscriptions open Stripe’s secure checkout; payment is confirmed only after Stripe notifies Ayonix.
            </p>
            <p className="tiny muted">Quote valid until {formatDateTime(quote.expires_at, timezone)}.</p>
            {checkoutAction.error ? <ErrorNotice error={checkoutAction.error} /> : null}
          </div>
        ) : null}
      </Dialog>
    </div>
  );
}
