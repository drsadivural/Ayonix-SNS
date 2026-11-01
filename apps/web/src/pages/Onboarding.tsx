import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import type { BillingCatalog, WorkspaceSummary } from '@ayonix/contracts';
import { PlainLayout } from '../components/AppShell';
import { Banner, ErrorNotice, Field, Loading } from '../components/ui';
import { PlanChooser } from '../features/billing/PlanChooser';
import { api } from '../lib/api';
import { browserTimezone, timezones } from '../lib/format';
import { useAction, useApi } from '../lib/hooks';
import { atLeast, PLAN_LABELS } from '../lib/labels';
import { useSession } from '../state/session';

type Step = 'account' | 'plan' | 'channels';
const STEPS: Array<{ id: Step; label: string }> = [
  { id: 'account', label: 'Account' },
  { id: 'plan', label: 'Plan' },
  { id: 'channels', label: 'Channels' },
];

function Steps({ current }: { current: Step }) {
  const idx = STEPS.findIndex((s) => s.id === current);
  return (
    <ol className="steps" aria-label="Onboarding steps">
      {STEPS.map((s, i) => (
        <li key={s.id} aria-current={s.id === current ? 'step' : undefined} className={i < idx ? 'done' : undefined}>
          {i + 1}. {s.label}
          {i < idx ? <span className="visually-hidden"> (done)</span> : null}
        </li>
      ))}
    </ol>
  );
}

function AccountStep() {
  const { refreshMe } = useSession();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [timezone, setTimezone] = useState(browserTimezone);
  const create = useAction((body: { name: string; timezone: string }) => api<{ id: string; name: string; timezone: string }>('/workspaces', { method: 'POST', body, workspaceId: null }));
  async function submit(e: FormEvent) {
    e.preventDefault();
    const ws = await create.run({ name: name.trim(), timezone });
    if (!ws) return;
    await refreshMe(ws.id);
    navigate('/onboarding?step=plan', { replace: true });
  }
  const zones = timezones();
  return (
    <section className="card stack" aria-labelledby="acct-h">
      <h2 id="acct-h">Create your workspace</h2>
      <p className="muted small">A workspace holds your products, connected accounts, schedules and team.</p>
      <form className="stack" onSubmit={submit} noValidate>
        <Field label="Workspace name" error={create.error?.fieldErrors.name}>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} autoComplete="organization" />
        </Field>
        <Field label="Timezone" hint="Schedules are entered and shown in this timezone, with UTC alongside." error={create.error?.fieldErrors.timezone}>
          <select className="select" value={timezone} onChange={(e) => setTimezone(e.target.value)}>
            {(zones.includes(timezone) ? zones : [timezone, ...zones]).map((z) => (
              <option key={z} value={z}>
                {z}
              </option>
            ))}
          </select>
        </Field>
        {create.error && !Object.keys(create.error.fieldErrors).length ? <ErrorNotice error={create.error} /> : null}
        <button type="submit" className="btn btn-primary" disabled={create.pending || !name.trim()}>
          {create.pending ? 'Creating…' : 'Create workspace'}
        </button>
      </form>
    </section>
  );
}

