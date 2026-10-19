import { useState, type FormEvent } from 'react';

type VaultUnlockProps = {
  isNewVault: boolean;
  busy: boolean;
  error: string | null;
  onUnlock: (passphrase: string) => void;
  onSignOut: () => void;
};

export const VaultUnlock = ({ isNewVault, busy, error, onUnlock, onSignOut }: VaultUnlockProps) => {
  const [passphrase, setPassphrase] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (isNewVault && passphrase !== confirmation) return;
    onUnlock(passphrase);
  };

  const valid = passphrase.length > 0 && (!isNewVault || (passphrase.length >= 12 && passphrase === confirmation));
  return (
    <main className="flex h-full items-center justify-center px-6 py-12">
      <form onSubmit={submit} className="w-full max-w-sm space-y-4 rounded-2xl border border-line bg-panel p-7">
        <div>
          <h1 className="text-2xl font-semibold">{isNewVault ? 'Create your local vault' : 'Unlock your local vault'}</h1>
          <p className="mt-2 text-sm leading-6 text-ink-muted">
            This passphrase encrypts keys on this device. It is separate from Google sign-in and is never sent to WalkerChat or Supabase. Losing it may make this device’s keys unrecoverable.
          </p>
        </div>
        {error ? <p role="alert" className="rounded-field bg-danger-soft p-3 text-sm text-danger">{error}</p> : null}
        <label className="block text-sm font-medium" htmlFor="vault-passphrase">
          Vault passphrase
          <input id="vault-passphrase" required minLength={isNewVault ? 12 : 1} type="password" autoComplete={isNewVault ? 'new-password' : 'current-password'} value={passphrase} onChange={(event) => setPassphrase(event.target.value)} className="mt-2 h-11 w-full rounded-field border border-line bg-canvas px-3 text-sm" />
        </label>
        {isNewVault ? (
          <label className="block text-sm font-medium" htmlFor="vault-confirmation">
            Confirm passphrase
            <input id="vault-confirmation" required minLength={12} type="password" autoComplete="new-password" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} className="mt-2 h-11 w-full rounded-field border border-line bg-canvas px-3 text-sm" />
          </label>
        ) : null}
        <button disabled={busy || !valid} className="h-11 w-full rounded-field bg-accent px-4 text-sm font-medium text-on-accent disabled:opacity-60">
          {busy ? 'Unlocking…' : isNewVault ? 'Create vault' : 'Unlock vault'}
        </button>
        <button type="button" onClick={onSignOut} className="w-full text-sm text-ink-muted">Sign out</button>
      </form>
    </main>
  );
};
