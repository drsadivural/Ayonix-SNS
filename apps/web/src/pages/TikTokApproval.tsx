// Hosted TikTok per-post approval (design: tiktok-approval.png). Creator
// constraints are fetched live; privacy has no default; interactions are
// off until the person turns them on; commercial disclosure is explicit.
import { useEffect, useState, type FormEvent } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import type { TikTokApprovalContext } from '@ayonix/contracts';
import { Banner, ErrorNotice, Field, Loading, PageHeader } from '../components/ui';
import { api, qs } from '../lib/api';
import { formatDateTime } from '../lib/format';
import { useAction, useApi } from '../lib/hooks';
import { tiktokPrivacyLabel } from '../lib/labels';
import { useWorkspace } from '../state/session';

const MUSIC_URL = 'https://www.tiktok.com/legal/page/global/music-usage-confirmation/en';
const BRANDED_URL = 'https://www.tiktok.com/legal/page/global/bc-policy/en';

function AssetPreview({ assetId, format }: { assetId: string; format: string }) {
  const preview = useApi<{ url: string }>(`/assets/${encodeURIComponent(assetId)}/preview`);
  if (preview.error) return <p className="small muted">Preview unavailable: {preview.error.message}</p>;
  if (!preview.data) return <Loading label="Loading preview…" />;
  return format === 'photo' ? (
    <img className="preview-media" src={preview.data.url} alt="Photo that will be posted" />
  ) : (
    <video className="preview-media" src={preview.data.url} controls preload="metadata" aria-label="Video that will be posted" />
  );
}

