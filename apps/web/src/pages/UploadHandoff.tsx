// Media handoff page (link produced by the MCP ingest_media tool). A signed-in
// member chooses the file here; the asset id is then given back to ChatGPT.
import { useState } from 'react';
import { useParams, useSearchParams } from 'react-router';
import type { Asset } from '@ayonix/contracts';
import { Banner, ErrorNotice, PageHeader } from '../components/ui';
import { api, toApiError, uploadWithProgress, type ApiRequestError } from '../lib/api';
import { formatBytes } from '../lib/format';

const ALLOWED = /^(image\/(png|jpeg|gif|webp)|video\/(mp4|quicktime))$/;

export function UploadHandoffPage() {
  const { assetId = '' } = useParams();
  const [params] = useSearchParams();
  const token = params.get('token');
  const [file, setFile] = useState<File | null>(null);
  const [progress, setProgress] = useState(0);
  const [phase, setPhase] = useState<'idle' | 'uploading' | 'validating' | 'done'>('idle');
  const [error, setError] = useState<ApiRequestError | null>(null);
  const [asset, setAsset] = useState<Asset | null>(null);
  const [copied, setCopied] = useState(false);

  async function start() {
    if (!file || !token) return;
    setError(null);
    if (!ALLOWED.test(file.type)) {
      setError(toApiError(new Error('Upload PNG, JPEG, GIF, WebP, MP4 or MOV files.')));
      return;
    }
    setPhase('uploading');
    try {
      const intent = await api<{ asset_id: string; upload_url: string; method: 'PUT'; headers: Record<string, string> }>(`/assets/${encodeURIComponent(assetId)}/page-intent`, {
        method: 'POST',
        body: { token, mime: file.type, bytes: file.size },
      });
      await uploadWithProgress(intent, file, setProgress);
      setPhase('validating');
      const a = await api<Asset>(`/assets/${encodeURIComponent(assetId)}/complete`, { method: 'POST' });
      setAsset(a);
      setPhase('done');
    } catch (e) {
      setError(toApiError(e));
      setPhase('idle');
    }
  }

  return (
    <>
      <PageHeader title="Upload media for ChatGPT" subtitle="Choose the file you want to use. Then tell ChatGPT the asset ID shown below." />
      <section className="card stack" style={{ maxWidth: 760 }}>
        {!token ? (
          <Banner tone="danger" title="This upload link is incomplete">
            Ask ChatGPT for a new upload link.
          </Banner>
        ) : null}
        {phase !== 'done' ? (
          <>
            <div className="field">
              <label htmlFor="handoff-file">File</label>
              <input id="handoff-file" className="input" type="file" accept="image/png,image/jpeg,image/gif,image/webp,video/mp4,video/quicktime" onChange={(e) => setFile(e.target.files?.[0] ?? null)} disabled={phase !== 'idle'} />
              <p className="hint">PNG, JPEG, GIF, WebP, MP4 or MOV up to 500 MB. Upload only media you own or have rights to use.</p>
            </div>
            {file ? (
              <p className="small">
                {file.name} · {formatBytes(file.size)}
              </p>
            ) : null}
            {phase === 'uploading' ? (
              <div className="stack-sm" aria-live="polite">
                <progress max={1} value={progress} aria-label="Upload progress" />
                <span className="small muted">Uploading {Math.round(progress * 100)}%</span>
              </div>
            ) : null}
            {phase === 'validating' ? <p role="status">Checking the file…</p> : null}
            {error ? <ErrorNotice error={error} /> : null}
            <div className="form-actions">
              <button type="button" className="btn btn-primary" onClick={start} disabled={!file || !token || phase !== 'idle'}>
                Upload
              </button>
            </div>
          </>
        ) : asset ? (
          asset.validation_state === 'valid' ? (
            <div className="stack">
              <Banner tone="success" title="Upload complete">
                Tell ChatGPT this asset ID so it can use the file in your post.
              </Banner>
              <p className="mono" style={{ fontSize: 18 }}>
                {asset.id}
              </p>
              <div className="row">
                <button
                  type="button"
                  className="btn"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(asset.id);
                      setCopied(true);
                    } catch {
                      setCopied(false);
                    }
                  }}
                >
                  Copy asset ID
                </button>
                <span role="status" className="small">
                  {copied ? 'Copied.' : ''}
                </span>
              </div>
            </div>
          ) : (
            <Banner tone="danger" title="The file was rejected">
              {asset.validation_error ?? 'It did not pass validation.'} Ask ChatGPT for a new upload link and try another file.
            </Banner>
          )
        ) : null}
      </section>
    </>
  );
}
