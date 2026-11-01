import { useState, type FormEvent } from 'react';
import type { WorkspaceSummary } from '@ayonix/contracts';
import { ThemeSelect } from '../../components/AppShell';
import { Banner, ErrorNotice, Field } from '../../components/ui';
import { api } from '../../lib/api';
import { formatBytes, timezones } from '../../lib/format';
import { useAction } from '../../lib/hooks';
import { atLeast, PLAN_LABELS, SUBSCRIPTION_STATUS_INFO } from '../../lib/labels';
import { useSession, useWorkspace } from '../../state/session';

const LOCALES = ['en-US', 'en-AU', 'en-GB', 'en-CA', 'en-NZ', 'ja-JP', 'de-DE', 'fr-FR', 'es-ES', 'pt-BR', 'zh-CN', 'ko-KR', 'tr-TR'];

export function WorkspaceTab() {
  const workspace = useWorkspace();
  const { setWorkspace } = useSession();
  const [name, setName] = useState(workspace.name);
  const [timezone, setTimezone] = useState(workspace.timezone);
  const [locale, setLocale] = useState(workspace.locale);
  const [saved, setSaved] = useState(false);
  const save = useAction((body: { name: string; timezone: string; locale: string }) => api<WorkspaceSummary>('/workspace', { method: 'PATCH', body }));
  const canEdit = atLeast(workspace.role, 'admin');
  const zones = timezones();
  const locales = LOCALES.includes(locale) ? LOCALES : [locale, ...LOCALES];
  const ent = workspace.entitlements;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaved(false);
    const w = await save.run({ name: name.trim(), timezone, locale });
    if (w) {
      setWorkspace(w);
      setSaved(true);
    }
  }

  return (
    <div className="grid-main-side">
      <section className="card" aria-labelledby="ws-h">
        <h2 id="ws-h">Workspace</h2>
        <form className="stack" onSubmit={submit}>
          <fieldset disabled={!canEdit} className="stack">
            <Field label="Workspace name" error={save.error?.fieldErrors.name}>
              <input className="input" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />
            </Field>
            <Field label="Timezone" hint="Changing the timezone does not move existing schedules; each keeps its exact UTC time." error={save.error?.fieldErrors.timezone}>
              <select className="select" value={timezone} onChange={(e) => setTimezone(e.target.value)}>
                {(zones.includes(timezone) ? zones : [timezone, ...zones]).map((z) => (
                  <option key={z} value={z}>
                    {z}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Locale" error={save.error?.fieldErrors.locale}>
              <select className="select" value={locale} onChange={(e) => setLocale(e.target.value)}>
                {locales.map((l) => (
                  <option key={l} value={l}>
                    {l}
                  </option>
                ))}
              </select>
            </Field>
          </fieldset>
          {save.error && !Object.keys(save.error.fieldErrors).length ? <ErrorNotice error={save.error} /> : null}
          <div role="status" aria-live="polite">
            {saved ? <Banner tone="success">Workspace settings saved.</Banner> : null}
          </div>
          {canEdit ? (
            <div className="form-actions">
              <button type="submit" className="btn btn-primary" disabled={save.pending || !name.trim()}>
                {save.pending ? 'Saving…' : 'Save changes'}
              </button>
            </div>
          ) : (
            <p className="small muted">Only owners and admins can change workspace settings.</p>
          )}
        </form>
      </section>
      <div className="stack">
        <section className="card stack-sm" aria-labelledby="app-h">
          <h2 id="app-h">Appearance</h2>
          <ThemeSelect />
          <p className="small muted">Stored in this browser. “System” follows your device setting.</p>
        </section>
        <section className="card stack-sm" aria-labelledby="plan-h">
          <h2 id="plan-h">Plan limits</h2>
          <dl className="dl">
            <dt>Plan</dt>
            <dd>
              {ent.plan ? PLAN_LABELS[ent.plan] : 'No plan'} · {SUBSCRIPTION_STATUS_INFO[ent.status].label}
            </dd>
            <dt>Publications / cycle</dt>
            <dd>{ent.posts_per_cycle}</dd>
            <dt>Active products</dt>
            <dd>{ent.products}</dd>
            <dt>Media storage</dt>
            <dd>{ent.storage_bytes ? formatBytes(ent.storage_bytes) : 'None'}</dd>
            <dt>Research</dt>
            <dd>
              {[ent.auto_learn && 'Auto learn', ent.competitor_check && 'Competitor check', ent.similar_research && 'Similar research'].filter(Boolean).join(', ') || 'Not included'}
            </dd>
          </dl>
        </section>
      </div>
    </div>
  );
}
