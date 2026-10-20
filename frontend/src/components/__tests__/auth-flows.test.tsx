// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthOnboarding } from '../AuthOnboarding';
import { EmptyWorkspace } from '../EmptyWorkspace';
import { SignIn } from '../SignIn';
import { VaultUnlock } from '../VaultUnlock';

afterEach(cleanup);

describe('authentication UI flows', () => {
  it('submits Google sign-in and displays safe provider errors', async () => {
    const user = userEvent.setup();
    const onGoogleSignIn = vi.fn();
    const props = {
      pendingUsername: null,
      isSigningIn: false,
      onSignIn: vi.fn(),
      onGoogleSignIn,
      error: null,
    };
    const { rerender } = render(<SignIn {...props} />);
    await user.click(screen.getByRole('button', { name: 'Continue with Google' }));
    expect(onGoogleSignIn).toHaveBeenCalledOnce();

    rerender(<SignIn {...props} error="Google sign-in could not be started. Please try again." />);
    expect(screen.getByRole('alert').textContent).toContain('Google sign-in could not be started');
  });

  it('requires onboarding after a new provider login and submits the chosen profile', async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn();
    render(<AuthOnboarding busy={false} error={null} onCreate={onCreate} onLinkExisting={vi.fn()} onSignOut={vi.fn()} />);
    await user.type(screen.getByLabelText('WalkerChat username'), 'new_walker');
    await user.type(screen.getByLabelText('Display name (optional)'), 'New Walker');
    await user.click(screen.getByRole('button', { name: 'Create WalkerChat account' }));
    expect(onCreate).toHaveBeenCalledWith({ username: 'new_walker', display_name: 'New Walker' });
  });

  it('shows username conflict errors and supports explicit existing-account linking', async () => {
    const user = userEvent.setup();
    const onLinkExisting = vi.fn();
    const props = {
      busy: false,
      error: 'Username already taken.',
      onCreate: vi.fn(),
      onLinkExisting,
      onSignOut: vi.fn(),
    };
    render(<AuthOnboarding {...props} />);
    expect(screen.getByRole('alert').textContent).toContain('Username already taken.');
    await user.click(screen.getByRole('button', { name: 'I already have a WalkerChat account' }));
    await user.type(screen.getByLabelText('WalkerChat username'), 'old_account');
    await user.type(screen.getByLabelText('Existing WalkerChat password'), 'old-password');
    await user.click(screen.getByRole('button', { name: 'Link account' }));
    expect(onLinkExisting).toHaveBeenCalledWith({ username: 'old_account', password: 'old-password' });
  });

  it('keeps vault passphrase separate and requires confirmation for new vaults', async () => {
    const onUnlock = vi.fn();
    render(<VaultUnlock isNewVault isLegacyVault={false} busy={false} error={null} onUnlock={onUnlock} onStartFresh={vi.fn()} onSignOut={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Vault passphrase'), { target: { value: 'a-long-vault-passphrase' } });
    fireEvent.change(screen.getByLabelText('Confirm passphrase'), { target: { value: 'a-long-vault-passphrase' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create vault' }));
    expect(onUnlock).toHaveBeenCalledWith('a-long-vault-passphrase');
    expect(screen.getByText(/never sent to WalkerChat or Supabase/i)).toBeTruthy();
  });

  it('shows the empty workspace action and keeps sign-out available with no chats', async () => {
    const user = userEvent.setup();
    const onFindPeople = vi.fn();
    const onLock = vi.fn();
    const onSignOut = vi.fn();
    render(<EmptyWorkspace displayName="New Walker" onFindPeople={onFindPeople} onLock={onLock} onSignOut={onSignOut} />);
    expect(screen.getByText('Welcome, New Walker')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Find people and start a conversation' }));
    expect(onFindPeople).toHaveBeenCalledOnce();
    await user.click(screen.getByRole('button', { name: 'Lock vault' }));
    expect(onLock).toHaveBeenCalledOnce();
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(onSignOut).toHaveBeenCalledOnce();
  });
});
