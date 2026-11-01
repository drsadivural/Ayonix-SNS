// Schedule composer (design: schedule.png). Draft → Save (POST /posts, new
// immutable revision) → Preview (server binds content, time, quota and
// approvals into a short-lived token) → Confirm. Nothing is scheduled until
// the server confirms; drafts survive refresh via stored ids.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';
import type {
  Asset,
  Campaign,
  DestinationInput,
  Page,
  Platform,
  PostFormat,
  PostRevision,
  Product,
  ProviderStatus,
  ScheduleConfirmation,
  SchedulePreview,
  WorkspaceSummary,
} from '@ayonix/contracts';
import { CAPTION_LIMITS, PLATFORM_FORMATS } from '@ayonix/domain';
import { LocalTimePicker, evaluateLocalTime, type LocalTimeValue } from '../../components/LocalTimePicker';
import { QuotaMeter } from '../../components/QuotaMeter';
import { Badge, Banner, ErrorNotice, Field, Loading, StatusBadge } from '../../components/ui';
import { api, toApiError, uploadWithProgress, type ApiRequestError } from '../../lib/api';
import { formatBytes, formatDateTime, formatNumber, nowMs } from '../../lib/format';
import { useApi } from '../../lib/hooks';
import { FORMAT_LABELS, PLATFORM_LABELS, TARGET_STATE_INFO } from '../../lib/labels';
import { STORAGE_KEYS, newKey, readJson, writeJson } from '../../lib/storage';

const ALLOWED_MIME = /^(image\/(png|jpeg|gif|webp)|video\/(mp4|quicktime))$/;
const MAX_UPLOAD_BYTES = 500 * 1024 * 1024;
const PUBLISHABLE = ['connected', 'expiring'];
const DEFAULT_FORMAT: Record<Platform, PostFormat> = { linkedin: 'text', facebook: 'text', instagram: 'image', tiktok: 'video', youtube: 'video' };

type YesNo = '' | 'yes' | 'no';

interface DestDraft {
  connection_id: string;
  platform: Platform;
  enabled: boolean;
  format: PostFormat;
  caption: string;
  title: string;
  link_url: string;
  asset_ids: string[];
  privacy_status: '' | 'public' | 'unlisted' | 'private';
  made_for_kids: YesNo;
  contains_synthetic_media: YesNo;
  is_aigc: boolean;
}

interface StoredDraft {
  post_id: string | null;
  campaign_id: string | null;
  campaign_key: string;
  product_id: string;
  goal: string;
  audience: string;
  language: string;
  date: string;
  time: string;
}

interface UploadState {
  key: string;
  filename: string;
  progress: number;
  status: 'uploading' | 'validating' | 'done' | 'error';
  error?: string;
  connectionId: string;
}

type PreparedPost = Omit<PostRevision, 'destinations'> & { destinations: Array<DestinationInput & { content_hash: string; problems: string[] }> };

function newDest(connectionId: string, platform: Platform): DestDraft {
  return {
    connection_id: connectionId,
    platform,
    enabled: true,
    format: DEFAULT_FORMAT[platform],
    caption: '',
    title: '',
    link_url: '',
    asset_ids: [],
    privacy_status: '',
    made_for_kids: '',
    contains_synthetic_media: '',
    is_aigc: false,
  };
}

function yesNo(v: unknown): YesNo {
  return v === true ? 'yes' : v === false ? 'no' : '';
}

function destFromRevision(d: DestinationInput): DestDraft {
  const o = d.options ?? {};
  const privacy = o.privacy_status;
  return {
    ...newDest(d.connection_id, d.platform),
    format: d.format,
    caption: d.caption,
    title: d.title ?? '',
    link_url: d.link_url ?? '',
    asset_ids: d.asset_ids,
    privacy_status: privacy === 'public' || privacy === 'unlisted' || privacy === 'private' ? privacy : '',
    made_for_kids: yesNo(o.made_for_kids),
    contains_synthetic_media: yesNo(o.contains_synthetic_media),
    is_aigc: o.is_aigc === true,
  };
}

function toDestinationInput(d: DestDraft): DestinationInput {
  const options: Record<string, unknown> = {};
  if (d.platform === 'youtube') {
    if (d.privacy_status) options.privacy_status = d.privacy_status;
    if (d.made_for_kids) options.made_for_kids = d.made_for_kids === 'yes';
    if (d.contains_synthetic_media) options.contains_synthetic_media = d.contains_synthetic_media === 'yes';
  }
  if (d.platform === 'tiktok' && d.is_aigc) options.is_aigc = true;
  return {
    platform: d.platform,
    connection_id: d.connection_id,
    format: d.format,
    caption: d.caption,
    asset_ids: d.format === 'text' || d.format === 'link' ? [] : d.asset_ids,
    ...(d.title.trim() && (d.platform === 'youtube' || d.platform === 'tiktok') ? { title: d.title.trim() } : {}),
    ...(d.format === 'link' && d.link_url.trim() ? { link_url: d.link_url.trim() } : {}),
    options,
  };
}

