import { createClient, type Session, type SupabaseClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const publishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

export const supabaseClient: SupabaseClient | null =
  supabaseUrl && publishableKey
    ? createClient(supabaseUrl, publishableKey, {
        auth: { flowType: 'pkce', detectSessionInUrl: true, autoRefreshToken: true, persistSession: true },
      })
    : null;

export const startGoogleSignInWith = async (
  client: SupabaseClient,
  redirectTo: string,
): Promise<void> => {
  const { error } = await client.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo, scopes: 'openid email profile' },
  });
  if (error) throw new Error('Google sign-in could not be started. Please try again.');
};

export const restoreSupabaseSession = async (client: SupabaseClient): Promise<Session | null> => {
  const { data, error } = await client.auth.getSession();
  if (error) throw new Error('Unable to restore your sign-in session. Please sign in again.');
  return data.session;
};

export const refreshSupabaseSession = async (): Promise<Session | null> => {
  if (!supabaseClient) return null;
  const { data, error } = await supabaseClient.auth.refreshSession();
  if (error) throw new Error('Your Google session could not be refreshed. Please sign in again.');
  return data.session;
};

export const subscribeToSession = (
  client: SupabaseClient,
  callback: (session: Session | null) => void,
): (() => void) => {
  const { data } = client.auth.onAuthStateChange((_event, session) => callback(session));
  return () => data.subscription.unsubscribe();
};

export const signOutFromSupabase = async (client: SupabaseClient): Promise<void> => {
  const { error } = await client.auth.signOut();
  if (error) throw new Error('Unable to sign out of Google authentication.');
};

export const startGoogleSignIn = async (): Promise<void> => {
  if (!supabaseClient) {
    throw new Error('Google sign-in is not configured for this app.');
  }
  // The app's own origin is used; Supabase must allowlist it in URL Configuration.
  await startGoogleSignInWith(supabaseClient, `${window.location.origin}/`);
};

export const getSupabaseSession = async (): Promise<Session | null> => {
  if (!supabaseClient) return null;
  return restoreSupabaseSession(supabaseClient);
};

export const subscribeToSupabaseSession = (
  callback: (session: Session | null) => void,
): (() => void) => {
  if (!supabaseClient) return () => undefined;
  return subscribeToSession(supabaseClient, callback);
};

export const signOutSupabase = async (): Promise<void> => {
  if (!supabaseClient) return;
  await signOutFromSupabase(supabaseClient);
};
