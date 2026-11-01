import { useState } from 'react';
import { useSearchParams } from 'react-router';
import type { CapabilityRow, Connection, Platform, ProviderStatus } from '@ayonix/contracts';
import { ConfirmDialog, Dialog } from '../components/overlay';
import { Badge, Banner, ErrorNotice, Loading, PageHeader, StaleNotice } from '../components/ui';
import { api } from '../lib/api';
import { formatDateTime } from '../lib/format';
import { useAction, useApi } from '../lib/hooks';
import { atLeast, CAPABILITY_STATUS_INFO, CONNECTION_STATE_INFO, PLATFORM_DESCRIPTIONS, PLATFORM_LABELS } from '../lib/labels';
import { useWorkspace } from '../state/session';

const SCOPES = [
  { scope: 'sns:read', text: 'Read workspace status, products, connected accounts and post results.' },
  { scope: 'sns:draft', text: 'Create campaign drafts and post content.' },
  { scope: 'sns:schedule', text: 'Preview and confirm schedules you approve in the conversation.' },
  { scope: 'sns:cancel', text: 'Cancel scheduled posts.' },
];

function ChatGptCard() {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const mcpUrl = `${window.location.origin}/mcp`;
  return (
    <section className="card" aria-labelledby="chatgpt-h">
      <div className="row-between">
        <div className="provider-head" style={{ marginBottom: 0 }}>
          <span className="provider-tile ai" aria-hidden="true">
            AI
          </span>
          <div>
            <h2 id="chatgpt-h" style={{ fontSize: 20 }}>
              ChatGPT
            </h2>
            <p className="small muted">Use your existing Ayonix account to connect.</p>
          </div>
        </div>
        <button type="button" className="btn btn-primary" onClick={() => setOpen(true)}>
          Setup guide
        </button>
      </div>
      <p className="small muted" style={{ marginTop: 12 }}>
        Connection status: <span className="strong">Not available</span>. This deployment does not report which ChatGPT sessions are connected; you can see ChatGPT activity in Settings › Events.
      </p>
      <Dialog open={open} onClose={() => setOpen(false)} title="Connect Ayonix-SNS to ChatGPT">
        <ol className="stack" style={{ paddingLeft: 20, margin: 0 }}>
          <li>
            In ChatGPT, add a connector (developer mode / custom connector) using this server URL:
            <div className="row" style={{ marginTop: 8 }}>
              <code className="mono" style={{ fontSize: 15 }}>
                {mcpUrl}
              </code>
              <button
                type="button"
                className="btn btn-sm"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(mcpUrl);
                    setCopied(true);
                  } catch {
                    setCopied(false);
                  }
                }}
              >
                Copy
              </button>
              <span role="status" className="small">
                {copied ? 'Copied.' : ''}
              </span>
            </div>
          </li>
          <li>When ChatGPT asks you to sign in, sign in with your existing Ayonix-SNS account and choose the workspace to connect.</li>
          <li>
            Review the permissions requested, then approve:
            <ul className="problem-list" style={{ marginTop: 6 }}>
              {SCOPES.map((s) => (
                <li key={s.scope}>
                  <code className="mono">{s.scope}</code> — {s.text}
                </li>
              ))}
            </ul>
          </li>
          <li>Ask ChatGPT to plan a post. Ayonix validates everything, asks for any required approval (for example TikTok creator consent on this website) and publishes at the chosen time, even after you close ChatGPT.</li>
        </ol>
        <p className="small muted">Social account connections are made here in Connectors, not in ChatGPT. You can disconnect ChatGPT at any time from ChatGPT’s connector settings.</p>
      </Dialog>
    </section>
  );
}