function ApprovalForm({ ctx, targetId, onReload }: { ctx: TikTokApprovalContext; targetId: string; onReload: () => void }) {
  const c = ctx.creator;
  const isPhoto = ctx.content.format === 'photo';
  const [title, setTitle] = useState(ctx.content.title ?? '');
  const [privacy, setPrivacy] = useState('');
  const [allowComment, setAllowComment] = useState(false);
  const [allowDuet, setAllowDuet] = useState(false);
  const [allowStitch, setAllowStitch] = useState(false);
  const [disclose, setDisclose] = useState(false);
  const [yourBrand, setYourBrand] = useState(false);
  const [branded, setBranded] = useState(false);
  const [consent, setConsent] = useState(false);
  const [done, setDone] = useState<null | 'approved' | 'draft'>(null);
  const approve = useAction((body: Record<string, unknown>) => api<{ status: string }>(`/targets/${encodeURIComponent(targetId)}/tiktok-approval`, { method: 'POST', body }));
  const toDraft = useAction(() => api<{ status: string }>(`/targets/${encodeURIComponent(targetId)}/return-to-draft`, { method: 'POST' }));

  const brandContent = disclose && branded;
  const brandOrganic = disclose && yourBrand;
  const disclosureIncomplete = disclose && !yourBrand && !branded;
  const privacyConflict = brandContent && privacy === 'SELF_ONLY';
  const ready = privacy !== '' && consent && !disclosureIncomplete && !privacyConflict;
  const staleCreator = approve.error && (approve.error.code === 'conflict' || approve.error.code === 'version_conflict');

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!ready) return;
    const r = await approve.run({
      approval_token: ctx.approval_token,
      privacy_level: privacy,
      allow_comment: c.comment_disabled ? false : allowComment,
      allow_duet: isPhoto || c.duet_disabled ? false : allowDuet,
      allow_stitch: isPhoto || c.stitch_disabled ? false : allowStitch,
      brand_organic_toggle: brandOrganic,
      brand_content_toggle: brandContent,
      title,
      consent: true,
    });
    if (r) setDone('approved');
  }

  if (done) {
    return (
      <Banner
        tone="success"
        title={done === 'approved' ? 'Approved for TikTok' : 'Returned to draft'}
        action={
          <Link className="btn btn-sm" to="/dashboard">
            Back to dashboard
          </Link>
        }
      >
        {done === 'approved'
          ? 'Consent is saved for this exact content and these settings. The post will be sent to TikTok at its scheduled time.'
          : 'The post will not be published. Its reserved publication was released; preview and confirm it again to schedule.'}
      </Banner>
    );
  }

  return (
    <form className="stack" onSubmit={submit}>
      <div className="row">
        {c.avatar_url ? <img className="avatar" src={c.avatar_url} alt="" referrerPolicy="no-referrer" /> : null}
        <div>
          <h2>Creator: {c.nickname}</h2>
          {c.username ? <p className="small muted">@{c.username}</p> : null}
        </div>
      </div>
      <p className="tiny muted">Creator settings fetched from TikTok {formatDateTime(ctx.fetched_at, 'UTC')} UTC.</p>

      <div className="stack-sm">
        <h3>Content preview</h3>
        {ctx.content.asset_ids[0] ? <AssetPreview assetId={ctx.content.asset_ids[0]} format={ctx.content.format} /> : <p className="small muted">No media attached.</p>}
        {ctx.content.asset_ids.length > 1 ? <p className="small muted">{ctx.content.asset_ids.length} items in this post.</p> : null}
        <p className="small">
          <span className="strong">Caption:</span> {ctx.content.caption || <span className="muted">No caption</span>}
        </p>
        {!isPhoto && c.max_video_post_duration_sec ? <p className="small muted">This creator can post videos up to {c.max_video_post_duration_sec} seconds long.</p> : null}
      </div>

      <Field label="Title" hint="Shown with the post on TikTok.">
        <input className="input" value={title} maxLength={2200} onChange={(e) => setTitle(e.target.value)} />
      </Field>

      <Field label="Who can view this post" hint="Required. Options come from the creator’s current TikTok settings. There is no default." error={privacyConflict ? 'Branded content cannot be set to Only me.' : approve.error?.fieldErrors.privacy_level}>
        <select className="select" value={privacy} onChange={(e) => setPrivacy(e.target.value)} required>
          <option value="">Select privacy (no default)</option>
          {c.privacy_level_options.map((o) => (
            <option key={o} value={o} disabled={brandContent && o === 'SELF_ONLY'}>
              {tiktokPrivacyLabel(o)}
              {brandContent && o === 'SELF_ONLY' ? ' — not available for branded content' : ''}
            </option>
          ))}
        </select>
      </Field>

      <fieldset className="stack-sm">
        <legend>Interactions</legend>
        <label className="check">
          <input type="checkbox" checked={allowComment && !c.comment_disabled} disabled={c.comment_disabled} onChange={(e) => setAllowComment(e.target.checked)} />
          <span>
            Allow comments
            {c.comment_disabled ? <span className="cell-sub">Turned off in the creator’s TikTok settings</span> : null}
          </span>
        </label>
        {!isPhoto ? (
          <>
            <label className="check">
              <input type="checkbox" checked={allowDuet && !c.duet_disabled} disabled={c.duet_disabled} onChange={(e) => setAllowDuet(e.target.checked)} />
              <span>
                Allow Duet
                {c.duet_disabled ? <span className="cell-sub">Turned off in the creator’s TikTok settings</span> : null}
              </span>
            </label>
            <label className="check">
              <input type="checkbox" checked={allowStitch && !c.stitch_disabled} disabled={c.stitch_disabled} onChange={(e) => setAllowStitch(e.target.checked)} />
              <span>
                Allow Stitch
                {c.stitch_disabled ? <span className="cell-sub">Turned off in the creator’s TikTok settings</span> : null}
              </span>
            </label>
          </>
        ) : null}
      </fieldset>

      <fieldset className="stack-sm">
        <legend>Commercial content disclosure</legend>
        <label className="check">
          <input
            type="checkbox"
            checked={disclose}
            onChange={(e) => {
              setDisclose(e.target.checked);
              if (!e.target.checked) {
                setYourBrand(false);
                setBranded(false);
              }
            }}
          />
          <span>This content promotes a brand, product or service</span>
        </label>
        {disclose ? (
          <div className="stack-sm" style={{ paddingLeft: 30 }}>
            <label className="check">
              <input type="checkbox" checked={yourBrand} onChange={(e) => setYourBrand(e.target.checked)} />
              <span>
                Your brand
                <span className="cell-sub">You are promoting yourself or your own business. The post will be labelled “Promotional content”.</span>
              </span>
            </label>
            <label className="check">
              <input type="checkbox" checked={branded} disabled={privacy === 'SELF_ONLY'} onChange={(e) => setBranded(e.target.checked)} />
              <span>
                Branded content
                <span className="cell-sub">
                  {privacy === 'SELF_ONLY' ? 'Not available while privacy is “Only me”.' : 'You are promoting another brand or a third party. The post will be labelled “Paid partnership”.'}
                </span>
              </span>
            </label>
            {disclosureIncomplete ? <p className="field-error">Choose “Your brand”, “Branded content”, or both.</p> : null}
          </div>
        ) : null}
      </fieldset>

      <div className="stack-sm">
        <p className="small">
          {brandContent ? (
            <>
              By posting, you agree to TikTok’s{' '}
              <a href={BRANDED_URL} target="_blank" rel="noopener noreferrer">
                Branded Content Policy
              </a>{' '}
              and{' '}
              <a href={MUSIC_URL} target="_blank" rel="noopener noreferrer">
                Music Usage Confirmation
              </a>
              .
            </>
          ) : (
            <>
              By posting, you agree to TikTok’s{' '}
              <a href={MUSIC_URL} target="_blank" rel="noopener noreferrer">
                Music Usage Confirmation
              </a>
              .
            </>
          )}
        </p>
        <label className="check">
          <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
          <span>I consent to publishing this exact content to this TikTok account with the settings above.</span>
        </label>
        <p className="small muted">Consent is saved for this exact content and these settings. After posting, TikTok may take a few minutes to process the content.</p>
      </div>

      {staleCreator ? (
        <Banner
          tone="warning"
          title="Reload required"
          action={
            <button type="button" className="btn btn-sm" onClick={onReload}>
              Reload creator settings
            </button>
          }
        >
          {approve.error?.message}
        </Banner>
      ) : approve.error ? (
        <ErrorNotice error={approve.error} />
      ) : null}
      {toDraft.error ? <ErrorNotice error={toDraft.error} /> : null}

      <div className="form-actions">
        <button type="submit" className="btn btn-primary" disabled={!ready || approve.pending}>
          {approve.pending ? 'Approving…' : 'Approve this content'}
        </button>
        <button
          type="button"
          className="btn"
          disabled={toDraft.pending}
          onClick={async () => {
            const r = await toDraft.run();
            if (r) setDone('draft');
          }}
        >
          {toDraft.pending ? 'Returning…' : 'Return to draft'}
        </button>
      </div>
      {!ready ? (
        <p className="small muted" aria-live="polite">
          To approve: choose who can view the post{disclose ? ', complete the disclosure' : ''} and tick the consent box.
        </p>
      ) : null}
    </form>
  );
}