function PlanStep({ workspace }: { workspace: WorkspaceSummary }) {
  const navigate = useNavigate();
  const { setWorkspace } = useSession();
  const catalog = useApi<BillingCatalog>('/billing/catalog');
  const trial = useAction(() => api<WorkspaceSummary>('/workspace/trial', { method: 'POST' }));
  const owner = atLeast(workspace.role, 'owner');
  const hasPlan = workspace.entitlements.status !== 'none';
  return (
    <div className="stack">
      {hasPlan ? (
        <Banner
          tone="success"
          title={`Current plan: ${workspace.entitlements.plan ? PLAN_LABELS[workspace.entitlements.plan] : 'none'}`}
          action={
            <Link className="btn btn-sm btn-primary" to="/onboarding?step=channels">
              Continue to channels
            </Link>
          }
        />
      ) : null}
      <section className="card stack" aria-labelledby="trial-h">
        <h2 id="trial-h">Try the website first</h2>
        <p className="muted small">
          7-day website trial: 5 destination publications, 1 product, no card. It does not convert to a paid plan automatically. Publishing pauses when it ends; drafts are kept.
        </p>
        {trial.error ? <ErrorNotice error={trial.error} /> : null}
        <div className="form-actions">
          <button
            type="button"
            className="btn"
            disabled={!owner || hasPlan || trial.pending}
            onClick={async () => {
              const w = await trial.run();
              if (w) {
                setWorkspace(w);
                navigate('/onboarding?step=channels', { replace: true });
              }
            }}
          >
            {trial.pending ? 'Starting trial…' : 'Start 7-day trial'}
          </button>
          {!owner ? <span className="small muted">Only a workspace owner can start a trial or choose a plan.</span> : null}
        </div>
      </section>
      <h2>Or choose a monthly plan</h2>
      <p className="muted small">Monthly subscriptions in USD. Tax added where applicable. Payment is confirmed only after a verified Stripe notification.</p>
      {catalog.error ? <ErrorNotice error={catalog.error} onRetry={catalog.reload} /> : null}
      {catalog.loading && !catalog.data ? <Loading label="Loading plans…" /> : null}
      {catalog.data ? (
        <PlanChooser
          catalog={catalog.data}
          currentPlan={workspace.entitlements.plan}
          canManage={owner}
          billingConfigured={workspace.integrations.stripe}
          timezone={workspace.timezone}
        />
      ) : null}
      <div className="form-actions">
        <Link className="btn btn-ghost" to="/onboarding?step=channels">
          Skip for now
        </Link>
        <span className="small muted">Without a plan or trial, nothing can be scheduled or published.</span>
      </div>
    </div>
  );
}

function ChannelsStep({ workspace }: { workspace: WorkspaceSummary }) {
  return (
    <section className="card stack" aria-labelledby="ch-h">
      <h2 id="ch-h">Connect your channels</h2>
      <p>
        Connect LinkedIn, Facebook, Instagram, TikTok or YouTube accounts in <strong>Connectors</strong>. Each network must approve access for your account before Ayonix can publish there.
      </p>
      {!workspace.entitlements.can_confirm_schedules ? (
        <Banner tone="warning" title="Publishing is not active yet">
          {workspace.entitlements.restriction ?? 'Choose a plan or trial to schedule posts.'}
        </Banner>
      ) : null}
      <div className="form-actions">
        <Link className="btn btn-primary" to="/connectors">
          Go to Connectors
        </Link>
        <Link className="btn btn-ghost" to="/dashboard">
          Skip to dashboard
        </Link>
      </div>
      <p className="small muted">Skipping is fine, but no posts can be published until at least one account is connected and its permissions are confirmed.</p>
    </section>
  );
}

export function OnboardingPage() {
  const { me, workspace, workspaceError, workspaceLoading, refreshWorkspace } = useSession();
  const [params] = useSearchParams();
  const verifyError = params.get('error');
  const hasWorkspace = (me?.workspaces.length ?? 0) > 0;
  const requested = params.get('step') as Step | null;
  let step: Step = 'account';
  if (hasWorkspace) step = requested === 'channels' || requested === 'plan' ? requested : workspace && workspace.entitlements.status !== 'none' ? 'channels' : 'plan';

  return (
    <PlainLayout wide>
      <div className="stack-sm">
        <h1>{step === 'account' ? 'Set up your workspace' : step === 'plan' ? 'Choose your plan' : 'Connect channels'}</h1>
        <p className="muted">Website onboarding: Account → Plan → Channels.</p>
      </div>
      <Steps current={step} />
      {verifyError ? (
        <Banner tone="danger" title="Email verification failed">
          The verification link was invalid or expired. <Link to="/verify-email">Send a new link</Link>.
        </Banner>
      ) : null}
      {step === 'account' ? <AccountStep /> : null}
      {step !== 'account' && workspaceError && !workspace ? <ErrorNotice error={workspaceError} onRetry={refreshWorkspace} /> : null}
      {step !== 'account' && !workspace && workspaceLoading ? <Loading label="Loading workspace…" /> : null}
      {step === 'plan' && workspace ? <PlanStep workspace={workspace} /> : null}
      {step === 'channels' && workspace ? <ChannelsStep workspace={workspace} /> : null}
    </PlainLayout>
  );
}
