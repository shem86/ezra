// The sign-in screen. Before this existed the only way into the console was
// hand-editing `?token=…` onto the URL, so a routine cookie expiry presented as
// "the back office is down" (2026-08-10 incident). The shell is served
// unauthenticated precisely so this can render.
import { useState, type FormEvent } from 'react';
import { signIn as apiSignIn } from '../api/client';

export function SignIn({
  onSignedIn,
  signIn = apiSignIn,
}: {
  onSignedIn: () => void;
  /** Injected in tests. Sign-in is deliberately NOT part of ApiClient — that
   *  interface is the data-read surface every screen stubs. */
  signIn?: (token: string) => Promise<void>;
}): React.JSX.Element {
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    const value = token.trim();
    if (value === '' || busy) return;
    setBusy(true);
    setError(null);
    try {
      await signIn(value);
      setToken('');
      onSignedIn();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'sign-in failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="signin">
      <form className="signin-card" onSubmit={(e) => void submit(e)}>
        <div className="brand">
          <div className="brand-mark">ע</div>
          <div>
            <div className="brand-name">Ezra</div>
            <div className="brand-sub">backoffice</div>
          </div>
        </div>

        <label className="signin-label" htmlFor="bo-token">
          Console token
        </label>
        <input
          id="bo-token"
          className="signin-input"
          type="password"
          autoComplete="current-password"
          autoFocus
          placeholder="BACKOFFICE_TOKEN"
          value={token}
          onChange={(e) => setToken(e.target.value)}
        />

        <button className="btn btn-ok signin-submit" type="submit" disabled={busy || token.trim() === ''}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>

        {error !== null && (
          <div className="signin-error" role="alert">
            {error}
          </div>
        )}

        <p className="signin-hint">
          Read-only console. The token is <code>BACKOFFICE_TOKEN</code> from the host&rsquo;s <code>.env</code>; it is
          kept in an httpOnly cookie that renews while you use the console.
        </p>
      </form>
    </div>
  );
}
