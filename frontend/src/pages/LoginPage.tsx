import { GoogleOAuthProvider, useGoogleLogin } from '@react-oauth/google';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { useAuth } from '../hooks/useAuth';
import { api, ApiError, type User } from '../lib/api';

function GoogleIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 48 48" aria-hidden>
      <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z" />
      <path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
      <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z" />
      <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z" />
    </svg>
  );
}

const googleBtn =
  'flex w-full items-center justify-center gap-2 rounded-lg bg-brand-50 py-2.5 text-sm font-medium text-ink ring-1 ring-brand-100 transition hover:bg-brand-100 disabled:opacity-60';

function GoogleButton({ onUser }: { onUser: (u: User) => void }) {
  const [busy, setBusy] = useState(false);
  const login = useGoogleLogin({
    onSuccess: async (res) => {
      try {
        const { user } = await api.googleLogin({ accessToken: res.access_token });
        onUser(user);
      } catch (err) {
        toast.error(err instanceof ApiError ? err.message : 'Google sign-in failed');
      } finally {
        setBusy(false);
      }
    },
    onError: () => {
      setBusy(false);
      toast.error('Google sign-in was cancelled');
    },
    onNonOAuthError: () => setBusy(false),
  });
  return (
    <button
      type="button"
      disabled={busy}
      onClick={() => {
        setBusy(true);
        login();
      }}
      className={googleBtn}
    >
      {busy ? <Loader2 size={16} className="animate-spin" /> : <GoogleIcon />} Login with Google
    </button>
  );
}

const input = 'w-full rounded-lg bg-surface px-3 py-2.5 text-sm outline-none ring-1 ring-transparent placeholder:text-muted focus:ring-brand-600';

export function LoginPage() {
  const { user, setUser } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const config = useQuery({ queryKey: ['auth-config'], queryFn: api.config, staleTime: Infinity });

  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const from = (location.state as { from?: string } | null)?.from ?? '/scheduled';
  const done = (u: User) => {
    setUser(u);
    navigate(from, { replace: true });
  };

  const submit = useMutation({
    mutationFn: () => (mode === 'login' ? api.login(email, password) : api.register(name, email, password)),
    onSuccess: ({ user }) => done(user),
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Something went wrong'),
  });

  if (user) return <Navigate to={from} replace />;

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    submit.mutate();
  };

  const clientId = config.data?.googleClientId;

  return (
    <main className="flex min-h-full items-center justify-center bg-white px-4">
      <div className="w-full max-w-sm rounded-2xl border border-line px-8 py-10 shadow-[0_8px_30px_rgba(0,0,0,0.04)]">
        <h1 className="mb-6 text-center text-2xl font-semibold">{mode === 'login' ? 'Login' : 'Create account'}</h1>

        {config.isLoading ? (
          <div className={googleBtn}>
            <Loader2 size={16} className="animate-spin" />
          </div>
        ) : clientId ? (
          <GoogleOAuthProvider clientId={clientId}>
            <GoogleButton onUser={done} />
          </GoogleOAuthProvider>
        ) : (
          <button type="button" disabled title="Set GOOGLE_CLIENT_ID on the backend to enable" className={googleBtn}>
            <GoogleIcon /> Google login not configured
          </button>
        )}

        <p className="my-5 text-center text-xs text-muted">or {mode === 'login' ? 'sign in' : 'sign up'} through email</p>

        <form onSubmit={onSubmit} className="space-y-3">
          {mode === 'register' && (
            <input className={input} placeholder="Full name" value={name} onChange={(e) => setName(e.target.value)} required autoComplete="name" />
          )}
          <input className={input} type="email" placeholder="Email ID" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" />
          <input
            className={input}
            type="password"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={8}
            autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
          />
          <button
            type="submit"
            disabled={submit.isPending}
            className="flex w-full items-center justify-center gap-2 rounded-lg bg-brand-600 py-2.5 text-sm font-semibold text-white transition hover:bg-brand-700 disabled:opacity-60"
          >
            {submit.isPending && <Loader2 size={16} className="animate-spin" />}
            {mode === 'login' ? 'Login' : 'Create account'}
          </button>
        </form>

        <p className="mt-5 text-center text-xs text-muted">
          {mode === 'login' ? "Don't have an account? " : 'Already have an account? '}
          <button type="button" onClick={() => setMode(mode === 'login' ? 'register' : 'login')} className="font-medium text-brand-600 hover:underline">
            {mode === 'login' ? 'Sign up' : 'Log in'}
          </button>
        </p>
      </div>
    </main>
  );
}