function CapabilityList({ rows }: { rows: CapabilityRow[] }) {
  if (!rows.length) return <p className="small muted">No capabilities reported yet. Use “Check capabilities”.</p>;
  return (
    <ul className="cap-list" aria-label="Capabilities">
      {rows.map((r) => (
        <li key={r.capability}>
          <span>{r.capability.replace(/_/g, ' ')}</span>
          <Badge tone={CAPABILITY_STATUS_INFO[r.status].tone}>{CAPABILITY_STATUS_INFO[r.status].label}</Badge>
          {r.detail ? <span className="muted">{r.detail}</span> : null}
        </li>
      ))}
    </ul>
  );
}

function ConnectionRow({ c, canManage, onChanged, onReconnect }: { c: Connection; canManage: boolean; onChanged: () => void; onReconnect: () => void }) {
  const ws = useWorkspace();
  const [confirm, setConfirm] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const probe = useAction(async () => {
    await api<unknown>(`/connections/${encodeURIComponent(c.id)}/probe`, { method: 'POST' });
    return true;
  });
  const remove = useAction(() => api<{ connection_id: string; revoked: boolean }>(`/connections/${encodeURIComponent(c.id)}`, { method: 'DELETE' }));
  const info = CONNECTION_STATE_INFO[c.state];
  const needsReconnect = c.state === 'reconnect_required' || c.state === 'expiring' || c.state === 'error';
  return (
    <div className="connection">
      <div className="row-between">
        <div>
          <p className="strong">{c.account_name}</p>
          <p className="small muted">{c.account_type}</p>
        </div>
        <Badge tone={info.tone}>{info.label}</Badge>
      </div>
      <CapabilityList rows={c.capabilities} />
      <p className="tiny muted">
        {c.last_verified_at ? `Last checked ${formatDateTime(c.last_verified_at, ws.timezone)}` : 'Not checked yet'}
        {c.token_expires_at ? ` · Access expires ${formatDateTime(c.token_expires_at, ws.timezone)}` : ''}
        {c.api_version ? ` · API ${c.api_version}` : ''}
      </p>
      {note ? <Banner tone="info">{note}</Banner> : null}
      {probe.error ? <ErrorNotice error={probe.error} /> : null}
      {canManage ? (
        <div className="row">
          {needsReconnect ? (
            <button type="button" className="btn btn-primary btn-sm" onClick={onReconnect}>
              Reconnect
            </button>
          ) : null}
          <button
            type="button"
            className="btn btn-sm"
            disabled={probe.pending}
            onClick={async () => {
              const r = await probe.run();
              if (r) {
                setNote('Capabilities checked.');
                onChanged();
              }
            }}
          >
            {probe.pending ? 'Checking…' : 'Check capabilities'}
          </button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setConfirm(true)}>
            Disconnect
          </button>
        </div>
      ) : null}
      <ConfirmDialog
        open={confirm}
        onClose={() => setConfirm(false)}
        title={`Disconnect ${c.account_name}?`}
        confirmLabel="Disconnect"
        danger
        pending={remove.pending}
        onConfirm={async () => {
          const r = await remove.run();
          if (r) {
            setConfirm(false);
            setNote(r.revoked ? null : 'Ayonix removed its access, but the network did not confirm revoking the token. You can also remove Ayonix in the network’s app settings.');
            onChanged();
          }
        }}
      >
        <p>Scheduled posts to this account will pause until you reconnect it. Posts that are already published stay on {PLATFORM_LABELS[c.provider]}.</p>
        {remove.error ? <ErrorNotice error={remove.error} /> : null}
      </ConfirmDialog>
    </div>
  );
}

