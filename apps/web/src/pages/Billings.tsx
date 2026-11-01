import { useState } from 'react';
import { useSearchParams } from 'react-router';
import type { BillingCatalog, Invoice, Subscription } from '@ayonix/contracts';
import { formatUsd } from '@ayonix/domain';
import { Badge, Banner, EmptyState, ErrorNotice, Loading, PageHeader, StaleNotice } from '../components/ui';
import { PlanChooser } from '../features/billing/PlanChooser';
import { api } from '../lib/api';
import { formatDate, formatDateTime } from '../lib/format';
import { useAction, useApi, usePoll } from '../lib/hooks';
import { atLeast, PLAN_LABELS, SUBSCRIPTION_STATUS_INFO } from '../lib/labels';
import { useSession, useWorkspace } from '../state/session';

const POLL_MS = 3000;
const POLL_LIMIT = 40; // ~2 minutes

function statusNotice(s: Subscription, tz: string) {
  switch (s.status) {
    case 'past_due':
      return (
        <Banner tone="danger" title="Payment failed">
          Update the payment method in Manage billing. New schedules are paused and due posts are held until payment recovers.
        </Banner>
      );
    case 'unpaid':
    case 'suspended':
      return (
        <Banner tone="danger" title="Subscription suspended">
          Publishing is paused. Resolve the outstanding payment in Manage billing.
        </Banner>
      );
    case 'canceled':
      return (
        <Banner tone="warning" title="Subscription canceled">
          Publishing is paused. Drafts and history are kept. Choose a plan to resume.
        </Banner>
      );
    case 'expired':
      return (
        <Banner tone="warning" title={s.plan === 'trial' ? 'Trial ended' : 'Subscription expired'}>
          Drafts are kept; publishing is paused. Choose a plan to continue.
        </Banner>
      );
    case 'incomplete':
      return (
        <Banner tone="warning" title="Waiting for payment confirmation">
          Stripe has not confirmed the first payment yet.
        </Banner>
      );
    case 'trialing':
      return s.trial_ends_at ? (
        <Banner tone="info" title="Website trial">
          Trial ends {formatDateTime(s.trial_ends_at, tz)}. It does not convert to a paid plan automatically.
        </Banner>
      ) : null;
    default:
      return null;
  }
}

function CheckoutReturn({ onConfirmed }: { onConfirmed: () => void }) {
  const [params, setParams] = useSearchParams();
  const state = params.get('checkout');
  const [tries, setTries] = useState(0);
  const [confirmed, setConfirmed] = useState<Subscription | null>(null);
  const polling = state === 'returned' && !confirmed && tries < POLL_LIMIT;
  usePoll(
    async () => {
      const s = await api<Subscription>('/billing/subscription');
      setTries((t) => t + 1);
      if (s.status === 'active' || s.status === 'trialing') {
        setConfirmed(s);
        onConfirmed();
        return true;
      }
      return false;
    },
    POLL_MS,
    polling,
  );
  if (state === 'canceled') {
    return (
      <Banner tone="info" title="Checkout canceled" action={<button type="button" className="btn btn-sm" onClick={() => setParams({}, { replace: true })}>Dismiss</button>}>
        No payment was taken. You can choose a plan again at any time.
      </Banner>
    );
  }
  if (state !== 'returned') return null;
  if (confirmed) {
    return (
      <Banner tone="success" title="Payment confirmed" action={<button type="button" className="btn btn-sm" onClick={() => setParams({}, { replace: true })}>Dismiss</button>}>
        Stripe confirmed your {confirmed.plan ? PLAN_LABELS[confirmed.plan] : ''} subscription. Your plan is active.
      </Banner>
    );
  }
  return (
    <Banner tone="info" title="Payment received by Stripe — waiting for confirmation" role="status">
      {polling ? (
        <span className="row">
          <span className="spinner" aria-hidden="true" /> Checking for Stripe’s confirmation… Do not pay again.
        </span>
      ) : (
        'Confirmation is taking longer than usual. It can take a few minutes; refresh this page later. Do not pay again.'
      )}
    </Banner>
  );
}

