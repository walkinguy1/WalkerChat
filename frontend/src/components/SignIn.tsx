import { type FormEvent, useState } from 'react';
import { ArrowRight, KeyRound, Lock, Radio, Video } from 'lucide-react';
import { Logo } from './ui/Logo';
import { ThemeToggle } from './ThemeToggle';

interface SignInProps {
  pendingUsername: string | null;
  isSigningIn: boolean;
  onSignIn: (username: string, password: string) => void;
}

const capabilities = [
  {
    icon: Lock,
    title: 'Client-side envelopes',
    body: 'Message bodies and photos are sealed with AES-GCM before they leave the tab.',
  },
  {
    icon: KeyRound,
    title: 'ECDH key agreement',
    body: 'Each pair derives a shared key from prekey bundles. The server never sees it.',
  },
  {
    icon: Radio,
    title: 'Ticketed sockets',
    body: 'Realtime delivery uses a short-lived ticket, so the JWT stays out of the URL.',
  },
  {
    icon: Video,
    title: 'Peer-to-peer calls',
    body: 'Voice and video negotiate over WebRTC and flow directly between devices.',
  },
];

export const SignIn = ({ pendingUsername, isSigningIn, onSignIn }: SignInProps) => {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    onSignIn(username.trim(), password);
  };

  return (
    <div className="grid h-full grid-cols-1 overflow-y-auto scroll-slim lg:grid-cols-[1.05fr_1fr] lg:overflow-hidden">
    {/* Brand column — hidden on small screens where it would just push the
        actual sign-in action below the fold. */}
    <section className="relative hidden flex-col justify-between overflow-hidden border-r border-line bg-panel p-12 lg:flex">
      <div aria-hidden="true" className="grid-veil pointer-events-none absolute inset-0 opacity-60" />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -top-32 -left-24 h-96 w-96 rounded-full bg-accent/12 blur-3xl"
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -right-32 bottom-0 h-96 w-96 rounded-full bg-signal/10 blur-3xl"
      />

      <div className="relative flex items-center gap-3">
        <Logo className="h-10 w-10" />
        <span className="text-[15px] font-semibold tracking-tight">WalkerChat</span>
      </div>

      <div className="relative max-w-lg">
        <h1 className="text-[2.75rem] leading-[1.08] font-semibold tracking-[-0.035em] text-balance">
          Conversations the server
          <span className="text-ink-subtle"> cannot read.</span>
        </h1>
        <p className="mt-5 text-[15px] leading-7 text-ink-muted">
          WalkerChat encrypts every message, photo, and attachment inside the browser.
          The backend stores ciphertext, relays it, and learns nothing else.
        </p>

        <dl className="mt-10 grid gap-x-8 gap-y-7 sm:grid-cols-2">
          {capabilities.map(({ icon: Icon, title, body }) => (
            <div key={title}>
              <dt className="flex items-center gap-2.5 text-sm font-medium">
                <Icon className="h-4 w-4 text-accent" aria-hidden="true" />
                {title}
              </dt>
              <dd className="mt-1.5 pl-[26px] text-[13px] leading-6 text-ink-muted">{body}</dd>
            </div>
          ))}
        </dl>
      </div>

      <p className="relative flex items-center gap-2 text-xs text-ink-subtle">
        <span className="h-1.5 w-1.5 rounded-full bg-signal" />
        End-to-end encrypted with X3DH and the Double Ratchet.
      </p>
    </section>

    {/* Sign-in column */}
    <section className="relative flex flex-col justify-center px-6 py-12 sm:px-12 lg:px-16">
      <div className="absolute top-5 right-5">
        <ThemeToggle />
      </div>

      <div className="mx-auto w-full max-w-sm">
        <div className="mb-10 flex items-center gap-3 lg:hidden">
          <Logo className="h-10 w-10" />
          <span className="text-[15px] font-semibold tracking-tight">WalkerChat</span>
        </div>

        <h2 className="text-2xl font-semibold tracking-[-0.02em]">Sign in</h2>
        <p className="mt-2 text-sm leading-6 text-ink-muted">
          Use your WalkerChat username and password. Local demo identities are available
          when demo seeding is enabled on the backend.
        </p>

        <form className="mt-8 space-y-4" onSubmit={submit}>
          <label className="block text-sm font-medium" htmlFor="username">
            Username
            <input
              id="username"
              name="username"
              type="text"
              autoComplete="username"
              required
              minLength={3}
              maxLength={32}
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              disabled={isSigningIn}
              className="mt-2 h-11 w-full rounded-field border border-line bg-panel px-3 text-sm text-ink outline-none transition-colors placeholder:text-ink-subtle focus:border-accent disabled:opacity-60"
              placeholder="Username"
            />
          </label>
          <label className="block text-sm font-medium" htmlFor="password">
            Password
            <input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              disabled={isSigningIn}
              className="mt-2 h-11 w-full rounded-field border border-line bg-panel px-3 text-sm text-ink outline-none transition-colors placeholder:text-ink-subtle focus:border-accent disabled:opacity-60"
              placeholder="Password"
            />
          </label>
          <button
            type="submit"
            disabled={isSigningIn || !username.trim() || !password}
            className="group flex h-11 w-full items-center justify-center gap-2 rounded-field bg-accent px-4 text-sm font-medium text-on-accent transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isSigningIn ? (
              <span
                aria-label={`Signing in as ${pendingUsername ?? username}`}
                className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white"
              />
            ) : (
              <>
                Sign in
                <ArrowRight
                  className="h-4 w-4 transition-transform duration-200 group-hover:translate-x-0.5"
                  aria-hidden="true"
                />
              </>
            )}
          </button>
        </form>

        <p className="mt-8 flex items-start gap-2.5 rounded-field border border-line bg-panel p-3.5 text-[13px] leading-6 text-ink-muted">
          <Lock className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-signal" aria-hidden="true" />
          Your identity keypair is generated in this browser and stored locally. Signing out
          clears the derived session keys.
        </p>
      </div>
    </section>
    </div>
  );
};
