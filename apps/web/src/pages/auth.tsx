import { useState, type FormEvent } from 'react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router';
import { PlainLayout } from '../components/AppShell';
import { Banner, Field, Loading } from '../components/ui';
import { authClient, authFailure, type AuthFailure } from '../lib/auth';
import { useSession } from '../state/session';

const MIN_PASSWORD = 10;

/** Only allow same-site relative redirects after sign-in. */
export function safeNext(next: string | null): string {
  if (!next || !next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) return '/dashboard';
  return next;
}

function FailureBanner({ failure, children }: { failure: AuthFailure | null; children?: React.ReactNode }) {
  if (!failure) return null;
  return (
    <Banner tone="danger" title="That did not work" role="alert">
      <p>{failure.message}</p>
      {children}
    </Banner>
  );
}

function GoogleButton({ callbackURL }: { callbackURL: string }) {
  const [failure, setFailure] = useState<AuthFailure | null>(null);
  const [pending, setPending] = useState(false);
  return (
    <div className="stack-sm">
      <button
        type="button"
        className="btn btn-block"
        disabled={pending}
        onClick={async () => {
          setPending(true);
          setFailure(null);
          try {
            const { error } = await authClient.signIn.social({ provider: 'google', callbackURL, errorCallbackURL: '/login?error=google' });
            if (error) {
              const f = authFailure(error);
              setFailure(
                f.status === 404 || f.status === 400 || /provider/i.test(f.message)
                  ? { ...f, message: 'Google sign-in is not available on this deployment. Use email and password instead.' }
                  : f,
              );
            }
          } catch {
            setFailure(authFailure({ status: 0 }));
          } finally {
            setPending(false);
          }
        }}
      >
        {pending ? 'Opening Google…' : 'Continue with Google'}
      </button>
      {failure ? (
        <p className="field-error" role="alert">
          {failure.message}
        </p>
      ) : null}
    </div>
  );
}

function Or() {
  return (
    <p className="muted small" style={{ textAlign: 'center' }}>
      or
    </p>
  );
}

function ResendVerification({ email }: { email: string }) {
  const [state, setState] = useState<'idle' | 'sending' | 'sent'>('idle');
  const [failure, setFailure] = useState<AuthFailure | null>(null);
  return (
    <div className="stack-sm">
      <button
        type="button"
        className="btn"
        disabled={state === 'sending' || !email}
        onClick={async () => {
          setState('sending');
          setFailure(null);
          try {
            const { error } = await authClient.sendVerificationEmail({ email, callbackURL: '/onboarding' });
            if (error) {
              setFailure(authFailure(error));
              setState('idle');
            } else setState('sent');
          } catch {
            setFailure(authFailure({ status: 0 }));
            setState('idle');
          }
        }}
      >
        {state === 'sending' ? 'Sending…' : 'Resend verification email'}
      </button>
      <div role="status" aria-live="polite" className="small">
        {state === 'sent' ? 'If the address belongs to an unverified account, a new link is on its way.' : null}
      </div>
      {failure ? (
        <p className="field-error" role="alert">
          {failure.message}
        </p>
      ) : null}
    </div>
  );
}

export function LoginPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { refreshMe, status } = useSession();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [failure, setFailure] = useState<AuthFailure | null>(null);
  const [pending, setPending] = useState(false);
  const next = safeNext(params.get('next'));
  const queryError = params.get('error');

  if (status === 'ready' && !pending) return <Navigate to={next} replace />;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setPending(true);
    setFailure(null);
    try {
      const { error } = await authClient.signIn.email({ email: email.trim(), password });
      if (error) {
        setFailure(authFailure(error));
        setPending(false);
        return;
      }
      await refreshMe();
      navigate(next, { replace: true });
    } catch {
      setFailure(authFailure({ status: 0 }));
      setPending(false);
    }
  }

  const unverified = failure?.code === 'EMAIL_NOT_VERIFIED' || failure?.status === 403;
  return (
    <PlainLayout>
      <div>
        <h1>Sign in</h1>
        <p className="subtitle muted">Use your Ayonix-SNS account.</p>
      </div>
      <section className="card auth-card stack" aria-labelledby="signin-h">
        <h2 id="signin-h" className="visually-hidden">
          Sign in form
        </h2>
        {queryError ? (
          <Banner tone="danger" title="Sign-in was not completed">
            {queryError === 'google' ? 'Google sign-in failed or is not available on this deployment.' : 'The link was invalid or expired. Try again.'}
          </Banner>
        ) : null}
        <GoogleButton callbackURL={next} />
        <Or />
        <form className="stack" onSubmit={submit} noValidate>
          <Field label="Email">
            <input className="input" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>
          <Field label="Password">
            <input className="input" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
          </Field>
          <FailureBanner failure={failure ? (unverified ? { ...failure, message: 'Verify your email address before signing in. Check your inbox for the link.' } : failure) : null}>
            {unverified ? <ResendVerification email={email.trim()} /> : null}
          </FailureBanner>
          <button type="submit" className="btn btn-primary btn-block" disabled={pending || !email || !password}>
            {pending ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
        <div className="row-between small">
          <Link to="/forgot-password">Forgot password?</Link>
          <Link to="/register">Create an account</Link>
        </div>
      </section>
    </PlainLayout>
  );
}