function Invoices({ owner }: { owner: boolean }) {
  const invoices = useApi<Invoice[]>(owner ? '/billing/invoices' : null);
  const ws = useWorkspace();
  if (!owner) return <p className="small muted">Only workspace owners can see invoices.</p>;
  if (invoices.loading && !invoices.data) return <Loading label="Loading invoices…" />;
  if (invoices.error) {
    if (invoices.error.status === 403) return <p className="small muted">You do not have permission to see invoices.</p>;
    return <ErrorNotice error={invoices.error} onRetry={invoices.reload} />;
  }
  if (!invoices.data?.length) return <EmptyState title="No invoices yet">Invoices appear here after Stripe issues them.</EmptyState>;
  return (
    <div className="table-wrap">
      <table className="table table-stack">
        <caption className="visually-hidden">Invoices</caption>
        <thead>
          <tr>
            <th scope="col">Date</th>
            <th scope="col">Number</th>
            <th scope="col">Period</th>
            <th scope="col">Status</th>
            <th scope="col" className="num">
              Amount
            </th>
            <th scope="col">Invoice</th>
          </tr>
        </thead>
        <tbody>
          {invoices.data.map((i) => (
            <tr key={i.id}>
              <td data-label="Date">{formatDate(i.created_at, ws.timezone)}</td>
              <td data-label="Number">{i.number ?? '—'}</td>
              <td data-label="Period">
                {i.period_start ? formatDate(i.period_start, ws.timezone) : '—'} – {i.period_end ? formatDate(i.period_end, ws.timezone) : '—'}
              </td>
              <td data-label="Status">
                <Badge tone={i.status === 'paid' ? 'success' : i.status === 'open' ? 'warning' : i.status === 'uncollectible' ? 'danger' : 'neutral'}>{i.status}</Badge>
              </td>
              <td data-label="Amount" className="num">
                {formatUsd(i.status === 'paid' ? i.amount_paid_cents : i.amount_due_cents)} {i.currency.toUpperCase()}
              </td>
              <td data-label="Invoice">
                {i.hosted_invoice_url ? (
                  <a href={i.hosted_invoice_url} target="_blank" rel="noopener noreferrer">
                    View<span className="visually-hidden"> invoice {i.number ?? i.id}</span>
                  </a>
                ) : (
                  '—'
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function BillingsPage() {
  const workspace = useWorkspace();
  const { refreshWorkspace } = useSession();
  const tz = workspace.timezone;
  const owner = atLeast(workspace.role, 'owner');
  const sub = useApi<Subscription>('/billing/subscription');
  const catalog = useApi<BillingCatalog>('/billing/catalog');
  const portal = useAction(() => api<{ url: string }>('/billing/portal', { method: 'POST' }));
  const s = sub.data;
  const status = s ? SUBSCRIPTION_STATUS_INFO[s.status] : null;

  return (
    <>
      <PageHeader
        title="Billings"
        subtitle="Monthly subscriptions in USD. Tax added where applicable."
        actions={
          owner && s?.portal_available ? (
            <button
              type="button"
              className="btn"
              disabled={portal.pending}
              onClick={async () => {
                const r = await portal.run();
                if (r) window.location.assign(r.url);
              }}
            >
              {portal.pending ? 'Opening Stripe…' : 'Manage billing'}
            </button>
          ) : null
        }
      />
      <CheckoutReturn
        onConfirmed={() => {
          sub.reload();
          refreshWorkspace();
        }}
      />
      {!workspace.integrations.stripe ? (
        <Banner tone="warning" title="Billing is not configured on this deployment">
          Plans cannot be purchased or changed here until the operator configures Stripe.
        </Banner>
      ) : null}
      {portal.error ? <ErrorNotice error={portal.error} /> : null}

      <section className="card" aria-labelledby="sub-h">
        <div className="card-header">
          <h2 id="sub-h">Current subscription</h2>
          {status ? <Badge tone={status.tone}>{status.label}</Badge> : null}
        </div>
        <StaleNotice loadedAt={sub.loadedAt} error={s ? sub.error : undefined} onRetry={sub.reload} refreshing={sub.refreshing} />
        {sub.loading && !s ? <Loading label="Loading subscription…" /> : null}
        {sub.error && !s ? <ErrorNotice error={sub.error} onRetry={sub.reload} /> : null}
        {s ? (
          <div className="stack">
            <dl className="dl">
              <dt>Plan</dt>
              <dd>{s.plan ? PLAN_LABELS[s.plan] : 'No plan'}</dd>
              <dt>Price</dt>
              <dd>{s.price_cents !== null ? `${formatUsd(s.price_cents)} / month (tax added where applicable)` : 'Not available'}</dd>
              <dt>{s.cancel_at_period_end ? 'Access until' : 'Next invoice'}</dt>
              <dd>{s.current_period_end ? formatDateTime(s.current_period_end, tz) : 'Not available'}</dd>
              {s.pending_change ? (
                <>
                  <dt>Scheduled change</dt>
                  <dd>
                    {PLAN_LABELS[s.pending_change.plan]} from {formatDateTime(s.pending_change.effective_at, tz)}
                  </dd>
                </>
              ) : null}
              <dt>Publications this cycle</dt>
              <dd>
                {workspace.quota.period_id ? `${workspace.quota.used} used · ${workspace.quota.reserved} reserved · ${workspace.quota.available} available of ${workspace.quota.allowance}` : 'No active cycle'}
              </dd>
            </dl>
            {s.cancel_at_period_end ? <Banner tone="warning">The subscription is set to cancel at the end of the current period. Reactivate it in Manage billing.</Banner> : null}
            {statusNotice(s, tz)}
            {s.status === 'none' ? <p className="small muted">This workspace has no plan. Choose one below to start scheduling.</p> : null}
          </div>
        ) : null}
      </section>

      {catalog.loading && !catalog.data ? <Loading label="Loading plans…" /> : null}
      {catalog.error && !catalog.data ? <ErrorNotice error={catalog.error} onRetry={catalog.reload} /> : null}
      {catalog.data ? (
        <PlanChooser
          catalog={catalog.data}
          currentPlan={s && ['active', 'trialing', 'past_due'].includes(s.status) ? s.plan : null}
          canManage={owner}
          billingConfigured={workspace.integrations.stripe}
          timezone={tz}
          onChanged={() => {
            sub.reload();
            refreshWorkspace();
          }}
        />
      ) : null}

      <section className="card" aria-labelledby="inv-h">
        <h2 id="inv-h">Invoices</h2>
        <Invoices owner={owner} />
      </section>
    </>
  );
}
