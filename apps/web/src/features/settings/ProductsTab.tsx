import { useState, type FormEvent } from 'react';
import type { Page, Product, ProductClaim, ResearchJob } from '@ayonix/contracts';
import { Badge, Banner, EmptyState, ErrorNotice, Field, Loading } from '../../components/ui';
import { api, toApiError, type ApiRequestError } from '../../lib/api';
import { formatDateTime } from '../../lib/format';
import { useAction, useApi, usePoll } from '../../lib/hooks';
import { atLeast, jobStatus, RESEARCH_KIND_LABELS, type Tone } from '../../lib/labels';
import { newKey } from '../../lib/storage';
import { useWorkspace } from '../../state/session';

const STATUS_TONE: Record<Product['status'], Tone> = { draft: 'warning', approved: 'success', paused: 'neutral' };
const STATUS_LABEL: Record<Product['status'], string> = { draft: 'Needs approval', approved: 'Approved', paused: 'Paused' };

const lines = (s: string) =>
  s
    .split('\n')
    .map((x) => x.trim())
    .filter(Boolean);

function ProductForm({ product, onSaved, onCancel }: { product: Product | null; onSaved: (p: Product) => void; onCancel: () => void }) {
  const ownClaims = (kind: ProductClaim['kind']) => (product?.claims ?? []).filter((c) => c.kind === kind && c.status !== 'rejected' && !c.source_url).map((c) => c.text);
  const [name, setName] = useState(product?.name ?? '');
  const [audience, setAudience] = useState(product?.audience ?? '');
  const [language, setLanguage] = useState(product?.language ?? 'en');
  const [tone, setTone] = useState(product?.tone ?? '');
  const [urls, setUrls] = useState((product?.source_urls ?? []).join('\n'));
  const [claims, setClaims] = useState(ownClaims('claim').join('\n'));
  const [prohibited, setProhibited] = useState(ownClaims('prohibited').join('\n'));
  const save = useAction((body: Record<string, unknown>) =>
    product ? api<Product>(`/products/${encodeURIComponent(product.id)}`, { method: 'PATCH', body }) : api<Product>('/products', { method: 'POST', body }),
  );
  async function submit(e: FormEvent) {
    e.preventDefault();
    const body = {
      name: name.trim(),
      audience,
      language,
      tone,
      source_urls: lines(urls),
      proposed_claims: lines(claims),
      prohibited_claims: lines(prohibited),
      ...(product ? { expected_version: product.version } : {}),
    };
    const p = await save.run(body);
    if (p) onSaved(p);
  }
  const fe = save.error?.fieldErrors ?? {};
  return (
    <form className="stack" onSubmit={submit}>
      <h3>{product ? `Edit ${product.name}` : 'New product'}</h3>
      {product ? <p className="small muted">Saving creates version {product.version + 1}. It must be approved again before new posts use it.</p> : null}
      <Field label="Product name" error={fe.name}>
        <input className="input" value={name} maxLength={200} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label="Audience">
        <textarea className="textarea" rows={2} value={audience} maxLength={2000} onChange={(e) => setAudience(e.target.value)} style={{ minHeight: 70 }} />
      </Field>
      <div className="grid-2" style={{ gap: 12 }}>
        <Field label="Language" hint="e.g. en or en-AU">
          <input className="input" value={language} maxLength={35} onChange={(e) => setLanguage(e.target.value)} />
        </Field>
        <Field label="Tone" hint="e.g. Practical, confident, no hype">
          <input className="input" value={tone} maxLength={500} onChange={(e) => setTone(e.target.value)} />
        </Field>
      </div>
      <Field label="Owner-approved source URLs" hint="One https URL per line (up to 20). Auto learn reads only these." error={fe.source_urls}>
        <textarea className="textarea" rows={3} value={urls} onChange={(e) => setUrls(e.target.value)} style={{ minHeight: 80 }} />
      </Field>
      <Field label="Claims you can make" hint="One per line. Become usable when this version is approved." error={fe.claims}>
        <textarea className="textarea" rows={4} value={claims} onChange={(e) => setClaims(e.target.value)} style={{ minHeight: 90 }} />
      </Field>
      <Field label="Prohibited claims" hint="One per line. Content must never say these.">
        <textarea className="textarea" rows={3} value={prohibited} onChange={(e) => setProhibited(e.target.value)} style={{ minHeight: 80 }} />
      </Field>
      {save.error ? <ErrorNotice error={save.error} /> : null}
      <div className="form-actions">
        <button type="submit" className="btn btn-primary" disabled={save.pending || !name.trim()}>
          {save.pending ? 'Saving…' : product ? 'Save new version' : 'Create product'}
        </button>
        <button type="button" className="btn btn-ghost" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function ClaimsList({ product, canReview, onUpdated }: { product: Product; canReview: boolean; onUpdated: (p: Product) => void }) {
  const [error, setError] = useState<ApiRequestError | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  async function review(claim: ProductClaim, decision: 'approved' | 'rejected') {
    setBusy(claim.id);
    setError(null);
    try {
      onUpdated(await api<Product>(`/products/${encodeURIComponent(product.id)}/claims/${encodeURIComponent(claim.id)}`, { method: 'POST', body: { decision } }));
    } catch (e) {
      setError(toApiError(e));
    } finally {
      setBusy(null);
    }
  }
  const research = product.claims.filter((c) => c.status === 'proposed' && c.source_url);
  const groups: Array<{ title: string; items: ProductClaim[] }> = [
    { title: 'Approved claims', items: product.claims.filter((c) => c.kind === 'claim' && c.status === 'approved') },
    { title: 'Claims awaiting version approval', items: product.claims.filter((c) => c.kind === 'claim' && c.status === 'proposed' && !c.source_url) },
    { title: 'Prohibited claims', items: product.claims.filter((c) => c.kind === 'prohibited' && c.status !== 'rejected') },
  ];
  return (
    <div className="stack">
      {error ? <ErrorNotice error={error} /> : null}
      {research.length ? (
        <div className="stack-sm">
          <h3>Research-proposed claims to review</h3>
          <p className="small muted">Found by research. Nothing becomes usable until a person approves it.</p>
          <ul className="media-list">
            {research.map((c) => (
              <li key={c.id} className="media-item" style={{ display: 'grid' }}>
                <span>{c.text}</span>
                {c.source_url ? (
                  <a className="small" href={c.source_url} target="_blank" rel="noopener noreferrer">
                    Source
                  </a>
                ) : null}
                {canReview ? (
                  <span className="row">
                    <button type="button" className="btn btn-sm" disabled={busy === c.id} onClick={() => review(c, 'approved')}>
                      Approve
                    </button>
                    <button type="button" className="btn btn-sm btn-ghost" disabled={busy === c.id} onClick={() => review(c, 'rejected')}>
                      Reject
                    </button>
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {groups.map((g) => (
        <div key={g.title} className="stack-sm">
          <h3>{g.title}</h3>
          {g.items.length ? (
            <ul className="problem-list">
              {g.items.map((c) => (
                <li key={c.id}>{c.text}</li>
              ))}
            </ul>
          ) : (
            <p className="small muted">None.</p>
          )}
        </div>
      ))}
    </div>
  );
}

function ResearchPanel({ product }: { product: Product }) {
  const ws = useWorkspace();
  const jobs = useApi<ResearchJob[]>(`/products/${encodeURIComponent(product.id)}/research`);
  const [competitors, setCompetitors] = useState('');
  const [question, setQuestion] = useState('');
  const [error, setError] = useState<ApiRequestError | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const running = (jobs.data ?? []).some((j) => j.status === 'queued' || j.status === 'running');
  usePoll(
    async () => {
      jobs.reload();
      return false;
    },
    5000,
    running,
  );
  const ent = ws.entitlements;
  const canRun = atLeast(ws.role, 'editor');
  function reason(enabled: boolean): string | null {
    if (!ws.integrations.research) return 'Research is not configured on this deployment.';
    if (!enabled) return 'Not included in the current plan.';
    if (product.status === 'paused') return 'Activate this product first.';
    if (!canRun) return 'Editors, admins and owners can run research.';
    return null;
  }
  async function run(path: 'learn' | 'competitors' | 'research', body: Record<string, unknown>) {
    setPending(path);
    setError(null);
    try {
      await api<ResearchJob>(`/products/${encodeURIComponent(product.id)}/${path}`, { method: 'POST', body: { ...body, idempotency_key: newKey() } });
      jobs.reload();
      if (path === 'competitors') setCompetitors('');
      if (path === 'research') setQuestion('');
    } catch (e) {
      setError(toApiError(e));
    } finally {
      setPending(null);
    }
  }
  const learnReason = reason(ent.auto_learn) ?? (product.source_urls.length ? null : 'Add owner-approved source URLs to the product first.');
  const compReason = reason(ent.competitor_check);
  const simReason = reason(ent.similar_research);
  return (
    <div className="stack">
      <h3>Research</h3>
      <p className="small muted">Results are proposals with dated sources. Nothing changes the product or any post until a person approves it. Monthly limits apply per product; no extra charges.</p>
      {error ? <ErrorNotice error={error} /> : null}
      <div className="grid-3">
        <div className="stack-sm">
          <p className="strong">{RESEARCH_KIND_LABELS.auto_learn}</p>
          <p className="small muted">Read your approved source URLs and propose evidence-backed claims.</p>
          <button type="button" className="btn" disabled={Boolean(learnReason) || pending !== null} onClick={() => run('learn', {})}>
            {pending === 'learn' ? 'Starting…' : 'Learn'}
          </button>
          {learnReason ? <p className="small muted">{learnReason}</p> : null}
        </div>
        <div className="stack-sm">
          <Field label="Competitor URLs" hint="One public https URL per line.">
            <textarea className="textarea" rows={3} style={{ minHeight: 80 }} value={competitors} onChange={(e) => setCompetitors(e.target.value)} disabled={Boolean(compReason)} />
          </Field>
          <button type="button" className="btn" disabled={Boolean(compReason) || pending !== null || !lines(competitors).length} onClick={() => run('competitors', { source_urls: lines(competitors) })}>
            {pending === 'competitors' ? 'Starting…' : 'Competitor check'}
          </button>
          {compReason ? <p className="small muted">{compReason}</p> : null}
        </div>
        <div className="stack-sm">
          <Field label="Similar-product question" hint="What should be compared?">
            <input className="input" value={question} maxLength={1000} onChange={(e) => setQuestion(e.target.value)} disabled={Boolean(simReason)} />
          </Field>
          <button type="button" className="btn" disabled={Boolean(simReason) || pending !== null || !question.trim()} onClick={() => run('research', { question: question.trim() })}>
            {pending === 'research' ? 'Starting…' : 'Similar research'}
          </button>
          {simReason ? <p className="small muted">{simReason}</p> : null}
        </div>
      </div>
      {jobs.error ? <ErrorNotice error={jobs.error} onRetry={jobs.reload} /> : null}
      {jobs.loading && !jobs.data ? <Loading label="Loading research jobs…" /> : null}
      {jobs.data && jobs.data.length === 0 ? <p className="small muted">No research has been run for this product.</p> : null}
      {jobs.data && jobs.data.length ? (
        <ul className="media-list" aria-live="polite">
          {jobs.data.map((j) => {
            const st = jobStatus(j.status);
            return (
              <li key={j.id} className="media-item" style={{ display: 'grid', gap: 8 }}>
                <span className="row-between">
                  <span className="strong">
                    {RESEARCH_KIND_LABELS[j.kind]} · {formatDateTime(j.created_at, ws.timezone)}
                  </span>
                  <Badge tone={st.tone}>{st.label}</Badge>
                </span>
                {j.error ? <span className="field-error">{j.error}</span> : null}
                {j.sources.length ? (
                  <details>
                    <summary className="small">{j.sources.length} source{j.sources.length === 1 ? '' : 's'}</summary>
                    <ul className="problem-list small">
                      {j.sources.map((s) => (
                        <li key={s.url}>
                          <a href={s.url} target="_blank" rel="noopener noreferrer">
                            {s.title ?? s.url}
                          </a>{' '}
                          · retrieved {formatDateTime(s.retrieved_at, ws.timezone)} · {s.status}
                        </li>
                      ))}
                    </ul>
                  </details>
                ) : null}
                {j.proposed_changes.length ? (
                  <details>
                    <summary className="small">{j.proposed_changes.length} proposed change{j.proposed_changes.length === 1 ? '' : 's'}</summary>
                    <ul className="problem-list small">
                      {j.proposed_changes.map((c, i) => (
                        <li key={i}>
                          {c.text}{' '}
                          <a href={c.source_url} target="_blank" rel="noopener noreferrer">
                            (source)
                          </a>
                        </li>
                      ))}
                    </ul>
                  </details>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}

function ProductDetail({ product, onUpdated, onEdit }: { product: Product; onUpdated: (p: Product) => void; onEdit: () => void }) {
  const ws = useWorkspace();
  const approve = useAction(() => api<Product>(`/products/${encodeURIComponent(product.id)}/approve`, { method: 'POST', body: { expected_version: product.version } }));
  const setActive = useAction((active: boolean) => api<Product>(`/products/${encodeURIComponent(product.id)}/active`, { method: 'POST', body: { active } }));
  const canEdit = atLeast(ws.role, 'editor');
  const canPause = atLeast(ws.role, 'admin');
  const needsApproval = product.approved_version !== product.version;
  return (
    <div className="stack">
      <div className="row-between">
        <div>
          <h3 style={{ fontSize: 20 }}>{product.name}</h3>
          <p className="small muted">
            Version {product.version} · {product.approved_version ? `approved version ${product.approved_version}` : 'never approved'} · updated {formatDateTime(product.updated_at, ws.timezone)}
          </p>
        </div>
        <Badge tone={STATUS_TONE[product.status]}>{STATUS_LABEL[product.status]}</Badge>
      </div>
      <dl className="dl">
        <dt>Audience</dt>
        <dd>{product.audience || <span className="muted">Not set</span>}</dd>
        <dt>Language</dt>
        <dd>{product.language}</dd>
        <dt>Tone</dt>
        <dd>{product.tone || <span className="muted">Not set</span>}</dd>
        <dt>Sources</dt>
        <dd>
          {product.source_urls.length ? (
            <ul className="problem-list">
              {product.source_urls.map((u) => (
                <li key={u}>
                  <a href={u} target="_blank" rel="noopener noreferrer">
                    {u}
                  </a>
                </li>
              ))}
            </ul>
          ) : (
            <span className="muted">None</span>
          )}
        </dd>
      </dl>
      {needsApproval && product.status !== 'paused' ? (
        <Banner
          tone="warning"
          title={`Version ${product.version} is not approved`}
          action={
            canEdit ? (
              <button
                type="button"
                className="btn btn-sm btn-primary"
                disabled={approve.pending}
                onClick={async () => {
                  const p = await approve.run();
                  if (p) onUpdated(p);
                }}
              >
                {approve.pending ? 'Approving…' : `Approve version ${product.version}`}
              </button>
            ) : null
          }
        >
          Approving locks this exact text, sources and claims for use in posts.
        </Banner>
      ) : null}
      {approve.error ? <ErrorNotice error={approve.error} /> : null}
      {setActive.error ? <ErrorNotice error={setActive.error} /> : null}
      <div className="form-actions">
        {canEdit ? (
          <button type="button" className="btn" onClick={onEdit}>
            Edit profile
          </button>
        ) : null}
        {canPause ? (
          <button
            type="button"
            className="btn btn-ghost"
            disabled={setActive.pending}
            onClick={async () => {
              const p = await setActive.run(product.status === 'paused');
              if (p) onUpdated(p);
            }}
          >
            {product.status === 'paused' ? 'Activate' : 'Pause'}
          </button>
        ) : null}
      </div>
      <hr className="divider" />
      <ClaimsList product={product} canReview={canEdit} onUpdated={onUpdated} />
      <hr className="divider" />
      <ResearchPanel product={product} />
    </div>
  );
}

export function ProductsTab() {
  const ws = useWorkspace();
  const list = useApi<Page<Product>>('/products');
  const [more, setMore] = useState<{ items: Product[]; cursor: string | null } | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState<'new' | 'edit' | null>(null);
  const [overrides, setOverrides] = useState<Record<string, Product>>({});
  const [moreError, setMoreError] = useState<ApiRequestError | null>(null);
  const base = list.data?.items ?? [];
  const merged = [...base, ...(more?.items ?? [])].map((p) => overrides[p.id] ?? p);
  const extraNew = Object.values(overrides).filter((p) => !merged.some((m) => m.id === p.id));
  const products = [...extraNew, ...merged];
  const cursor = more ? more.cursor : (list.data?.next_cursor ?? null);
  const current = products.find((p) => p.id === selected) ?? null;
  const canEdit = atLeast(ws.role, 'editor');

  const upsert = (p: Product) => setOverrides((prev) => ({ ...prev, [p.id]: p }));

  return (
    <div className="grid-main-side" style={{ gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 2fr)' }}>
      <section className="card stack" aria-labelledby="prod-h">
        <div className="card-header">
          <h2 id="prod-h">Products</h2>
          {canEdit ? (
            <button
              type="button"
              className="btn btn-sm btn-primary"
              onClick={() => {
                setSelected(null);
                setEditing('new');
              }}
            >
              New product
            </button>
          ) : null}
        </div>
        <p className="small muted">
          A product is a marketing profile: approved claims, sources, audience and tone. Your plan includes {ws.entitlements.products} active product{ws.entitlements.products === 1 ? '' : 's'}.
        </p>
        {list.loading && !list.data ? <Loading label="Loading products…" /> : null}
        {list.error ? <ErrorNotice error={list.error} onRetry={list.reload} /> : null}
        {list.data && products.length === 0 ? <EmptyState title="No products yet">Create a product profile before scheduling posts.</EmptyState> : null}
        <ul className="media-list">
          {products.map((p) => (
            <li key={p.id}>
              <button
                type="button"
                className="media-item"
                style={{ width: '100%', cursor: 'pointer', textAlign: 'left', borderColor: p.id === selected ? 'var(--accent)' : undefined }}
                aria-pressed={p.id === selected}
                onClick={() => {
                  setSelected(p.id);
                  setEditing(null);
                }}
              >
                <span className="name strong">{p.name}</span>
                <Badge tone={STATUS_TONE[p.status]}>{STATUS_LABEL[p.status]}</Badge>
              </button>
            </li>
          ))}
        </ul>
        {moreError ? <ErrorNotice error={moreError} /> : null}
        {cursor ? (
          <button
            type="button"
            className="btn btn-ghost"
            onClick={async () => {
              setMoreError(null);
              try {
                const page = await api<Page<Product>>(`/products?cursor=${encodeURIComponent(cursor)}`);
                setMore((prev) => ({ items: [...(prev?.items ?? []), ...page.items], cursor: page.next_cursor }));
              } catch (e) {
                setMoreError(toApiError(e));
              }
            }}
          >
            Load more
          </button>
        ) : null}
      </section>
      <section className="card" aria-label="Product details">
        {editing === 'new' ? (
          <ProductForm
            product={null}
            onSaved={(p) => {
              upsert(p);
              setSelected(p.id);
              setEditing(null);
            }}
            onCancel={() => setEditing(null)}
          />
        ) : current && editing === 'edit' ? (
          <ProductForm
            key={`${current.id}-${current.version}`}
            product={current}
            onSaved={(p) => {
              upsert(p);
              setEditing(null);
            }}
            onCancel={() => setEditing(null)}
          />
        ) : current ? (
          <ProductDetail key={current.id} product={current} onUpdated={upsert} onEdit={() => setEditing('edit')} />
        ) : (
          <p className="muted">Select a product to see its profile, claims and research.</p>
        )}
      </section>
    </div>
  );
}
