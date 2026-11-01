import { useState } from 'react';
import { useNavigate } from 'react-router';
import { Banner, ErrorNotice, Field } from '../../components/ui';
import { api, toApiError, type ApiRequestError } from '../../lib/api';
import { formatDateTime } from '../../lib/format';
import { usePoll } from '../../lib/hooks';
import { jobStatus } from '../../lib/labels';
import { useSession, useWorkspace } from '../../state/session';

interface PrivacyJob {
  id: string;
  kind: string;
  status: string;
  error?: string | null;
  created_at?: string;
  completed_at?: string | null;
  download_url?: string | null;
}

function ReauthNotice() {
  const { signOut } = useSession();
  const navigate = useNavigate();
  return (
    <Banner
      tone="warning"
      title="Sign in again to continue"
      action={
        <button
          type="button"
          className="btn btn-sm"
          onClick={async () => {
            await signOut();
            navigate(`/login?next=${encodeURIComponent('/settings?tab=data')}`, { replace: true });
          }}
        >
          Sign in again
        </button>
      }
    >
      For your security, exporting or deleting a workspace requires a sign-in from the last 15 minutes.
    </Banner>
  );
}

const needsReauth = (e: ApiRequestError | null) => Boolean(e && e.status === 401);

export function DataTab() {
  const ws = useWorkspace();
  const owner = ws.role === 'owner';
  const [job, setJob] = useState<PrivacyJob | null>(null);
  const [exportError, setExportError] = useState<ApiRequestError | null>(null);
  const [exporting, setExporting] = useState(false);
  const [confirmName, setConfirmName] = useState('');
  const [deleteJob, setDeleteJob] = useState<PrivacyJob | null>(null);
  const [deleteError, setDeleteError] = useState<ApiRequestError | null>(null);
  const [deleting, setDeleting] = useState(false);
  const active = job !== null && (job.status === 'queued' || job.status === 'running');

  usePoll(
    async () => {
      if (!job) return true;
      const j = await api<PrivacyJob>(`/privacy/${encodeURIComponent(job.id)}`);
      setJob(j);
      return j.status !== 'queued' && j.status !== 'running';
    },
    3000,
    active,
  );

  if (!owner) {
    return <Banner tone="info" title="Owner only">Only a workspace owner can export or delete workspace data.</Banner>;
  }

  return (
    <div className="grid-2">
      <section className="card stack" aria-labelledby="export-h">
        <h2 id="export-h">Export workspace data</h2>
        <p className="small muted">Creates a downloadable archive of this workspace’s records. The download link is signed and expires after a short time.</p>
        {needsReauth(exportError) ? <ReauthNotice /> : exportError ? <ErrorNotice error={exportError} /> : null}
        <div role="status" aria-live="polite">
          {job ? (
            job.status === 'ready' && job.download_url ? (
              <Banner tone="success" title="Export ready" action={<a className="btn btn-sm btn-primary" href={job.download_url}>Download</a>}>
                The link is valid for about 15 minutes. Request a new export if it expires.
              </Banner>
            ) : job.status === 'failed' ? (
              <Banner tone="danger" title="Export failed">
                {job.error ?? 'Try again.'}
              </Banner>
            ) : (
              <p className="row small">
                <span className="spinner" aria-hidden="true" /> Export {jobStatus(job.status).label.toLowerCase()}…
              </p>
            )
          ) : null}
        </div>
        <div className="form-actions">
          <button
            type="button"
            className="btn"
            disabled={exporting || active}
            onClick={async () => {
              setExporting(true);
              setExportError(null);
              try {
                setJob(await api<PrivacyJob>('/privacy/export', { method: 'POST' }));
              } catch (e) {
                setExportError(toApiError(e));
              } finally {
                setExporting(false);
              }
            }}
          >
            {exporting ? 'Requesting…' : 'Export data'}
          </button>
        </div>
      </section>
      <section className="card stack" aria-labelledby="delete-h">
        <h2 id="delete-h">Delete workspace</h2>
        <p className="small">
          Deletes this workspace, its products, schedules, media and history. Scheduled posts stop. Posts already published stay on the networks. Cancel the subscription in Billings first to stop future charges.
        </p>
        {deleteJob ? (
          <Banner tone="warning" title="Deletion requested">
            Request {deleteJob.id} is {jobStatus(deleteJob.status).label.toLowerCase()}
            {deleteJob.created_at ? ` (since ${formatDateTime(deleteJob.created_at, ws.timezone)})` : ''}. The workspace is now being removed.
          </Banner>
        ) : (
          <form
            className="stack"
            onSubmit={async (e) => {
              e.preventDefault();
              setDeleting(true);
              setDeleteError(null);
              try {
                setDeleteJob(await api<PrivacyJob>('/privacy/delete', { method: 'POST', body: { confirm_workspace_name: confirmName } }));
              } catch (err) {
                setDeleteError(toApiError(err));
              } finally {
                setDeleting(false);
              }
            }}
          >
            <Field label={`Type the workspace name (${ws.name}) to confirm`} error={deleteError?.fieldErrors.confirm_workspace_name}>
              <input className="input" value={confirmName} onChange={(e) => setConfirmName(e.target.value)} autoComplete="off" />
            </Field>
            {needsReauth(deleteError) ? <ReauthNotice /> : deleteError && !deleteError.fieldErrors.confirm_workspace_name ? <ErrorNotice error={deleteError} /> : null}
            <div className="form-actions">
              <button type="submit" className="btn btn-danger" disabled={deleting || confirmName !== ws.name}>
                {deleting ? 'Requesting…' : 'Delete workspace'}
              </button>
            </div>
          </form>
        )}
      </section>
    </div>
  );
}
