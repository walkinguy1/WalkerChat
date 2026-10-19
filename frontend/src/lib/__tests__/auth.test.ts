import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  restoreSupabaseSession,
  signOutFromSupabase,
  startGoogleSignInWith,
  subscribeToSession,
} from '../auth';
import {
  exchangeSupabaseSession,
  linkExistingAccount,
  logout,
  onboardSupabaseAccount,
} from '../api';

const authClient = (auth: object) => ({ auth }) as unknown as SupabaseClient;

afterEach(() => vi.unstubAllGlobals());

describe('Supabase auth adapter', () => {
  it('starts Google login with identity profile scopes and an explicit redirect', async () => {
    const signInWithOAuth = vi.fn().mockResolvedValue({ error: null });
    const client = authClient({ signInWithOAuth });
    await startGoogleSignInWith(client, 'https://chat.example.test/');
    expect(signInWithOAuth).toHaveBeenCalledWith({
      provider: 'google',
      options: {
        redirectTo: 'https://chat.example.test/',
        scopes: 'openid email profile',
      },
    });
  });

  it('shows a safe error when OAuth setup fails', async () => {
    const client = authClient({ signInWithOAuth: vi.fn().mockResolvedValue({ error: new Error('provider secret') }) });
    await expect(startGoogleSignInWith(client, 'https://chat.example.test/')).rejects.toThrow(
      'Google sign-in could not be started. Please try again.',
    );
  });

  it('restores an existing session and reports expired-session restoration failure safely', async () => {
    const session = { access_token: 'test-only-access-token' };
    const client = authClient({ getSession: vi.fn().mockResolvedValue({ data: { session }, error: null }) });
    await expect(restoreSupabaseSession(client)).resolves.toEqual(session);

    const failed = authClient({ getSession: vi.fn().mockResolvedValue({ data: { session: null }, error: new Error('private detail') }) });
    await expect(restoreSupabaseSession(failed)).rejects.toThrow(
      'Unable to restore your sign-in session. Please sign in again.',
    );
  });

  it('subscribes to callbacks and releases the Supabase listener', () => {
    const unsubscribe = vi.fn();
    const callback = vi.fn();
    const onAuthStateChange = vi.fn().mockReturnValue({ data: { subscription: { unsubscribe } } });
    const stop = subscribeToSession(authClient({ onAuthStateChange }), callback);
    expect(onAuthStateChange).toHaveBeenCalledOnce();
    stop();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it('signs out the Supabase session', async () => {
    const signOut = vi.fn().mockResolvedValue({ error: null });
    await signOutFromSupabase(authClient({ signOut }));
    expect(signOut).toHaveBeenCalledOnce();
  });
});

describe('WalkerChat Supabase session exchange', () => {
  const token = { access_token: 'internal-test-token', token_type: 'bearer', user_id: 'user-1', username: 'walker' };

  it('exchanges a Supabase session for an internal API token', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(token), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    await expect(exchangeSupabaseSession('https://api.example.test', 'supabase-test-token')).resolves.toEqual(token);
    expect(fetch).toHaveBeenCalledWith('https://api.example.test/api/auth/supabase/exchange', expect.objectContaining({
      headers: { Authorization: 'Bearer supabase-test-token' },
    }));
  });

  it('routes unmapped identities to onboarding and surfaces username conflicts', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ detail: { code: 'identity_not_onboarded', message: 'Choose a username.' } }), { status: 404 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ detail: 'Username already taken.' }), { status: 409 })));
    await expect(exchangeSupabaseSession('https://api.example.test', 'supabase-test-token')).rejects.toMatchObject({
      status: 404,
      code: 'identity_not_onboarded',
    });
    await expect(onboardSupabaseAccount('https://api.example.test', 'supabase-test-token', {
      username: 'taken', display_name: 'Test User',
    })).rejects.toMatchObject({ status: 409, message: 'Username already taken.' });
  });

  it('sends explicit old-account proof only with the verified Supabase session and revokes internal tokens at sign-out', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(token), { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetch);
    await linkExistingAccount('https://api.example.test', 'supabase-test-token', {
      username: 'old', password: 'local-only-proof',
    });
    await logout('https://api.example.test', 'internal-test-token');
    expect(fetch.mock.calls[0][1]).toMatchObject({
      headers: { Authorization: 'Bearer supabase-test-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'old', password: 'local-only-proof' }),
    });
    expect(fetch.mock.calls[1][1]).toMatchObject({ headers: { Authorization: 'Bearer internal-test-token' } });
  });
});