function ProviderCard({ p, canManage, onChanged }: { p: ProviderStatus; canManage: boolean; onChanged: () => void }) {
  const authorize = useAction((provider: Platform, reconnectId?: string) =>
    api<{ authorize_url: string }>(`/connections/${provider}/authorize`, { method: 'POST', body: reconnectId ? { reconnect_connection_id: reconnectId } : {} }),
  );
  async function start(reconnectId?: string) {
    const r = await authorize.run(p.provider, reconnectId);
    if (r) window.location.assign(r.authorize_url);
  }
  const name = PLATFORM_LABELS[p.provider];
  return (
    <section className="card" aria-labelledby={`prov-${p.provider}`}>
      <div className="provider-head">
        <span className="provider-tile" aria-hidden="true">
          {name[0]}
        </span>
        <h2 id={`prov-${p.provider}`} style={{ fontSize: 20 }}>
          {name}
        </h2>
      </div>
      <p className="small muted">{PLATFORM_DESCRIPTIONS[p.provider]}</p>
      {p.provider === 'tiktok' ? <p className="small" style={{ marginTop: 6 }}>Each TikTok post needs the creator’s consent and settings on the approval page.</p> : null}
      {!p.configured ? (
        <div className="stack-sm" style={{ marginTop: 12 }}>
          <Badge tone="neutral">Not available on this deployment</Badge>
          <p className="small muted">{p.restriction ?? 'The operator has not configured this network yet.'}</p>
        </div>
      ) : (
        <div style={{ marginTop: 12 }}>
          {p.restriction ? <Banner tone="warning">{p.restriction}</Banner> : null}
          {p.connections.length === 0 ? (
            <div className="stack-sm">
              <Badge tone="neutral">{CONNECTION_STATE_INFO.disconnected.label}</Badge>
            </div>
          ) : (
            p.connections.map((c) => <ConnectionRow key={c.id} c={c} canManage={canManage} onChanged={onChanged} onReconnect={() => start(c.id)} />)
          )}
          {authorize.error ? <ErrorNotice error={authorize.error} /> : null}
          {canManage ? (
            <div className="row" style={{ marginTop: 12 }}>
              <button type="button" className={`btn ${p.connections.length ? '' : 'btn-primary'}`} disabled={authorize.pending} onClick={() => start()}>
                {authorize.pending ? `Opening ${name}…` : p.connections.length ? 'Connect another account' : 'Connect'}
              </button>
            </div>
          ) : null}
        </div>
      )}
    </section>
  );
}

export function ConnectorsPage() {
  const workspace = useWorkspace();
  const [params, setParams] = useSearchParams();
  const providers = useApi<ProviderStatus[]>('/connections');
  const canManage = atLeast(workspace.role, 'admin');
  const connected = params.get('connected') as Platform | null;
  const error = params.get('error');
  const dismiss = () => setParams({}, { replace: true });
  return (
    <>
      <PageHeader title="Connectors" subtitle="Connect your accounts. See what each channel supports." />
      {connected && PLATFORM_LABELS[connected] ? (
        <Banner tone="success" title={`${PLATFORM_LABELS[connected]} connected`} action={<button type="button" className="btn btn-sm" onClick={dismiss}>Dismiss</button>}>
          Check the account’s capabilities below; some features may still need network review.
        </Banner>
      ) : null}
      {error ? (
        <Banner tone="danger" title="The connection was not completed" action={<button type="button" className="btn btn-sm" onClick={dismiss}>Dismiss</button>}>
          {error}
        </Banner>
      ) : null}
      <ChatGptCard />
      {!canManage ? <Banner tone="info">Only workspace owners and admins can connect or disconnect accounts.</Banner> : null}
      <StaleNotice loadedAt={providers.loadedAt} error={providers.data ? providers.error : undefined} onRetry={providers.reload} refreshing={providers.refreshing} />
      {providers.loading && !providers.data ? <Loading label="Loading connectors…" /> : null}
      {providers.error && !providers.data ? <ErrorNotice error={providers.error} onRetry={providers.reload} /> : null}
      {providers.data ? (
        <div className="grid-3">
          {providers.data.map((p) => (
            <ProviderCard key={p.provider} p={p} canManage={canManage} onChanged={providers.reload} />
          ))}
        </div>
      ) : null}
      <p className="small muted">Plan entitlement and account capability are separate: a paid plan does not grant a network permission, and each network may require its own app review.</p>
    </>
  );
}
