import { useState, type FormEvent } from 'react';
import { VAULT_PASSPHRASE_MIN_LENGTH } from '../lib/crypto/store';

type VaultUnlockProps = {
  isNewVault: boolean;
  isLegacyVault: boolean;
  busy: boolean;
  error: string | null;
  onUnlock: (passphrase: string) => void;
  onStartFresh: () => void;
  onSignOut: () => void;
};

export const VaultUnlock = ({ isNewVault, isLegacyVault, busy, error, onUnlock, onStartFresh, onSignOut }: VaultUnlockProps) => {
  const [passphrase, setPassphrase] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (isNewVault && passphrase !== confirmation) return;
    onUnlock(passphrase);
    setPassphrase('');
    setConfirmation('');
  };

  const valid = passphrase.length > 0 && (!isNewVault || (passphrase.length >= VAULT_PASSPHRASE_MIN_LENGTH && passphrase === confirmation));
  return (
    <main className="flex h-full items-center justify-center px-6 py-12">
      <form onSubmit={submit} className="w-full max-w-sm space-y-4 rounded-2xl border border-line bg-panel p-7">
        <div>
          <h1 className="text-2xl font-semibold">{isNewVault ? 'Create your local vault' : 'Unlock your local vault'}</h1>
          <p className="mt-2 text-sm leading-6 text-ink-muted">
            This passphrase encrypts keys on this device. It is separate from Google sign-in and is never sent to WalkerChat or Supabase. Losing it may make this device’s keys unrecoverable.
          </p>
          {isLegacyVault ? (
            <p className="mt-2 text-sm leading-6 text-ink-muted">
              This older device vault will be copied only after its device identity matches your account. The original local data will be kept.
            </p>
          ) : null}
        </div>
        {error ? <p role="alert" className="rounded-field bg-danger-soft p-3 text-sm text-danger">{error}</p> : null}
        <label className="block text-sm font-medium" htmlFor="vault-passphrase">
          Vault passphrase
          <input id="vault-passphrase" required minLength={isNewVault ? VAULT_PASSPHRASE_MIN_LENGTH : 1} type="password" autoComplete={isNewVault ? 'new-password' : 'current-password'} value={passphrase} onChange={(event) => setPassphrase(event.target.value)} className="mt-2 h-11 w-full rounded-field border border-line bg-canvas px-3 text-sm" />
        </label>
        {isNewVault ? (
          <label className="block text-sm font-medium" htmlFor="vault-confirmation">
            Confirm passphrase
            <input id="vault-confirmation" required minLength={VAULT_PASSPHRASE_MIN_LENGTH} type="password" autoComplete="new-password" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} className="mt-2 h-11 w-full rounded-field border border-line bg-canvas px-3 text-sm" />
          </label>
        ) : null}
        <button disabled={busy || !valid} className="h-11 w-full rounded-field bg-accent px-4 text-sm font-medium text-on-accent disabled:opacity-60">
          {busy ? 'Unlocking…' : isNewVault ? 'Create vault' : 'Unlock vault'}
        </button>
        {isLegacyVault ? <button type="button" onClick={onStartFresh} className="w-full text-sm text-ink-muted">Start a separate device vault</button> : null}
        <button type="button" onClick={onSignOut} className="w-full text-sm text-ink-muted">Sign out</button>
      </form>
    </main>
  );
};