export function TikTokApprovalPage() {
  const { targetId = '' } = useParams();
  const [params] = useSearchParams();
  const workspace = useWorkspace();
  const handoff = params.get('handoff');
  const ctx = useApi<TikTokApprovalContext>(`/targets/${encodeURIComponent(targetId)}/tiktok-approval${qs({ handoff })}`);
  const [formKey, setFormKey] = useState(0);
  useEffect(() => {
    document.title = 'TikTok approval · Ayonix-SNS';
    return () => {
      document.title = 'Ayonix-SNS';
    };
  }, []);
  return (
    <>
      <PageHeader title="TikTok approval" subtitle="Complete the required creator settings before this post can publish." />
      <section className="card" style={{ maxWidth: 900 }}>
        {ctx.loading && !ctx.data ? <Loading label="Fetching the creator’s current TikTok settings…" /> : null}
        {ctx.error ? <ErrorNotice error={ctx.error} onRetry={ctx.reload} /> : null}
        {ctx.data && !ctx.loading ? (
          <ApprovalForm
            key={`${ctx.data.approval_token}-${formKey}`}
            ctx={ctx.data}
            targetId={targetId}
            onReload={() => {
              setFormKey((k) => k + 1);
              ctx.reload();
            }}
          />
        ) : null}
        {!['owner', 'admin', 'editor'].includes(workspace.role) ? <p className="small muted">Your viewer role cannot approve posts.</p> : null}
      </section>
    </>
  );
}
