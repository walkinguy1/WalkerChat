import { ArrowRight, KeyRound, Lock, Radio, Video } from 'lucide-react';
import { Avatar } from './ui/Avatar';
import { Logo } from './ui/Logo';
import { ThemeToggle } from './ThemeToggle';

export type DemoAccount = {
  username: string;
  password: string;
  displayName: string;
  initials: string;
  role: string;
};

interface SignInProps {
  accounts: readonly DemoAccount[];
  pendingUsername: string | null;
  isSigningIn: boolean;
  onSignIn: (account: DemoAccount) => void;
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

export const SignIn = ({ accounts, pendingUsername, isSigningIn, onSignIn }: SignInProps) => (
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
        <span className="h-1.5 w-1.5 rounded-full bg-warn" />
        Demo build — the crypto path is experimental, not a Signal Protocol implementation.
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

        <h2 className="text-2xl font-semibold tracking-[-0.02em]">Choose a demo identity</h2>
        <p className="mt-2 text-sm leading-6 text-ink-muted">
          Both accounts are seeded on the backend. Sign in as each one in two windows to
          watch the key exchange complete and messages decrypt live.
        </p>

        <ul className="mt-8 space-y-3">
          {accounts.map((account) => {
            const isPending = isSigningIn && pendingUsername === account.username;

            return (
              <li key={account.username}>
                <button
                  type="button"
                  disabled={isSigningIn}
                  onClick={() => onSignIn(account)}
                  className="group flex w-full items-center gap-4 rounded-card border border-line bg-panel p-4 text-left transition-all duration-200 hover:border-accent/50 hover:bg-raised hover:shadow-card disabled:cursor-not-allowed disabled:opacity-60"
                >
                  <Avatar name={account.displayName} initials={account.initials} size="lg" />

                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[15px] font-medium">
                      {account.displayName}
                    </span>
                    <span className="mt-0.5 block truncate text-[13px] text-ink-muted">
                      @{account.username} · {account.role}
                    </span>
                  </span>

                  {isPending ? (
                    <span
                      aria-label="Signing in"
                      className="h-4 w-4 flex-shrink-0 animate-spin rounded-full border-2 border-line-strong border-t-accent"
                    />
                  ) : (
                    <ArrowRight
                      className="h-4 w-4 flex-shrink-0 text-ink-subtle transition-transform duration-200 group-hover:translate-x-0.5 group-hover:text-accent"
                      aria-hidden="true"
                    />
                  )}
                </button>
              </li>
            );
          })}
        </ul>

        <p className="mt-8 flex items-start gap-2.5 rounded-field border border-line bg-panel p-3.5 text-[13px] leading-6 text-ink-muted">
          <Lock className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-signal" aria-hidden="true" />
          Your identity keypair is generated in this browser and stored locally. Signing out
          clears the derived session keys.
        </p>
      </div>
    </section>
  </div>
);
