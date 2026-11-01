import { useState, type FormEvent } from 'react';
import type { Invitation, Member, Role } from '@ayonix/contracts';
import { ConfirmDialog } from '../../components/overlay';
import { Banner, ErrorNotice, Field, Loading } from '../../components/ui';
import { api, toApiError, type ApiRequestError } from '../../lib/api';
import { formatDate } from '../../lib/format';
import { useAction, useApi } from '../../lib/hooks';
import { atLeast, ROLE_LABELS } from '../../lib/labels';
import { useSession, useWorkspace } from '../../state/session';

interface MembersResponse {
  members: Member[];
  invitations: Invitation[];
}

const ROLE_HELP: Record<Role, string> = {
  owner: 'Everything, including billing, deletion and export.',
  admin: 'Manage members, connections and workspace settings.',
  editor: 'Create drafts, schedule, approve and cancel posts.',
  viewer: 'Read-only access.',
};

export function MembersTab() {
  const ws = useWorkspace();
  const { me } = useSession();
  const data = useApi<MembersResponse>('/members');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('editor');
  const [notice, setNotice] = useState<string | null>(null);
  const [rowError, setRowError] = useState<ApiRequestError | null>(null);
  const [removing, setRemoving] = useState<Member | null>(null);
  const invite = useAction((body: { email: string; role: Role }) => api<Invitation>('/members', { method: 'POST', body }));
  const remove = useAction(async (id: string) => {
    await api<void>(`/members/${encodeURIComponent(id)}`, { method: 'DELETE' });
    return true;
  });
  const canManage = atLeast(ws.role, 'admin');
  const isOwner = ws.role === 'owner';
  const inviteRoles: Role[] = isOwner ? ['admin', 'editor', 'viewer'] : ['editor', 'viewer'];

  async function submit(e: FormEvent) {
    e.preventDefault();
    setNotice(null);
    const inv = await invite.run({ email: email.trim(), role });
    if (inv) {
      setEmail('');
      setNotice(`Invitation sent to ${inv.email}. It expires ${formatDate(inv.expires_at, ws.timezone)}.${ws.integrations.email ? '' : ' Email is not configured on this deployment, so the invitee may not receive it.'}`);
      data.reload();
    }
  }

  async function changeRole(m: Member, next: Role) {
    setRowError(null);
    try {
      data.setData(await api<MembersResponse>(`/members/${encodeURIComponent(m.identity_id)}`, { method: 'PATCH', body: { role: next } }));
    } catch (e) {
      setRowError(toApiError(e));
    }
  }

  async function revoke(inv: Invitation) {
    setRowError(null);
    try {
      await api<void>(`/invitations/${encodeURIComponent(inv.id)}`, { method: 'DELETE' });
      data.reload();
    } catch (e) {
      setRowError(toApiError(e));
    }
  }

  return (
    <div className="stack">
      {canManage ? (
        <section className="card" aria-labelledby="invite-h">
          <h2 id="invite-h">Invite a member</h2>
          <form className="stack" onSubmit={submit}>
            <div className="grid-2" style={{ gap: 12 }}>
              <Field label="Email" error={invite.error?.fieldErrors.email}>
                <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="off" />
              </Field>
              <Field label="Role" hint={ROLE_HELP[role]} error={invite.error?.fieldErrors.role}>
                <select className="select" value={role} onChange={(e) => setRole(e.target.value as Role)}>
                  {inviteRoles.map((r) => (
                    <option key={r} value={r}>
                      {ROLE_LABELS[r]}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            {invite.error && !Object.keys(invite.error.fieldErrors).length ? <ErrorNotice error={invite.error} /> : null}
            <div role="status" aria-live="polite">
              {notice ? <Banner tone="success">{notice}</Banner> : null}
            </div>
            <div className="form-actions">
              <button type="submit" className="btn btn-primary" disabled={invite.pending || !email.trim()}>
                {invite.pending ? 'Sending…' : 'Send invitation'}
              </button>
            </div>
          </form>
        </section>
      ) : (
        <Banner tone="info">Only owners and admins can invite or change members.</Banner>
      )}

      <section className="card" aria-labelledby="members-h">
        <h2 id="members-h">Members</h2>
        {rowError ? <ErrorNotice error={rowError} /> : null}
        {data.loading && !data.data ? <Loading label="Loading members…" /> : null}
        {data.error && !data.data ? <ErrorNotice error={data.error} onRetry={data.reload} /> : null}
        {data.data ? (
          <div className="table-wrap">
            <table className="table table-stack">
              <caption className="visually-hidden">Workspace members</caption>
              <thead>
                <tr>
                  <th scope="col">Member</th>
                  <th scope="col">Role</th>
                  <th scope="col">Joined</th>
                  <th scope="col">
                    <span className="visually-hidden">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.data.members.map((m) => {
                  const self = m.identity_id === me?.identity.id;
                  const editable = canManage && (isOwner || (m.role !== 'owner' && m.role !== 'admin'));
                  return (
                    <tr key={m.identity_id}>
                      <td data-label="Member">
                        <span className="strong">{m.name || m.email}</span>
                        {self ? <span className="badge tone-info" style={{ marginLeft: 6 }}>You</span> : null}
                        <span className="cell-sub">{m.email}</span>
                      </td>
                      <td data-label="Role">
                        {editable ? (
                          <label>
                            <span className="visually-hidden">Role for {m.email}</span>
                            <select className="select" style={{ minHeight: 40, padding: '6px 10px' }} value={m.role} onChange={(e) => changeRole(m, e.target.value as Role)}>
                              {(isOwner ? (['owner', 'admin', 'editor', 'viewer'] as Role[]) : (['editor', 'viewer'] as Role[])).map((r) => (
                                <option key={r} value={r}>
                                  {ROLE_LABELS[r]}
                                </option>
                              ))}
                            </select>
                          </label>
                        ) : (
                          ROLE_LABELS[m.role]
                        )}
                      </td>
                      <td data-label="Joined">{formatDate(m.joined_at, ws.timezone)}</td>
                      <td>
                        {editable ? (
                          <button type="button" className="btn btn-sm btn-ghost" onClick={() => setRemoving(m)}>
                            {self ? 'Leave' : 'Remove'}
                          </button>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>

      {data.data && data.data.invitations.some((i) => !i.accepted_at) ? (
        <section className="card" aria-labelledby="inv-h">
          <h2 id="inv-h">Pending invitations</h2>
          <ul className="media-list">
            {data.data.invitations
              .filter((i) => !i.accepted_at)
              .map((i) => (
                <li key={i.id} className="media-item">
                  <span className="name">{i.email}</span>
                  <span className="small muted">
                    {ROLE_LABELS[i.role]} · expires {formatDate(i.expires_at, ws.timezone)}
                  </span>
                  {canManage ? (
                    <button type="button" className="btn btn-sm btn-ghost" onClick={() => revoke(i)}>
                      Revoke
                    </button>
                  ) : null}
                </li>
              ))}
          </ul>
        </section>
      ) : null}

      <ConfirmDialog
        open={removing !== null}
        onClose={() => {
          setRemoving(null);
          remove.clear();
        }}
        title={removing ? `Remove ${removing.email}?` : 'Remove member'}
        confirmLabel="Remove"
        danger
        pending={remove.pending}
        onConfirm={async () => {
          if (!removing) return;
          const r = await remove.run(removing.identity_id);
          if (r) {
            setRemoving(null);
            data.reload();
          }
        }}
      >
        <p>They lose access to this workspace immediately. Their past actions stay in the event log.</p>
        {remove.error ? <ErrorNotice error={remove.error} /> : null}
      </ConfirmDialog>
    </div>
  );
}