export function RegisterPage() {
  const navigate = useNavigate();
  const { status } = useSession();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [accepted, setAccepted] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState<AuthFailure | null>(null);
  const [pending, setPending] = useState(false);

  if (status === 'ready' && !pending) return <Navigate to="/dashboard" replace />;

  async function submit(e: FormEvent) {
    e.preventDefault();
    const errs: Record<string, string> = {};
    if (!name.trim()) errs.name = 'Enter your name';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) errs.email = 'Enter a valid email address';
    if (password.length < MIN_PASSWORD) errs.password = `Use at least ${MIN_PASSWORD} characters`;
    if (!accepted) errs.terms = 'Accept the Terms and Privacy Policy to continue';
    setErrors(errs);
    if (Object.keys(errs).length) return;
    setPending(true);
    setFailure(null);
    try {
      const { error } = await authClient.signUp.email({ email: email.trim(), password, name: name.trim(), callbackURL: '/onboarding' });
      if (error) {
        const f = authFailure(error);
        setFailure(f.code === 'USER_ALREADY_EXISTS' || f.status === 422 ? { ...f, message: 'An account with this email may already exist. Sign in or reset your password.' } : f);
        setPending(false);
        return;
      }
      navigate(`/verify-email?email=${encodeURIComponent(email.trim())}`, { replace: true });
    } catch {
      setFailure(authFailure({ status: 0 }));
      setPending(false);
    }
  }

  return (
    <PlainLayout>
      <div>
        <h1>Create your account</h1>
        <p className="subtitle muted">Independent Ayonix website registration. No payment is requested in ChatGPT.</p>
      </div>
      <section className="card auth-card stack" aria-labelledby="reg-h">
        <h2 id="reg-h">Start your Ayonix workspace</h2>
        <GoogleButton callbackURL="/onboarding" />
        <Or />
        <form className="stack" onSubmit={submit} noValidate>
          <Field label="Your name" error={errors.name}>
            <input className="input" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Work email" error={errors.email}>
            <input className="input" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>
          <Field label="Password" hint={`At least ${MIN_PASSWORD} characters.`} error={errors.password}>
            <input className="input" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </Field>
          <div>
            <label className="check">
              <input type="checkbox" checked={accepted} onChange={(e) => setAccepted(e.target.checked)} aria-invalid={errors.terms ? true : undefined} aria-describedby={errors.terms ? 'terms-err' : undefined} />
              <span>
                I agree to the{' '}
                <Link to="/terms" target="_blank" rel="noopener">
                  Terms
                </Link>{' '}
                and{' '}
                <Link to="/privacy" target="_blank" rel="noopener">
                  Privacy Policy
                </Link>
                .
              </span>
            </label>
            {errors.terms ? (
              <p id="terms-err" className="field-error">
                {errors.terms}
              </p>
            ) : null}
          </div>
          <FailureBanner failure={failure}>
            {failure && failure.status >= 500 ? (
              <p className="small">If your account was created but the email did not arrive, use “Resend verification email” on the next screen or try signing in.</p>
            ) : null}
          </FailureBanner>
          <button type="submit" className="btn btn-primary btn-block" disabled={pending}>
            {pending ? 'Creating account…' : 'Create account'}
          </button>
        </form>
        <p className="small">
          Already registered? <Link to="/login">Sign in</Link>
        </p>
      </section>
    </PlainLayout>
  );
}

export function VerifyEmailPage() {
  const [params] = useSearchParams();
  const { me, status } = useSession();
  const [email, setEmail] = useState(params.get('email') ?? me?.identity.email ?? '');
  if (status === 'ready' && me?.identity.email_verified) return <Navigate to="/onboarding" replace />;
  return (
    <PlainLayout>
      <div>
        <h1>Check your email</h1>
        <p className="subtitle muted">Verify your email address to continue.</p>
      </div>
      <section className="card auth-card stack" aria-labelledby="ver-h">
        <h2 id="ver-h">We sent you a verification link</h2>
        <p>Open the link in the email to verify your address. The link is valid for 24 hours. You can close this tab.</p>
        <Field label="Email address">
          <input className="input" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <ResendVerification email={email.trim()} />
        <p className="small muted">No email after a few minutes? Check spam, then resend. If sending keeps failing, the deployment’s email service may be unavailable; try again later.</p>
        <p className="small">
          <Link to="/login">Back to sign in</Link>
        </p>
      </section>
    </PlainLayout>
  );
}

