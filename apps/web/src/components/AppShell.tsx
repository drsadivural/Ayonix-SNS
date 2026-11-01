import { useEffect, useRef, type ReactNode } from 'react';
import { Link, Outlet, useLocation, useNavigate } from 'react-router';
import { useOnline } from '../lib/hooks';
import { setTheme, useTheme, type ThemeChoice } from '../lib/theme';
import { ROLE_LABELS, atLeast } from '../lib/labels';
import { useSession } from '../state/session';
import { BottomNav, PrimaryNav } from './nav';
import { Banner } from './ui';

export function ThemeSelect({ compact }: { compact?: boolean }) {
  const theme = useTheme();
  return (
    <label className={compact ? 'small row' : 'field'}>
      <span className={compact ? 'muted' : 'field-label'}>Theme</span>
      <select className="select" style={compact ? { minHeight: 40, padding: '6px 10px', width: 'auto' } : undefined} value={theme} onChange={(e) => setTheme(e.target.value as ThemeChoice)}>
        <option value="system">System</option>
        <option value="light">Light</option>
        <option value="dark">Dark</option>
      </select>
    </label>
  );
}

function WorkspaceSwitcher() {
  const { me, workspaceId, selectWorkspace } = useSession();
  if (!me || me.workspaces.length < 2) return null;
  return (
    <label className="small stack-sm">
      <span className="muted">Workspace</span>
      <select className="select" style={{ minHeight: 40, padding: '6px 10px' }} value={workspaceId ?? ''} onChange={(e) => selectWorkspace(e.target.value)}>
        {me.workspaces.map((w) => (
          <option key={w.id} value={w.id}>
            {w.name} ({ROLE_LABELS[w.role]})
          </option>
        ))}
      </select>
    </label>
  );
}

function AccountDetails() {
  const { me, workspace, signOut } = useSession();
  const navigate = useNavigate();
  return (
    <>
      <p className="eyebrow">{workspace?.name ?? 'Workspace'}</p>
      <p className="person">{me?.identity.name || me?.identity.email}</p>
      <p className="muted">{workspace?.timezone}</p>
      {workspace ? <p className="muted tiny">Role: {ROLE_LABELS[workspace.role]}</p> : null}
      <WorkspaceSwitcher />
      <div className="sidebar-actions">
        <ThemeSelect compact />
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={async () => {
            await signOut();
            navigate('/login', { replace: true });
          }}
        >
          Sign out
        </button>
      </div>
    </>
  );
}

function WorkspaceBanners() {
  const { workspace } = useSession();
  const online = useOnline();
  const items: ReactNode[] = [];
  if (!online) {
    items.push(
      <Banner key="offline" tone="warning" title="You are offline">
        Changes cannot be saved until the connection returns. Information on screen may be out of date.
      </Banner>,
    );
  }
  const r = workspace?.entitlements.restriction;
  if (workspace && r) {
    const status = workspace.entitlements.status;
    const tone = status === 'past_due' || status === 'suspended' || status === 'unpaid' ? 'danger' : 'warning';
    items.push(
      <Banner
        key="restriction"
        tone={tone}
        title={status === 'none' ? 'No active plan' : 'Publishing is restricted'}
        action={
          atLeast(workspace.role, 'owner') ? (
            <Link className="btn btn-sm" to="/billings">
              Open Billings
            </Link>
          ) : null
        }
      >
        {r}
        {atLeast(workspace.role, 'owner') ? null : ' Ask a workspace owner to review billing.'}
      </Banner>,
    );
  }
  return items.length ? <div className="stack-sm">{items}</div> : null;
}

export function AppShell() {
  const location = useLocation();
  const mainRef = useRef<HTMLElement>(null);
  const first = useRef(true);

  // Move focus to the main region on navigation so screen-reader and keyboard
  // users start at the new page content.
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    mainRef.current?.focus();
  }, [location.pathname]);

  return (
    <div className="app">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <aside className="sidebar" aria-label="Sidebar">
        <Link className="brand" to="/dashboard">
          <span className="brand-tile" aria-hidden="true">
            A
          </span>
          <span>Ayonix-SNS</span>
        </Link>
        <PrimaryNav pathname={location.pathname} />
        <div className="sidebar-footer">
          <AccountDetails />
        </div>
      </aside>
      <header className="mobile-header">
        <Link className="brand" to="/dashboard" style={{ padding: 0 }}>
          <span className="brand-tile" aria-hidden="true" style={{ width: 32, height: 32, fontSize: 18 }}>
            A
          </span>
          <span>Ayonix-SNS</span>
        </Link>
        <details className="account-menu">
          <summary className="btn btn-ghost btn-sm">Account</summary>
          <div className="account-panel">
            <AccountDetails />
          </div>
        </details>
      </header>
      <main id="main" className="main" ref={mainRef} tabIndex={-1}>
        <div className="main-inner">
          <WorkspaceBanners />
          <Outlet />
        </div>
      </main>
      <BottomNav pathname={location.pathname} />
    </div>
  );
}

/** Centered layout for signed-out and onboarding pages. */
export function PlainLayout({ children, wide }: { children: ReactNode; wide?: boolean }) {
  return (
    <div className="auth-wrap">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="auth-head" style={wide ? { width: 'min(1100px, 100%)' } : undefined}>
        <div className="row-between">
          <Link className="brand" to="/" style={{ padding: 0 }}>
            <span className="brand-tile" aria-hidden="true">
              A
            </span>
            <span>Ayonix-SNS</span>
          </Link>
          <ThemeSelect compact />
        </div>
      </header>
      <main id="main" className="stack" style={{ width: wide ? 'min(1100px, 100%)' : 'min(560px, 100%)' }} tabIndex={-1}>
        {children}
      </main>
    </div>
  );
}
