import { Link, useNavigate, useSearchParams } from 'react-router';
import { PlainLayout } from '../components/AppShell';
import { Banner, ErrorNotice } from '../components/ui';
import { api } from '../lib/api';
import { useAction } from '../lib/hooks';
import { useSession } from '../state/session';

export function InvitePage() {
  const [params] = useSearchParams();
  const token = params.get('token');
  const navigate = useNavigate();
  const { me, refreshMe } = useSession();
  const accept = useAction((t: string) => api<{ workspace_id: string }>('/invitations/accept', { method: 'POST', body: { token: t }, workspaceId: null }));
  return (
    <PlainLayout>
      <div>
        <h1>Join a workspace</h1>
        <p className="subtitle muted">Signed in as {me?.identity.email}.</p>
      </div>
      <section className="card stack" aria-labelledby="inv-h">
        <h2 id="inv-h">Accept invitation</h2>
        {!token ? (
          <Banner tone="danger" title="This invitation link is incomplete">
            Ask the person who invited you to send a new invitation.
          </Banner>
        ) : (
          <>
            <p>You were invited to collaborate in an Ayonix-SNS workspace. Accepting adds the workspace to your account with the role chosen by the inviter.</p>
            {accept.error ? <ErrorNotice error={accept.error} /> : null}
            <div className="form-actions">
              <button
                type="button"
                className="btn btn-primary"
                disabled={accept.pending}
                onClick={async () => {
                  const r = await accept.run(token);
                  if (r) {
                    await refreshMe(r.workspace_id);
                    navigate('/dashboard', { replace: true });
                  }
                }}
              >
                {accept.pending ? 'Joining…' : 'Accept invitation'}
              </button>
              <Link className="btn btn-ghost" to="/dashboard">
                Not now
              </Link>
            </div>
          </>
        )}
      </section>
    </PlainLayout>
  );
}
