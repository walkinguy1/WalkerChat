# Phase 2: Supabase Auth and Google sign-in

## Architecture

Supabase Auth is the identity provider; Google is the only accepted initial provider.
The frontend uses `@supabase/supabase-js` with PKCE, session restoration, automatic
refresh, and `signInWithOAuth({ provider: "google" })`. The only browser-visible
Supabase settings are `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY`. Google
identity scopes are `openid email profile`; WalkerChat does not request Drive or Gmail
access.

FastAPI remains the application API and authorization boundary. It validates the
Supabase access token, looks up the immutable `auth.users.id` subject mapping, and
issues the existing short-lived WalkerChat JWT. This JWT expires at
`JWT_EXPIRY_MINUTES` (60 minutes by default), is checked against the existing revocation
store, and is used for REST APIs and the existing one-time WebSocket-ticket endpoint.
WebSocket URLs continue to carry only the short-lived single-use ticket. Chat membership,
sender identity checks, media authorization, and encryption-key authorization remain
backend enforced.

For asymmetric Supabase signing keys, the backend verifies ES256 or RS256 signatures
against the project JWKS, checks `iss`, `aud=authenticated`, `exp`, `iat`, `sub`, and
allowed algorithm, caches keys for five minutes, and refreshes immediately for an
unknown `kid`. It then calls the configured Supabase Auth `/user` endpoint to confirm
the session remains valid and is Google-authenticated. For legacy HS256 signing, the
backend never stores or requests the shared JWT secret; it delegates signature/session
verification to that Auth endpoint and then checks issuer, audience, and time claims.
No service-role key is used.

## Account mapping and migration

`users.id` remains the WalkerChat relational primary key. Migration
`0002_supabase_identity` adds nullable `display_name`, nullable unique
`supabase_subject`, and makes `password_hash` nullable for accounts created by Supabase.
The migration does not rewrite IDs, remove users, touch chats/messages/devices/keys, or
change foreign keys. PostgreSQL's unique index allows multiple `NULL` subjects while
preventing duplicate provider IDs.

Existing local accounts are not linked from email. A user must sign in to Google and
prove the existing WalkerChat username/password through `/api/auth/supabase/link-existing`.
The existing `users.id` and its foreign-key relationships are retained. Password
register/login endpoints return 404 outside `APP_ENV=development`; the dual-proof link
endpoint is the only legacy-password bridge in staging/production. New onboarding
claims a unique username and optional display name. Concurrent duplicate usernames or
subjects are rejected by the database constraint and returned as safe 409 responses.

The migration is forward-only. Before applying, take a database backup and inspect the
SQL with `alembic upgrade 0002_supabase_identity --sql` (or the repository's Alembic
configuration equivalent) against the intended environment. Then apply
`alembic upgrade head`. Do not run a downgrade: it intentionally stops before changing
the schema because dropping subject mappings can strand accounts and restoring
`password_hash NOT NULL` is incompatible with Supabase-only users. Rollback requires a
verified backup restore or a separately reviewed forward migration; no live database
rollback was run for this phase.

## Browser vault

Google login is independent of the local encryption vault. The browser asks for a
vault passphrase when creating or unlocking it and passes only that passphrase to
`CryptoStore.unlock`. The passphrase is not sent to Supabase, FastAPI, or logs. At the
end of Phase 2, vaults remained in the prior username-scoped IndexedDB namespace. Phase
3 added a non-destructive migration to an immutable account-scoped namespace, detailed
in [phase-03-vault.md](phase-03-vault.md). No recovery code or server-side key escrow
was added.

## Human Supabase and Google setup

1. Create a Supabase project and note its Project URL and publishable key. Prefer an
   asymmetric ES256 or RS256 JWT signing key; the backend also supports legacy HS256 by
   verifying through Supabase Auth.
2. In **Authentication → URL Configuration**, set the Site URL and add exact allowed
   browser redirect URLs for each environment, for example
   `http://localhost:5173/`, `https://staging.example.com/`, and
   `https://chat.example.com/`. The app returns to the current site origin, so that
   exact origin must be allowlisted.
3. In Google Cloud's Google Auth Platform, configure the consent screen for the
   `openid`, email, and profile identity scopes. Create a Web OAuth client. Add each
   app origin as an Authorized JavaScript origin. Add the exact callback shown on the
   Supabase Google provider page to Authorized redirect URIs (normally
   `https://<project-ref>.supabase.co/auth/v1/callback`).
4. In **Authentication → Providers → Google**, enable Google and enter that OAuth
   client's ID and secret. Keep the Google client secret in Supabase Dashboard only;
   never put it in a frontend or `VITE_*` variable.
5. Configure backend `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY`; configure frontend
   `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` with the same project URL and
   safe publishable key. Set the remaining production backend settings separately.
6. Apply the Alembic migration to a disposable or backed-up target, start FastAPI and
   Vite, then test Google consent, callback/session restore, onboarding, vault unlock,
   sign-out, and a returning login in a real browser.

The checked-in examples use placeholders. No provider credentials were supplied here,
so a real Google OAuth/browser test has not been performed and OAuth is not yet verified
as operational for a deployed project.

## Validation results

| Command | Result |
|---|---|
| `npm test -- --run` in `frontend/` | Passed: 11 test files, 176 tests. A sandboxed attempt failed because Vitest could not rename temporary cache files; the rerun outside the sandbox passed. |
| `npm run build` | Passed. Vite warned that Browserslist data is about six months old. |
| `npm run lint` | Passed. |
| `npm audit --json` | Passed with zero reported vulnerabilities. |
| `npm audit --omit=dev --json` | Passed with zero reported vulnerabilities. |
| `python -m pytest -q` in `backend/` | Passed: 40 tests in 3.95 seconds. Provider, database, and service calls use test keys and mocks/fakes. |
| `python -m compileall -q app alembic tests` | Passed. |
| Backend import (`import app.main`) | Passed. |
| `python scripts/check_migration_matches_models.py` | Passed: 8 tables, 49 columns. |
| `alembic upgrade head --sql` | Passed: generated offline SQL for revisions `0001_e2ee_baseline` and `0002_supabase_identity`; no database was contacted. |
| `docker compose --env-file .env.example config --quiet` | Passed. |
| `git diff --check` | Passed during final review. |

No live PostgreSQL, Redis, MinIO, Supabase Auth, Google OAuth, or production deployment
checks were performed.

## Compatibility and limitations

- Existing local accounts keep their user IDs and data; they need an explicit dual-proof
  link before they can use Supabase sign-in.
- Local username/password login remains available only in the development frontend and
  backend. Staging and production require Supabase sessions for application tokens.
- The internal WalkerChat JWT is revocable and expires after its configured lifetime.
  Supabase refresh events cause the frontend to exchange a newly refreshed Supabase
  session; a Supabase sign-out clears and revokes the WalkerChat token.
- Supabase access tokens are never placed in REST query strings or WebSocket URLs.
- The vault is per browser and username. Losing its passphrase can make locally sealed
  private keys unrecoverable. Device-to-device key recovery is not included.
- There is no account deletion, provider unlinking, or automatic email-based migration.
- Database, Redis, MinIO, and production services were not used for automated tests.
