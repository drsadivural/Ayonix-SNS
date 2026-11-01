import type { ReactNode } from 'react';
import { BrowserRouter, Link, Navigate, Route, Routes, useLocation } from 'react-router';
import { AppShell, PlainLayout } from './components/AppShell';
import { ErrorNotice } from './components/ui';
import { BillingsPage } from './pages/Billings';
import { ConnectorsPage } from './pages/Connectors';
import { DashboardPage } from './pages/Dashboard';
import { InvitePage } from './pages/Invite';
import { OnboardingPage } from './pages/Onboarding';
import { ReportsPage } from './pages/Reports';
import { SettingsPage } from './pages/Settings';
import { TargetPage } from './pages/TargetPage';
import { TikTokApprovalPage } from './pages/TikTokApproval';
import { UploadHandoffPage } from './pages/UploadHandoff';
import { ForgotPasswordPage, FullPageLoading, LegalPage, LoginPage, RegisterPage, ResetPasswordPage, VerifyEmailPage } from './pages/auth';
import { SessionProvider, useSession } from './state/session';

/** Signed in with a verified email; otherwise redirect to the right auth step. */
function RequireSession({ children }: { children: ReactNode }) {
  const { status, me, error, refreshMe } = useSession();
  const location = useLocation();
  if (status === 'loading') return <FullPageLoading />;
  if (status === 'error' && error) {
    return (
      <PlainLayout>
        <ErrorNotice error={error} onRetry={() => void refreshMe()} />
      </PlainLayout>
    );
  }
  if (status === 'signed_out' || !me) {
    const next = `${location.pathname}${location.search}`;
    return <Navigate to={`/login?next=${encodeURIComponent(next)}`} replace />;
  }
  if (!me.identity.email_verified) return <Navigate to={`/verify-email?email=${encodeURIComponent(me.identity.email)}`} replace />;
  return <>{children}</>;
}

/** A workspace exists and its summary is loaded. */
function RequireWorkspace({ children }: { children: ReactNode }) {
  const { me, workspace, workspaceError, workspaceLoading, refreshWorkspace } = useSession();
  if (me && me.workspaces.length === 0) return <Navigate to="/onboarding" replace />;
  if (!workspace) {
    if (workspaceError && !workspaceLoading) {
      return (
        <PlainLayout>
          <ErrorNotice error={workspaceError} onRetry={refreshWorkspace} />
        </PlainLayout>
      );
    }
    return <FullPageLoading label="Loading workspace…" />;
  }
  return <>{children}</>;
}

function NotFound() {
  return (
    <div className="stack">
      <h1>Page not found</h1>
      <p className="muted">This page does not exist.</p>
      <p>
        <Link to="/dashboard">Go to the dashboard</Link>
      </p>
    </div>
  );
}

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/register" element={<RegisterPage />} />
      <Route path="/forgot-password" element={<ForgotPasswordPage />} />
      <Route path="/reset-password" element={<ResetPasswordPage />} />
      <Route path="/verify-email" element={<VerifyEmailPage />} />
      <Route path="/terms" element={<LegalPage kind="terms" />} />
      <Route path="/privacy" element={<LegalPage kind="privacy" />} />
      <Route
        path="/onboarding"
        element={
          <RequireSession>
            <OnboardingPage />
          </RequireSession>
        }
      />
      <Route
        path="/invite"
        element={
          <RequireSession>
            <InvitePage />
          </RequireSession>
        }
      />
      <Route
        element={
          <RequireSession>
            <RequireWorkspace>
              <AppShell />
            </RequireWorkspace>
          </RequireSession>
        }
      >
        <Route index element={<Navigate to="/dashboard" replace />} />
        <Route path="/dashboard" element={<DashboardPage />} />
        <Route path="/connectors" element={<ConnectorsPage />} />
        <Route path="/billings" element={<BillingsPage />} />
        <Route path="/reports" element={<ReportsPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/targets/:id" element={<TargetPage />} />
        <Route path="/approve/tiktok/:targetId" element={<TikTokApprovalPage />} />
        <Route path="/upload/:assetId" element={<UploadHandoffPage />} />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
}

export function App() {
  return (
    <BrowserRouter>
      <SessionProvider>
        <AppRoutes />
      </SessionProvider>
    </BrowserRouter>
  );
}

