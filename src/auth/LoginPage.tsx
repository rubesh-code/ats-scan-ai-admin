import { useState, type FormEvent } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router';

import { adminApi, usingMocks } from '@/api';
import { ApiError } from '@/api/client';
import { useAuth } from '@/auth/AuthProvider';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Only same-app paths are honoured, so a crafted link can't redirect away. */
function safeReturnPath(value: unknown) {
  return typeof value === 'string' && value.startsWith('/') && !value.startsWith('//')
    ? value
    : '/';
}

export function LoginPage() {
  const { session, notice, signIn } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const returnTo = safeReturnPath((location.state as { from?: unknown } | null)?.from);

  const [step, setStep] = useState<'email' | 'code'>('email');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (session) return <Navigate to={returnTo} replace />;

  async function sendCode(event: FormEvent) {
    event.preventDefault();
    const trimmed = email.trim().toLowerCase();
    if (!EMAIL.test(trimmed)) {
      setError('Enter a valid email address.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await adminApi.sendOtp(trimmed);
      setEmail(trimmed);
      setStep('code');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not send the code.');
    } finally {
      setBusy(false);
    }
  }

  async function verify(event: FormEvent) {
    event.preventDefault();
    if (!/^\d{6}$/.test(code)) {
      setError('Enter the 6-digit code from the email.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      signIn(await adminApi.verifyOtp(email, code));
      void navigate(returnTo, { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not verify the code.');
      setBusy(false);
    }
  }

  return (
    <main className="login">
      <div className="login-card">
        <div className="brand brand-lg">
          <span className="brand-mark" aria-hidden="true">
            A
          </span>
          <span>
            ATS Scan AI <span className="brand-sub">Admin</span>
          </span>
        </div>

        {step === 'email' ? (
          <form onSubmit={sendCode} noValidate>
            <h1>Sign in</h1>
            <p className="muted">
              Admin accounts only. We'll email you a one-time code.
            </p>
            <label className="field">
              <span>Email</span>
              <input
                type="email"
                autoComplete="username"
                autoFocus
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={busy}
                required
              />
            </label>
            {(error ?? notice) && (
              <p className="form-error" role="alert">
                {error ?? notice}
              </p>
            )}
            <button className="btn btn-primary btn-block" disabled={busy}>
              {busy ? 'Sending…' : 'Send code'}
            </button>
          </form>
        ) : (
          <form onSubmit={verify} noValidate>
            <h1>Check your email</h1>
            <p className="muted">
              If <strong>{email}</strong> is an admin account, a 6-digit code is on its way.
            </p>
            <label className="field">
              <span>Code</span>
              <input
                inputMode="numeric"
                autoComplete="one-time-code"
                autoFocus
                maxLength={6}
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                disabled={busy}
                required
              />
            </label>
            {error && (
              <p className="form-error" role="alert">
                {error}
              </p>
            )}
            <button className="btn btn-primary btn-block" disabled={busy}>
              {busy ? 'Verifying…' : 'Sign in'}
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-block"
              onClick={() => {
                setStep('email');
                setCode('');
                setError(null);
              }}
              disabled={busy}
            >
              Use a different email
            </button>
          </form>
        )}

        {usingMocks && (
          <p className="mock-hint">Mock mode: any email, code 123456.</p>
        )}
      </div>
    </main>
  );
}