export function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [failure, setFailure] = useState<AuthFailure | null>(null);
  const [pending, setPending] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setPending(true);
    setFailure(null);
    try {
      const { error } = await authClient.requestPasswordReset({ email: email.trim(), redirectTo: `${window.location.origin}/reset-password` });
      if (error) setFailure(authFailure(error));
      else setSent(true);
    } catch {
      setFailure(authFailure({ status: 0 }));
    } finally {
      setPending(false);
    }
  }
  return (
    <PlainLayout>
      <div>
        <h1>Reset your password</h1>
        <p className="subtitle muted">We will email you a link to choose a new password.</p>
      </div>
      <section className="card auth-card stack" aria-labelledby="fp-h">
        <h2 id="fp-h" className="visually-hidden">
          Request a reset link
        </h2>
        {sent ? (
          <Banner tone="success" title="Check your email">
            If an account exists for {email.trim()}, a reset link is on its way. It is valid for one hour.
          </Banner>
        ) : (
          <form className="stack" onSubmit={submit} noValidate>
            <Field label="Email">
              <input className="input" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
            </Field>
            <FailureBanner failure={failure} />
            <button type="submit" className="btn btn-primary btn-block" disabled={pending || !email}>
              {pending ? 'Sending…' : 'Send reset link'}
            </button>
          </form>
        )}
        <p className="small">
          <Link to="/login">Back to sign in</Link>
        </p>
      </section>
    </PlainLayout>
  );
}

export function ResetPasswordPage() {
  const [params] = useSearchParams();
  const token = params.get('token');
  const linkError = params.get('error');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [failure, setFailure] = useState<AuthFailure | null>(null);
  const [done, setDone] = useState(false);
  const [pending, setPending] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (password.length < MIN_PASSWORD) return setError(`Use at least ${MIN_PASSWORD} characters`);
    if (password !== confirm) return setError('The passwords do not match');
    setError(undefined);
    if (!token) return;
    setPending(true);
    setFailure(null);
    try {
      const { error: err } = await authClient.resetPassword({ newPassword: password, token });
      if (err) setFailure(authFailure(err));
      else setDone(true);
    } catch {
      setFailure(authFailure({ status: 0 }));
    } finally {
      setPending(false);
    }
  }

  return (
    <PlainLayout>
      <div>
        <h1>Choose a new password</h1>
      </div>
      <section className="card auth-card stack" aria-labelledby="rp-h">
        <h2 id="rp-h" className="visually-hidden">
          New password
        </h2>
        {!token || linkError ? (
          <Banner tone="danger" title="This reset link is invalid or has expired">
            <Link to="/forgot-password">Request a new link</Link>
          </Banner>
        ) : done ? (
          <Banner tone="success" title="Password changed">
            Other sessions were signed out. <Link to="/login">Sign in</Link> with your new password.
          </Banner>
        ) : (
          <form className="stack" onSubmit={submit} noValidate>
            <Field label="New password" hint={`At least ${MIN_PASSWORD} characters.`} error={error}>
              <input className="input" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
            </Field>
            <Field label="Confirm new password">
              <input className="input" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
            </Field>
            <FailureBanner failure={failure}>
              <Link to="/forgot-password">Request a new link</Link>
            </FailureBanner>
            <button type="submit" className="btn btn-primary btn-block" disabled={pending}>
              {pending ? 'Saving…' : 'Change password'}
            </button>
          </form>
        )}
      </section>
    </PlainLayout>
  );
}

export function LegalPage({ kind }: { kind: 'terms' | 'privacy' }) {
  const title = kind === 'terms' ? 'Terms of Service' : 'Privacy Policy';
  return (
    <PlainLayout wide>
      <article className="card legal stack">
        <h1>{title}</h1>
        <Banner tone="warning" title="Legal text pending approval">
          The {title} for Ayonix-SNS must be written and approved by Ayonix before launch. This page is a placeholder and is not a binding agreement.
        </Banner>
        <p>Until the approved text is published here, contact Ayonix directly with any questions about how the service is provided or how personal data is handled.</p>
        <p>
          <Link to="/register">Back to registration</Link>
        </p>
      </article>
    </PlainLayout>
  );
}

export function FullPageLoading({ label }: { label?: string }) {
  return (
    <PlainLayout>
      <Loading label={label ?? 'Loading Ayonix-SNS…'} />
    </PlainLayout>
  );
}
