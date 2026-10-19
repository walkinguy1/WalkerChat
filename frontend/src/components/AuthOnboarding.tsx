import { useState, type FormEvent } from 'react';

type AuthOnboardingProps = {
  busy: boolean;
  error: string | null;
  onCreate: (profile: { username: string; display_name: string }) => void;
  onLinkExisting: (credentials: { username: string; password: string }) => void;
  onSignOut: () => void;
};

export const AuthOnboarding = ({
  busy,
  error,
  onCreate,
  onLinkExisting,
  onSignOut,
}: AuthOnboardingProps) => {
  const [linkMode, setLinkMode] = useState(false);
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (linkMode) onLinkExisting({ username: username.trim(), password });
    else onCreate({ username: username.trim(), display_name: displayName.trim() });
  };

  return (
    <main className="flex h-full items-center justify-center overflow-y-auto px-6 py-12">
      <form onSubmit={submit} className="w-full max-w-sm space-y-4 rounded-2xl border border-line bg-panel p-7">
        <div>
          <h1 className="text-2xl font-semibold">{linkMode ? 'Link your existing account' : 'Choose your WalkerChat identity'}</h1>
          <p className="mt-2 text-sm leading-6 text-ink-muted">
            {linkMode
              ? 'Prove both your existing WalkerChat password and this Google session to keep your current chats and keys.'
              : 'Your public username is separate from your Google email. Your profile name is optional.'}
          </p>
        </div>
        {error ? <p role="alert" className="rounded-field bg-danger-soft p-3 text-sm text-danger">{error}</p> : null}
        <label className="block text-sm font-medium" htmlFor="walker-username">
          WalkerChat username
          <input id="walker-username" required minLength={3} maxLength={32} pattern="[A-Za-z0-9_.-]+" autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)} className="mt-2 h-11 w-full rounded-field border border-line bg-canvas px-3 text-sm" />
        </label>
        {linkMode ? (
          <label className="block text-sm font-medium" htmlFor="existing-password">
            Existing WalkerChat password
            <input id="existing-password" required type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} className="mt-2 h-11 w-full rounded-field border border-line bg-canvas px-3 text-sm" />
          </label>
        ) : (
          <label className="block text-sm font-medium" htmlFor="display-name">
            Display name (optional)
            <input id="display-name" maxLength={80} autoComplete="name" value={displayName} onChange={(event) => setDisplayName(event.target.value)} className="mt-2 h-11 w-full rounded-field border border-line bg-canvas px-3 text-sm" />
          </label>
        )}
        <button disabled={busy || username.trim().length < 3 || (linkMode && !password)} className="h-11 w-full rounded-field bg-accent px-4 text-sm font-medium text-on-accent disabled:opacity-60">
          {busy ? 'Please wait…' : linkMode ? 'Link account' : 'Create WalkerChat account'}
        </button>
        <button type="button" onClick={() => setLinkMode(!linkMode)} className="w-full text-sm text-accent">
          {linkMode ? 'Create a new account instead' : 'I already have a WalkerChat account'}
        </button>
        <button type="button" onClick={onSignOut} className="w-full text-sm text-ink-muted">Sign out</button>
      </form>
    </main>
  );
};