function validate(product: string, goal: string, audience: string, language: string, dests: DestDraft[]): string[] {
  const errs: string[] = [];
  if (!product) errs.push('Choose a product.');
  if (!goal.trim()) errs.push('Describe the campaign goal.');
  if (!audience.trim()) errs.push('Describe the audience.');
  if (!/^[A-Za-z]{2,3}([-_][A-Za-z0-9]{2,8})*$/.test(language)) errs.push('Use a language tag like en or en-AU.');
  if (!dests.length) errs.push('Select at least one destination account.');
  for (const d of dests) {
    const name = PLATFORM_LABELS[d.platform];
    if (d.platform === 'youtube') {
      if (!d.title.trim()) errs.push('YouTube needs a title.');
      if (!d.privacy_status) errs.push('Choose a YouTube privacy setting.');
      if (!d.made_for_kids) errs.push('Answer whether the YouTube video is made for kids.');
      if (!d.contains_synthetic_media) errs.push('Answer whether the YouTube video contains altered or synthetic media.');
    }
    if (d.format === 'link' && !/^https:\/\//.test(d.link_url.trim())) errs.push(`${name}: a link post needs an https link.`);
    if (d.caption.length > CAPTION_LIMITS[d.platform]) errs.push(`${name}: caption exceeds ${formatNumber(CAPTION_LIMITS[d.platform])} characters.`);
  }
  return [...new Set(errs)];
}

export function ComposerBody({ workspace, onScheduled, onClose }: { workspace: WorkspaceSummary; onScheduled: () => void; onClose: () => void }) {
  const tz = workspace.timezone;
  const storageKey = STORAGE_KEYS.draft(workspace.id);
  const [initial] = useState<StoredDraft | null>(() => readJson<StoredDraft>(storageKey));
  const providers = useApi<ProviderStatus[]>('/connections');
  const products = useApi<Page<Product>>('/products');

  const [productId, setProductId] = useState(initial?.product_id ?? '');
  const [goal, setGoal] = useState(initial?.goal ?? '');
  const [audience, setAudience] = useState(initial?.audience ?? '');
  const [language, setLanguage] = useState(initial?.language ?? 'en');
  const [when, setWhen] = useState<LocalTimeValue>({ date: initial?.date ?? '', time: initial?.time ?? '' });
  const [dests, setDests] = useState<Record<string, DestDraft>>({});
  const [activeTab, setActiveTab] = useState<string | null>(null);
  const [campaign, setCampaign] = useState<Campaign | null>(null);
  const [campaignKey, setCampaignKey] = useState<string>(() => initial?.campaign_key ?? newKey());
  const [saved, setSaved] = useState<{ post_id: string; revision: number; campaign_id: string } | null>(null);
  const [problems, setProblems] = useState<Record<string, string[]>>({});
  const [dirty, setDirty] = useState(false);
  const [restoring, setRestoring] = useState<boolean>(Boolean(initial?.post_id));
  const [restoreNote, setRestoreNote] = useState<string | null>(null);
  const [assets, setAssets] = useState<Record<string, Asset>>({});
  const [uploads, setUploads] = useState<UploadState[]>([]);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [preview, setPreview] = useState<SchedulePreview | null>(null);
  const [confirmKey, setConfirmKey] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<ScheduleConfirmation | null>(null);
  const [formErrors, setFormErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState<null | 'save' | 'preview' | 'confirm'>(null);
  const [error, setError] = useState<ApiRequestError | null>(null);
  const [status, setStatus] = useState<string>('');
  const saveAttempt = useRef<{ payload: string; key: string } | null>(null);
  const library = useApi<Page<Asset>>(libraryOpen ? '/assets?limit=50' : null);

  // Restore a saved draft from the server (ids are kept in localStorage).
  useEffect(() => {
    const postId = initial?.post_id;
    if (!postId) return;
    let cancelled = false;
    (async () => {
      try {
        const post = await api<PostRevision>(`/posts/${encodeURIComponent(postId)}`);
        const campaigns = await api<Campaign[]>(`/campaigns${initial?.product_id ? `?product_id=${encodeURIComponent(initial.product_id)}` : ''}`);
        const camp = campaigns.find((c) => c.id === post.campaign_id) ?? null;
        const restored: Record<string, DestDraft> = {};
        for (const d of post.destinations) restored[d.connection_id] = destFromRevision(d);
        const ids = [...new Set(post.destinations.flatMap((d) => d.asset_ids))];
        const fetched = await Promise.all(ids.map((id) => api<Asset>(`/assets/${encodeURIComponent(id)}`).catch(() => null)));
        if (cancelled) return;
        setDests(restored);
        setActiveTab(post.destinations[0]?.connection_id ?? null);
        setSaved({ post_id: post.post_id, revision: post.revision, campaign_id: post.campaign_id });
        if (camp) {
          setCampaign(camp);
          setProductId(camp.product_id);
          setGoal(camp.goal);
          setAudience(camp.audience);
          setLanguage(camp.language);
        }
        setAssets((prev) => {
          const next = { ...prev };
          for (const a of fetched) if (a) next[a.id] = a;
          return next;
        });
        setRestoreNote(`Restored your saved draft (revision ${post.revision}).`);
      } catch (e) {
        if (cancelled) return;
        const err = toApiError(e);
        setRestoreNote(err.status === 404 ? 'The previously saved draft no longer exists. Starting a new one.' : `The saved draft could not be loaded: ${err.message}`);
        if (err.status === 404) writeJson(storageKey, null);
      } finally {
        if (!cancelled) setRestoring(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [initial, storageKey]);

  // Persist draft ids and lightweight fields so the draft survives refresh.
  useEffect(() => {
    if (restoring || confirmation) return;
    const value: StoredDraft = {
      post_id: saved?.post_id ?? null,
      campaign_id: campaign?.id ?? null,
      campaign_key: campaignKey,
      product_id: productId,
      goal,
      audience,
      language,
      date: when.date,
      time: when.time,
    };
    writeJson(storageKey, value);
  }, [restoring, confirmation, saved, campaign, campaignKey, productId, goal, audience, language, when, storageKey]);

  const allConnections = useMemo(() => (providers.data ?? []).flatMap((p) => p.connections.map((c) => ({ ...c, configured: p.configured }))), [providers.data]);
  const enabledDests = Object.values(dests).filter((d) => d.enabled);
  const productList = products.data?.items ?? [];
  const product = productList.find((p) => p.id === productId);
  const currentTab = enabledDests.find((d) => d.connection_id === activeTab) ?? enabledDests[0] ?? null;
  const timeEval = evaluateLocalTime(when, tz);
  const previewExpired = preview?.expires_at ? new Date(preview.expires_at).getTime() < nowMs() : false;

  function touched() {
    setDirty(true);
    setPreview(null);
    setConfirmKey(null);
  }

  function updateDest(connectionId: string, patch: Partial<DestDraft>) {
    setDests((prev) => {
      const cur = prev[connectionId];
      return cur ? { ...prev, [connectionId]: { ...cur, ...patch } } : prev;
    });
    touched();
  }

  function toggleDest(connectionId: string, platform: Platform, on: boolean) {
    setDests((prev) => {
      const cur = prev[connectionId];
      if (cur) return { ...prev, [connectionId]: { ...cur, enabled: on } };
      const seed = Object.values(prev).find((d) => d.enabled);
      return { ...prev, [connectionId]: { ...newDest(connectionId, platform), caption: seed?.caption ?? '' } };
    });
    if (on) setActiveTab(connectionId);
    touched();
  }

  function copyToAll(from: DestDraft) {
    setDests((prev) => {
      const next = { ...prev };
      for (const [id, d] of Object.entries(prev)) {
        if (!d.enabled || id === from.connection_id) continue;
        next[id] = { ...d, caption: from.caption, asset_ids: [...from.asset_ids] };
      }
      return next;
    });
    touched();
    setStatus('Caption and media copied to every selected destination.');
  }

  async function uploadFile(file: File, connectionId: string) {
    const key = newKey();
    const base: UploadState = { key, filename: file.name, progress: 0, status: 'uploading', connectionId };
    const set = (patch: Partial<UploadState>) => setUploads((prev) => prev.map((u) => (u.key === key ? { ...u, ...patch } : u)));
    if (!ALLOWED_MIME.test(file.type)) {
      setUploads((prev) => [...prev, { ...base, status: 'error', error: 'Upload PNG, JPEG, GIF, WebP, MP4 or MOV files.' }]);
      return;
    }
    if (file.size < 1 || file.size > MAX_UPLOAD_BYTES) {
      setUploads((prev) => [...prev, { ...base, status: 'error', error: `Files must be between 1 byte and ${formatBytes(MAX_UPLOAD_BYTES)}.` }]);
      return;
    }
    setUploads((prev) => [...prev, base]);
    try {
      const intent = await api<{ asset_id: string; upload_url: string; method: 'PUT'; headers: Record<string, string>; expires_at: string }>('/assets/upload-intent', {
        method: 'POST',
        body: { filename: file.name, mime: file.type, bytes: file.size, product_id: productId || null },
      });
      await uploadWithProgress(intent, file, (f) => set({ progress: f }));
      set({ status: 'validating', progress: 1 });
      const asset = await api<Asset>(`/assets/${encodeURIComponent(intent.asset_id)}/complete`, { method: 'POST' });
      setAssets((prev) => ({ ...prev, [asset.id]: asset }));
      if (asset.validation_state === 'rejected') {
        set({ status: 'error', error: asset.validation_error ?? 'The file did not pass validation.' });
        return;
      }
      set({ status: 'done' });
      setDests((prev) => {
        const cur = prev[connectionId];
        return cur ? { ...prev, [connectionId]: { ...cur, asset_ids: [...cur.asset_ids, asset.id] } } : prev;
      });
      touched();
      setStatus(`${file.name} uploaded and attached.`);
    } catch (e) {
      const err = toApiError(e);
      set({ status: 'error', error: `${err.message}${err.requestId ? ` (Reference: ${err.requestId})` : ''}` });
    }
  }

  async function saveDraft(): Promise<{ post_id: string; revision: number; campaign_id: string } | null> {
    const errs = validate(productId, goal, audience, language, enabledDests);
    setFormErrors(errs);
    if (errs.length) return null;
    setError(null);
    let camp = campaign;
    let key = campaignKey;
    const matches = camp && camp.product_id === productId && camp.goal === goal.trim() && camp.audience === audience.trim() && camp.language === language;
    if (!matches) {
      if (camp) {
        key = newKey();
        setCampaignKey(key);
      }
      camp = await api<Campaign>('/campaigns', { method: 'POST', body: { product_id: productId, goal: goal.trim(), audience: audience.trim(), language, idempotency_key: key } });
      setCampaign(camp);
    }
    const postId = saved && saved.campaign_id === camp!.id ? saved.post_id : undefined;
    const payload = { campaign_id: camp!.id, ...(postId ? { post_id: postId } : {}), targets: enabledDests.map(toDestinationInput) };
    const payloadJson = JSON.stringify(payload);
    if (!saveAttempt.current || saveAttempt.current.payload !== payloadJson) saveAttempt.current = { payload: payloadJson, key: newKey() };
    const res = await api<PreparedPost>('/posts', { method: 'POST', body: { ...payload, idempotency_key: saveAttempt.current.key } });
    saveAttempt.current = null;
    const next = { post_id: res.post_id, revision: res.revision, campaign_id: res.campaign_id };
    setSaved(next);
    setProblems(Object.fromEntries(res.destinations.map((d) => [d.connection_id, d.problems])));
    setDirty(false);
    return next;
  }

  async function onSave() {
    setBusy('save');
    try {
      const r = await saveDraft();
      if (r) setStatus(`Draft saved (revision ${r.revision}).`);
    } catch (e) {
      setError(toApiError(e));
    } finally {
      setBusy(null);
    }
  }

  async function onPreview() {
    setBusy('preview');
    setError(null);
    try {
      const s = !saved || dirty ? await saveDraft() : saved;
      if (!s) return;
      if (timeEval.kind !== 'ok' || timeEval.past) {
        setFormErrors(['Choose a valid future date and time.']);
        return;
      }
      const p = await api<SchedulePreview>('/schedules/preview', {
        method: 'POST',
        body: { entries: [{ post_id: s.post_id, revision: s.revision, scheduled_at_utc: timeEval.time.utc, timezone: tz }] },
      });
      setPreview(p);
      setConfirmKey(newKey());
      setStatus(p.preview_token ? 'Preview ready. Review it, then confirm.' : 'Preview found problems that block scheduling.');
    } catch (e) {
      const err = toApiError(e);
      if (err.code === 'version_conflict') setDirty(true);
      setError(err);
    } finally {
      setBusy(null);
    }
  }

  async function onConfirm() {
    if (!preview?.preview_token || !confirmKey) return;
    setBusy('confirm');
    setError(null);
    try {
      const c = await api<ScheduleConfirmation>('/schedules/confirm', { method: 'POST', body: { preview_token: preview.preview_token, confirmed: true, idempotency_key: confirmKey } });
      setConfirmation(c);
      writeJson(storageKey, null);
      setStatus('Schedule confirmed.');
      onScheduled();
    } catch (e) {
      const err = toApiError(e);
      if (err.code === 'conflict' || err.code === 'version_conflict') {
        setPreview(null);
        setConfirmKey(null);
      }
      setError(err);
    } finally {
      setBusy(null);
    }
  }

  function discard() {
    writeJson(storageKey, null);
    setDests({});
    setSaved(null);
    setCampaign(null);
    setCampaignKey(newKey());
    setPreview(null);
    setProblems({});
    setGoal('');
    setAudience('');
    setWhen({ date: '', time: '' });
    setDirty(false);
    setStatus('Draft discarded. Nothing was scheduled.');
  }

  if (confirmation) {
    const ids = confirmation.target_ids;
    return (
      <div className="stack">
        <Banner tone="success" title={`${ids.length} destination publication${ids.length === 1 ? '' : 's'} confirmed`}>
          Each destination now has its own status. Posts needing TikTok creator approval stay unpublished until approved.
        </Banner>
        <ul className="media-list">
          {ids.map((id) => {
            const st = confirmation.states[id];
            return (
              <li key={id} className="media-item">
                <span className="name">{st ? TARGET_STATE_INFO[st].description : 'Status pending'}</span>
                {st ? <StatusBadge state={st} /> : null}
                <Link to={`/targets/${encodeURIComponent(id)}`} onClick={onClose}>
                  Details
                </Link>
              </li>
            );
          })}
        </ul>
        <div className="form-actions">
          <button type="button" className="btn btn-primary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    );
  }

  const noProducts = products.data && productList.length === 0;
  const publishable = allConnections.filter((c) => PUBLISHABLE.includes(c.state));
  const unpublishable = allConnections.filter((c) => !PUBLISHABLE.includes(c.state));
  const canConfirm = Boolean(preview?.preview_token) && !dirty && !previewExpired && workspace.entitlements.can_confirm_schedules && busy === null;

  return (
    <div className="composer-grid">
      <section className="card stack" aria-labelledby="content-h">
        <h2 id="content-h">Content</h2>
        {restoring ? <Loading label="Restoring your saved draft…" /> : null}
        {restoreNote ? <Banner tone="info">{restoreNote}</Banner> : null}

        {products.error ? <ErrorNotice error={products.error} onRetry={products.reload} /> : null}
        {noProducts ? (
          <Banner tone="warning" title="Add a product first" action={<Link className="btn btn-sm" to="/settings?tab=products" onClick={onClose}>Open Settings › Products</Link>}>
            Posts are created for a product profile (name, audience, approved claims).
          </Banner>
        ) : null}
        <Field label="Product">
          <select className="select" value={productId} onChange={(e) => { setProductId(e.target.value); touched(); }}>
            <option value="">Choose a product…</option>
            {productList.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} {p.status !== 'approved' ? `(${p.status})` : ''}
              </option>
            ))}
          </select>
        </Field>
        {product && product.status !== 'approved' ? (
          <Banner tone="warning" title="This product profile is not approved">
            {product.status === 'paused' ? 'The product is paused.' : 'Approve the exact product version in '}
            {product.status === 'paused' ? ' Activate it in ' : null}
            <Link to="/settings?tab=products" onClick={onClose}>Settings › Products</Link> before scheduling.
          </Banner>
        ) : null}
        <div className="grid-2" style={{ gap: 12 }}>
          <Field label="Goal">
            <input className="input" value={goal} maxLength={2000} onChange={(e) => { setGoal(e.target.value); touched(); }} placeholder="e.g. Announce the new feature" />
          </Field>
          <Field label="Audience">
            <input className="input" value={audience} maxLength={2000} onChange={(e) => { setAudience(e.target.value); touched(); }} placeholder="e.g. Retail store managers" />
          </Field>
        </div>
        <Field label="Language" hint="Language tag, e.g. en or en-AU.">
          <input className="input" value={language} onChange={(e) => { setLanguage(e.target.value); touched(); }} style={{ maxWidth: 200 }} />
        </Field>

        <fieldset>
          <legend>Destinations</legend>
          {providers.loading && !providers.data ? <Loading label="Loading connected accounts…" /> : null}
          {providers.error ? <ErrorNotice error={providers.error} onRetry={providers.reload} /> : null}
          {providers.data && publishable.length === 0 ? (
            <Banner tone="warning" title="Connect a channel first" action={<Link className="btn btn-sm" to="/connectors" onClick={onClose}>Open Connectors</Link>}>
              No connected account can publish right now.
            </Banner>
          ) : null}
          <div className="grid-2" style={{ gap: 8 }}>
            {publishable.map((c) => (
              <label key={c.id} className="dest-toggle">
                <input type="checkbox" checked={dests[c.id]?.enabled ?? false} onChange={(e) => toggleDest(c.id, c.provider, e.target.checked)} />
                <span>
                  <span className="strong">{PLATFORM_LABELS[c.provider]}</span> · {c.account_name}
                  {c.state === 'expiring' ? <span className="cell-sub">Connection expiring soon</span> : null}
                </span>
              </label>
            ))}
          </div>
          {unpublishable.length ? (
            <p className="small muted" style={{ marginTop: 8 }}>
              Not available: {unpublishable.map((c) => `${PLATFORM_LABELS[c.provider]} · ${c.account_name} (${c.state.replace(/_/g, ' ')})`).join('; ')}. Fix these in Connectors.
            </p>
          ) : null}
        </fieldset>

        {enabledDests.length ? (
          <div className="stack">
            <div className="tabs" role="tablist" aria-label="Per-network content">
              {enabledDests.map((d) => {
                const conn = allConnections.find((c) => c.id === d.connection_id);
                const selected = currentTab?.connection_id === d.connection_id;
                return (
                  <button
                    key={d.connection_id}
                    type="button"
                    role="tab"
                    id={`tab-${d.connection_id}`}
                    aria-controls={`panel-${d.connection_id}`}
                    aria-selected={selected}
                    tabIndex={selected ? 0 : -1}
                    className="tab"
                    onClick={() => setActiveTab(d.connection_id)}
                    onKeyDown={(e) => {
                      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
                      const i = enabledDests.findIndex((x) => x.connection_id === d.connection_id);
                      const next = enabledDests[(i + (e.key === 'ArrowRight' ? 1 : -1) + enabledDests.length) % enabledDests.length];
                      if (next) {
                        setActiveTab(next.connection_id);
                        document.getElementById(`tab-${next.connection_id}`)?.focus();
                      }
                    }}
                  >
                    {PLATFORM_LABELS[d.platform]}
                    {conn ? <span className="visually-hidden"> · {conn.account_name}</span> : null}
                    {(problems[d.connection_id]?.length ?? 0) > 0 ? <span className="badge tone-warning" style={{ marginLeft: 6 }}>Fix</span> : null}
                  </button>
                );
              })}
            </div>
            {currentTab ? (
              <DestinationPanel
                key={currentTab.connection_id}
                dest={currentTab}
                accountName={allConnections.find((c) => c.id === currentTab.connection_id)?.account_name ?? ''}
                problems={problems[currentTab.connection_id] ?? []}
                assets={assets}
                uploads={uploads.filter((u) => u.connectionId === currentTab.connection_id)}
                multiple={enabledDests.length > 1}
                onChange={(patch) => updateDest(currentTab.connection_id, patch)}
                onUpload={(f) => uploadFile(f, currentTab.connection_id)}
                onCopyAll={() => copyToAll(currentTab)}
                libraryOpen={libraryOpen}
                onToggleLibrary={() => setLibraryOpen((v) => !v)}
                library={library.data?.items ?? []}
                libraryLoading={library.loading}
                libraryError={library.error}
                onPick={(a) => {
                  setAssets((prev) => ({ ...prev, [a.id]: a }));
                  if (!currentTab.asset_ids.includes(a.id)) updateDest(currentTab.connection_id, { asset_ids: [...currentTab.asset_ids, a.id] });
                }}
              />
            ) : null}
          </div>
        ) : null}

        <LocalTimePicker value={when} onChange={(v) => { setWhen(v); touched(); }} timezone={tz} />
      </section>

      <section className="card stack review-panel" aria-labelledby="review-h">
        <h2 id="review-h">Review</h2>
        <div role="status" aria-live="polite" className="small muted">
          {status}
        </div>
        {formErrors.length ? (
          <Banner tone="danger" title="Fix these before continuing" role="alert">
            <ul className="problem-list">
              {formErrors.map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          </Banner>
        ) : null}
        {error ? <ErrorNotice error={error} /> : null}
        {!workspace.entitlements.can_confirm_schedules ? (
          <Banner tone="warning" title="Scheduling is unavailable">
            {workspace.entitlements.restriction ?? 'This workspace cannot confirm schedules right now.'} You can still save drafts.
          </Banner>
        ) : null}

        {preview ? (
          <PreviewSummary preview={preview} tz={tz} />
        ) : (
          <>
            <p className="strong" style={{ fontSize: 18 }}>
              {enabledDests.length} destination publication{enabledDests.length === 1 ? '' : 's'}
            </p>
            <p className="small muted">
              {enabledDests.length ? enabledDests.map((d) => PLATFORM_LABELS[d.platform]).join(' + ') : 'No destinations selected.'} Each destination uses one publication from this cycle.
            </p>
            <QuotaMeter quota={workspace.quota} timezone={tz} />
            <p className="small muted">Preview checks content, time, quota and approvals on the server before anything is scheduled.</p>
          </>
        )}
        {saved ? (
          <p className="tiny muted">
            Saved draft revision {saved.revision}
            {dirty ? ' · unsaved changes' : ''}
          </p>
        ) : dirty ? (
          <p className="tiny muted">Not saved yet</p>
        ) : null}
        {previewExpired ? <Banner tone="warning">This preview expired. Preview again before confirming.</Banner> : null}
        <div className="stack-sm">
          {preview ? (
            <button type="button" className="btn btn-primary btn-block" onClick={onConfirm} disabled={!canConfirm} aria-describedby="confirm-hint">
              {busy === 'confirm' ? 'Confirming…' : 'Confirm schedule'}
            </button>
          ) : null}
          {preview && !preview.preview_token ? (
            <p id="confirm-hint" className="small field-error">
              Resolve the blocking problems, then preview again.
            </p>
          ) : null}
          <button type="button" className={`btn btn-block ${preview ? '' : 'btn-primary'}`} onClick={onPreview} disabled={busy !== null || restoring}>
            {busy === 'preview' ? 'Checking…' : preview ? 'Preview again' : 'Preview'}
          </button>
          <button type="button" className="btn btn-block" onClick={onSave} disabled={busy !== null || restoring}>
            {busy === 'save' ? 'Saving…' : 'Save draft'}
          </button>
          {saved || dirty ? (
            <button type="button" className="link-button" onClick={discard}>
              Discard draft
            </button>
          ) : null}
        </div>
      </section>
    </div>
  );
}

function PreviewSummary({ preview, tz }: { preview: SchedulePreview; tz: string }) {
  const platforms = [...new Set(preview.targets.map((t) => PLATFORM_LABELS[t.platform]))];
  const approvals = preview.targets.some((t) => t.approval_required);
  const q = preview.quota;
  return (
    <div className="stack">
      <p className="strong" style={{ fontSize: 18 }}>
        {preview.targets.length} destination publication{preview.targets.length === 1 ? '' : 's'}
      </p>
      <p>{platforms.join(' + ')}</p>
      <p className="small muted">
        Uses {formatNumber(preview.quota_cost)} · {formatNumber(q.used + q.reserved)} / {formatNumber(q.allowance)} used or reserved this cycle · {formatNumber(q.available)} available before this schedule
      </p>
      {approvals ? (
        <div className="stack-sm">
          <Badge tone="warning">Approval required</Badge>
          {preview.approval_requirements.length ? (
            <ul className="problem-list">
              {preview.approval_requirements.map((a) => (
                <li key={a}>{a}</li>
              ))}
            </ul>
          ) : null}
          <p className="small">Content and time are bound to this approval revision. TikTok posts wait for creator approval on the approval page.</p>
        </div>
      ) : null}
      {preview.blocking_problems.length ? (
        <Banner tone="danger" title="Cannot schedule yet" role="alert">
          <ul className="problem-list">
            {preview.blocking_problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </Banner>
      ) : null}
      <ul className="media-list">
        {preview.targets.map((t) => (
          <li key={`${t.connection_id}-${t.scheduled_at_utc}`} className="media-item" style={{ display: 'grid' }}>
            <span className="strong">
              {PLATFORM_LABELS[t.platform]} · {t.account_name} · {FORMAT_LABELS[t.format]}
            </span>
            <span className="small">
              {formatDateTime(t.scheduled_at_utc, t.timezone)} (UTC{t.utc_offset}) · {formatDateTime(t.scheduled_at_utc, 'UTC')} UTC
            </span>
            {t.scheduling_owner === 'provider_native' ? <span className="small muted">Uploaded early and scheduled by {PLATFORM_LABELS[t.platform]} itself.</span> : null}
            {t.approval_required ? <span className="small">Needs TikTok creator approval before publishing.</span> : null}
            {t.problems.length ? (
              <ul className="problem-list field-error">
                {t.problems.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            ) : (
              <span className="small muted">No problems found.</span>
            )}
          </li>
        ))}
      </ul>
      {preview.expires_at ? <p className="tiny muted">Preview valid until {formatDateTime(preview.expires_at, tz)}.</p> : null}
    </div>
  );
}

function DestinationPanel({
  dest,
  accountName,
  problems,
  assets,
  uploads,
  multiple,
  onChange,
  onUpload,
  onCopyAll,
  libraryOpen,
  onToggleLibrary,
  library,
  libraryLoading,
  libraryError,
  onPick,
}: {
  dest: DestDraft;
  accountName: string;
  problems: string[];
  assets: Record<string, Asset>;
  uploads: UploadState[];
  multiple: boolean;
  onChange: (patch: Partial<DestDraft>) => void;
  onUpload: (f: File) => void;
  onCopyAll: () => void;
  libraryOpen: boolean;
  onToggleLibrary: () => void;
  library: Asset[];
  libraryLoading: boolean;
  libraryError: ApiRequestError | undefined;
  onPick: (a: Asset) => void;
}) {
  const formats = PLATFORM_FORMATS[dest.platform];
  const limit = CAPTION_LIMITS[dest.platform];
  const media = dest.format !== 'text' && dest.format !== 'link';
  const name = PLATFORM_LABELS[dest.platform];
  return (
    <div role="tabpanel" id={`panel-${dest.connection_id}`} aria-labelledby={`tab-${dest.connection_id}`} className="stack">
      <p className="small muted">
        {name} · {accountName}
      </p>
      {problems.length ? (
        <Banner tone="warning" title={`What must change for ${name}`}>
          <ul className="problem-list">
            {problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </Banner>
      ) : null}
      <Field label="Format" hint={`${name} supports: ${formats.map((f) => FORMAT_LABELS[f]).join(', ')}.`}>
        <select className="select" value={dest.format} onChange={(e) => onChange({ format: e.target.value as PostFormat })}>
          {formats.map((f) => (
            <option key={f} value={f}>
              {FORMAT_LABELS[f]}
            </option>
          ))}
        </select>
      </Field>
      {dest.platform === 'youtube' || dest.platform === 'tiktok' ? (
        <Field label={dest.platform === 'youtube' ? 'Title (required)' : 'Title (optional)'} hint="Up to 100 characters.">
          <input className="input" value={dest.title} maxLength={100} onChange={(e) => onChange({ title: e.target.value })} />
        </Field>
      ) : null}
      <Field label={dest.platform === 'youtube' ? 'Description' : 'Caption'} hint={`${formatNumber(dest.caption.length)} / ${formatNumber(limit)} characters`}>
        <textarea className="textarea" value={dest.caption} onChange={(e) => onChange({ caption: e.target.value })} rows={6} />
      </Field>
      {dest.format === 'link' ? (
        <Field label="Link URL" hint="Must start with https://">
          <input className="input" type="url" inputMode="url" value={dest.link_url} onChange={(e) => onChange({ link_url: e.target.value })} placeholder="https://" />
        </Field>
      ) : null}
      {dest.platform === 'youtube' ? (
        <div className="stack">
          <Field label="Privacy" hint="Required. There is no default.">
            <select className="select" value={dest.privacy_status} onChange={(e) => onChange({ privacy_status: e.target.value as DestDraft['privacy_status'] })}>
              <option value="">Choose…</option>
              <option value="public">Public</option>
              <option value="unlisted">Unlisted</option>
              <option value="private">Private</option>
            </select>
          </Field>
          <YesNoField legend="Made for kids? (required)" value={dest.made_for_kids} onChange={(v) => onChange({ made_for_kids: v })} name={`kids-${dest.connection_id}`} />
          <YesNoField legend="Contains altered or synthetic media? (required)" value={dest.contains_synthetic_media} onChange={(v) => onChange({ contains_synthetic_media: v })} name={`syn-${dest.connection_id}`} />
        </div>
      ) : null}
      {dest.platform === 'tiktok' ? (
        <div className="stack-sm">
          <label className="check">
            <input type="checkbox" checked={dest.is_aigc} onChange={(e) => onChange({ is_aigc: e.target.checked })} />
            <span>Label as AI-generated content</span>
          </label>
          <p className="small muted">TikTok requires the creator to choose privacy, interactions and disclosures for each post on the approval page before it can publish.</p>
        </div>
      ) : null}
      {media ? (
        <div className="stack-sm">
          <p className="field-label">Media</p>
          {dest.asset_ids.length ? (
            <ul className="media-list">
              {dest.asset_ids.map((id) => {
                const a = assets[id];
                return (
                  <li key={id} className="media-item">
                    <span className="name">{a ? a.filename : id}</span>
                    {a ? <span className="small muted">{a.mime} · {formatBytes(a.bytes)}</span> : null}
                    {a ? <Badge tone={a.validation_state === 'valid' ? 'success' : a.validation_state === 'rejected' ? 'danger' : 'info'}>{a.validation_state === 'valid' ? 'Valid' : a.validation_state === 'rejected' ? 'Rejected' : 'Validating'}</Badge> : null}
                    <button type="button" className="btn btn-sm btn-ghost" onClick={() => onChange({ asset_ids: dest.asset_ids.filter((x) => x !== id) })} aria-label={`Remove ${a?.filename ?? id}`}>
                      Remove
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="small muted">No media attached.</p>
          )}
          {uploads.length ? (
            <ul className="media-list" aria-live="polite">
              {uploads.map((u) => (
                <li key={u.key} className="media-item" style={{ display: 'grid' }}>
                  <span className="name">{u.filename}</span>
                  {u.status === 'uploading' ? (
                    <>
                      <progress max={1} value={u.progress} aria-label={`Uploading ${u.filename}`} />
                      <span className="small muted">Uploading {Math.round(u.progress * 100)}%</span>
                    </>
                  ) : null}
                  {u.status === 'validating' ? <span className="small muted">Checking the file…</span> : null}
                  {u.status === 'done' ? <span className="small">Uploaded and attached.</span> : null}
                  {u.status === 'error' ? <span className="field-error">{u.error}</span> : null}
                </li>
              ))}
            </ul>
          ) : null}
          <div className="row">
            <label className="btn">
              Upload owned media
              <input
                type="file"
                className="visually-hidden"
                accept="image/png,image/jpeg,image/gif,image/webp,video/mp4,video/quicktime"
                multiple
                onChange={(e) => {
                  const files = Array.from(e.target.files ?? []);
                  e.target.value = '';
                  files.forEach(onUpload);
                }}
              />
            </label>
            <button type="button" className="btn btn-ghost" onClick={onToggleLibrary} aria-expanded={libraryOpen}>
              {libraryOpen ? 'Hide media library' : 'Choose from media library'}
            </button>
          </div>
          <p className="tiny muted">Upload only media you own or have rights to use. PNG, JPEG, GIF, WebP, MP4 or MOV up to 500 MB.</p>
          {libraryOpen ? (
            <div className="stack-sm">
              {libraryLoading && !library.length ? <Loading label="Loading media…" /> : null}
              {libraryError ? <ErrorNotice error={libraryError} /> : null}
              {!libraryLoading && !libraryError && !library.length ? <p className="small muted">No uploaded media yet.</p> : null}
              <ul className="media-list">
                {library.map((a) => (
                  <li key={a.id} className="media-item">
                    <span className="name">{a.filename}</span>
                    <span className="small muted">{a.mime} · {formatBytes(a.bytes)}</span>
                    <Badge tone={a.validation_state === 'valid' ? 'success' : a.validation_state === 'rejected' ? 'danger' : 'info'}>{a.validation_state}</Badge>
                    <button type="button" className="btn btn-sm" disabled={a.validation_state !== 'valid' || dest.asset_ids.includes(a.id)} onClick={() => onPick(a)}>
                      {dest.asset_ids.includes(a.id) ? 'Attached' : 'Attach'}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}
      {multiple ? (
        <button type="button" className="link-button" onClick={onCopyAll}>
          Copy this caption and media to all selected destinations
        </button>
      ) : null}
    </div>
  );
}

function YesNoField({ legend, value, onChange, name }: { legend: string; value: YesNo; onChange: (v: YesNo) => void; name: string }) {
  return (
    <fieldset>
      <legend>{legend}</legend>
      <div className="row">
        {(['yes', 'no'] as const).map((v) => (
          <label key={v} className="choice">
            <input type="radio" name={name} checked={value === v} onChange={() => onChange(v)} />
            <span>{v === 'yes' ? 'Yes' : 'No'}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
