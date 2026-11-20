# WalkerChat implementation status

Updated: 2026-11-19

## Phase 1: trustworthy baseline and safe configuration

**Status: COMPLETE.** All available validation checks passed. The final backend suite
passed with fakes and without PostgreSQL, Redis, MinIO, OAuth, or production credentials.
Live-service integration checks were not run.

Phase 1 changed configuration, test/debug routing, local sign-in, runtime fallback
behavior, CI, and documentation. It did not add Google OAuth or chat capabilities, move
media storage, change the WebSocket event schema, or modify WebRTC implementation.

## Current source map

| Area | Current entry points and evidence |
|---|---|
| Frontend | `frontend/src/main.tsx`, `frontend/src/App.tsx`; React/Vite. `frontend/src/lib/auth.ts` adapts Supabase Auth/Google PKCE sessions; `frontend/src/lib/api.ts` exchanges verified provider sessions for WalkerChat API tokens. `SignIn.tsx`, `AuthOnboarding.tsx`, and `VaultUnlock.tsx` handle login, profile setup, and local vault unlock separately. |
| Backend | `backend/app/main.py` creates the FastAPI app and lifespan; routers live in `backend/app/api/`, models in `backend/app/models/`, and business logic in `backend/app/services/`. Endpoints are async. |
| PostgreSQL and migrations | SQLAlchemy models in `backend/app/models/`; migrations are `0001_e2ee_baseline.py`, `0002_supabase_identity.py`, and `0003_contacts_and_chat_admin.py`. The revisions preserve existing `users.id` values; Phase 4 adds normalized usernames and additive contact/block tables without removing chats or messages. `backend/alembic/env.py` takes the database URL from validated app settings. `backend/app/core/database.py` checks for missing model tables at startup. `backend/scripts/check_migration_matches_models.py` compares migration-chain table/column names without a database. |
| Authentication | `backend/app/api/auth.py` implements development-only username/password auth, Supabase onboarding/session exchange, explicit dual-proof legacy account linking, logout, and WebSocket-ticket issuance. `backend/app/core/supabase_auth.py` verifies Supabase access tokens; `backend/app/core/security.py` maps internal JWTs to local users and handles revocation/tickets. `backend/app/core/rate_limit.py` limits auth and prekey-claim requests. |
| WebSockets | `backend/app/api/ws.py` handles `/api/ws/chat`; `backend/app/schemas/chat.py` defines the realtime contract; `backend/app/core/ws_manager.py` tracks sockets and uses Redis Pub/Sub; `backend/app/core/runtime_state.py` stores tickets, revocations, and counters. Message routing follows chat membership. |
| Contact discovery and group authorization | `backend/app/api/chats.py` and `backend/app/services/chat_admin.py` implement username search, contact requests/blocks, direct-chat eligibility, and owner/admin group mutation checks. `backend/app/models/contact.py` defines relationship records. `backend/app/api/keys.py` limits key discovery to self, accepted contacts, or shared chat members; `backend/app/api/media.py` and WebSocket service checks enforce membership and block policy. Frontend workflows live in `frontend/src/components/NewChatDialog.tsx`, `GroupSettingsDialog.tsx`, `frontend/src/lib/api.ts`, and `frontend/src/App.tsx`. |
| Cryptography | `frontend/src/lib/crypto/` contains X3DH, XEdDSA, Double Ratchet, Sender Keys, fingerprints, and IndexedDB vault storage. The vault uses PBKDF2-HMAC-SHA-256 and AES-GCM in `store.ts`; Phase 3 moved new vaults to account-ID namespaces, versioned vault metadata, verified legacy copies, and serialized shared-tab state changes. Tests are under `frontend/src/lib/crypto/__tests__/`; `docs/CRYPTO.md` describes protocol details and known limits. |
| Encrypted media | `frontend/src/lib/media.ts` validates and encrypts image/PDF/UTF-8 text attachments with per-file AES-GCM keys; `EncryptedAttachment.tsx` decrypts locally and uses download-first documents. `backend/app/api/media.py` checks chat authorization; `backend/app/core/storage.py` uses MinIO locally or private Supabase Storage S3 in non-development deployments. The server stores opaque bytes and non-sensitive operational metadata only. |
| Calling | `frontend/src/hooks/useWebRTC.ts` and `frontend/src/components/CallOverlay.tsx` implement the browser call flow. Signaling rides the existing chat WebSocket. `backend/app/api/webrtc.py` serves ICE configuration; the backend does not carry call media. |

### Configuration and security baseline

- `APP_ENV` supports `development`, `staging`, and `production`; development is the safe
  default for local startup. Staging and production reject development debug routes and
  demo seeding.
- `SEED_DEMO_ACCOUNTS` defaults to false. When deliberately enabled in development,
  `DEMO_ACCOUNT_PASSWORD` must be set to a non-placeholder local value. Existing Alice
  and Bob IDs cannot authenticate outside development.
- `ENABLE_TEST_ROUTES` defaults to false. The test router is imported and mounted only
  when the app is in development and that switch is enabled. Non-development settings
  reject the switch.
- Staging and production require a strong, non-placeholder `JWT_SECRET`, `DEBUG=false`,
  an explicit HTTPS `CORS_ORIGINS` list, non-local database/Redis/storage endpoints,
  non-default storage credentials, and TLS for object storage. Configuration errors
  report setting names without echoing supplied values.
- Redis absence permits an in-memory fallback only in development. That fallback is
  single-process-only. Staging/production startup requires Redis for WebSocket fanout
  and ephemeral auth state. A Redis error during WebSocket rate limiting denies the
  action. WebSocket ticket consumption uses atomic Redis `GETDEL` or a locked local
  consume operation.
- Alembic remains the schema-change mechanism. Compose runs `alembic upgrade head`
  before starting the local backend. Runtime startup checks required table presence; it
  does not compare columns or the recorded Alembic revision and never uses `create_all`.

## Documentation reconciliation

- `README.md`: corrected the crypto/completeness claims, Celery description, default
  demo-password/debug-route claims, local migration path, and local demo instructions.
- `INSTRUCTIONS.md`: corrected the crypto and calling file paths, opt-in demo behavior,
  route gating, encrypted envelope and membership-routing contract, Redis fallback, and
  migration steps.
- `TECHNICAL_DOCUMENTATION.md`: marked its legacy examples and pointed readers to source
  and this ledger. The full architecture document still needs reconciliation in a later
  documentation pass; its startup, config, routing, and monitoring examples are not a
  reliable description of current code.
- `docs/CRYPTO.md` was inspected and is broadly consistent with the current crypto code;
  its documented metadata exposure and group-key rotation limits remain relevant.

## Validation record

Commands were run against the checked-in example configuration only. Real `.env` files
were not read, printed, or committed.

| Check | Result |
|---|---|
| `npm ci` in `frontend/` | Passed; installed from the committed lockfile (223 packages). npm reported 14 dependency advisories: 1 low, 3 moderate, 8 high, and 2 critical. No audit remediation was attempted in Phase 1. |
| `npm run build` | Passed. Vite reported that the checked-in Browserslist data is about six months old. |
| `npm test` in `frontend/` | Passed on isolated rerun: 10 files, 168 tests. One earlier concurrent run had a crypto-test timeout; the isolated full rerun passed. |
| `npm run lint` | Passed. |
| Backend dependency install | Passed into the ignored `backend/.venv/` after sandbox DNS resolution failed and the same install was approved outside the sandbox. |
| `python -m compileall -q app alembic tests` | Passed. |
| Backend import check (`import app.main`) | Passed from a temporary working directory without a `.env` file. |
| `python scripts/check_migration_matches_models.py` | Passed: the baseline matches model table/column names (8 tables, 47 columns). |
| `python -m pytest` | Passed on the final isolated run: 17 tests in 5.52 seconds. Tests use settings objects, mocks, an HTTPX ASGI transport, and no live services. Running from a temporary directory also ensured settings imports did not load a repository `.env` file. |
| `docker compose --env-file .env.example config --quiet` | Passed. Compose was given the checked-in example file explicitly. |
| CI workflow YAML parse | Passed. |
| `git diff --check` | Passed at final review. |

## Files changed

- Configuration and startup: `backend/app/core/config.py`, `backend/app/main.py`,
  `backend/app/api/auth.py`, `backend/app/services/chat.py`.
- Redis and ticket handling: `backend/app/core/runtime_state.py`,
  `backend/app/core/security.py`, `backend/app/core/rate_limiter.py`,
  `backend/app/core/ws_manager.py`.
- Schema/migration accuracy: `backend/app/core/database.py`, `backend/alembic/env.py`,
  `backend/alembic.ini`. The migration revision itself was preserved unchanged.
- Local sign-in: `frontend/src/App.tsx`, `frontend/src/components/SignIn.tsx`; the old
  embedded demo password was removed from the frontend bundle.
- Automated checks: `backend/requirements-dev.txt`, `backend/pytest.ini`,
  `backend/tests/test_phase1_baseline.py`, `.github/workflows/ci.yml`.
- Local configuration and docs: `.env.example`, `backend/.env.example`,
  `docker-compose.yml`, `README.md`, `INSTRUCTIONS.md`,
  `TECHNICAL_DOCUMENTATION.md`, and this ledger.

## Unresolved concerns and later-phase prerequisites

- The existing Alembic revision is documented in source as a clean baseline, not an
  in-place upgrade path for an older unversioned database. Before applying it to an
  existing deployment database, prepare and review a separate migration/backup plan.
- Startup checks table presence only. Column drift or a stale `alembic_version` can still
  pass startup; the offline checker compares names, not types, constraints, or indexes.
- No live PostgreSQL, Redis, or MinIO integration/deployment run was performed. Provision
  test services and validate migrations, Redis Pub/Sub, ticket operations, and storage
  credentials before a production rollout.
- Redis `GETDEL` requires Redis 6.2 or newer. The checked-in local Compose service uses
  Redis 7; production Redis version support should be confirmed.
- The WebSocket limiter's implementation uses the shared auth threshold/window for
  message, typing, and connect actions, although its method docstrings describe different
  per-action thresholds. Phase 1 changed only fail-open handling; the policy remains for
  later review.
- npm reported dependency advisories during `npm ci`. They were not investigated or
  updated because dependency upgrades were outside this baseline scope.
- `TECHNICAL_DOCUMENTATION.md` still contains extensive legacy examples and should be
  reconciled before it is used as an implementation guide.

## Phase 2 readiness

### Phase 2: Supabase Auth and Google sign-in

**Status: IMPLEMENTED; automated checks pass, external provider verification pending.**
The architecture, setup steps, migration behavior, compatibility notes, test results,
and remaining limitations are in [phase-02-auth.md](phase-02-auth.md). The backend
requires a configured Supabase project outside development; the browser exposes only
the project URL and publishable key. Existing local account data remains in place and
must be linked by proving both the legacy password and Google identity.

| Check | Result |
|---|---|
| `npm test -- --run` in `frontend/` | Passed: 11 files, 176 tests. The sandboxed run could not rename Vitest temp cache files; rerun outside the sandbox passed. |
| `npm run build` | Passed. Vite noted Browserslist data is about six months old. |
| `npm run lint` | Passed. |
| `npm audit --json` / `npm audit --omit=dev --json` | Both passed with 0 reported vulnerabilities. |
| `python -m pytest -q` in `backend/` | Passed: 40 tests in 3.95 seconds, using mocks/fakes. |
| `python -m compileall -q app alembic tests` | Passed. |
| Backend import (`import app.main`) | Passed from `backend/`. |
| `python scripts/check_migration_matches_models.py` | Passed: 8 tables, 49 columns. |
| `alembic upgrade head --sql` | Passed: offline SQL generated for both revisions; no database connection was made. |

#### Remaining Phase 2 verification and prerequisites

- No Supabase project or Google OAuth client settings were provided. The dashboard
  setup and real browser OAuth/callback/onboarding/returning-session flow have not been
  verified. Do not claim production OAuth readiness until that manual test passes.
- No live PostgreSQL migration, Redis, MinIO, production deployment, or provider-backed
  integration test was run. Apply the forward migration only after reviewing its SQL
  and the target database's current Alembic state; preserve a verified backup.
- Internal WalkerChat API tokens remain valid until expiry or explicit logout/revocation
  (60 minutes by default). Supabase session validity is checked during token exchange;
  immediate provider revocation does not invalidate an already-issued internal token.
- Browser-vault layout, legacy migration behavior, lock/sign-out semantics, recovery
  limits, validation, and later-phase prerequisites are documented in
  [phase-03-vault.md](phase-03-vault.md). Cross-device recovery remains unimplemented.

## Phase 3: browser encryption vault

**Status: IMPLEMENTED; all available automated checks passed.**
Google/Supabase account authentication remains separate from the local vault
passphrase. New vaults use an account-ID IndexedDB namespace, require a 16-character
minimum passphrase, and retain the current PBKDF2/AES-GCM primitives. A legacy vault is
copied only after its stored device ID and public identity key match the authenticated
account's device directory. Migration is idempotent and keeps the source database.
The vault now distinguishes lock from sign-out, and browser stateful crypto updates use
Web Locks across tabs. Recovery codes and cross-device key/ratchet transfer are not
implemented. See [phase-03-vault.md](phase-03-vault.md) for the full design and limits.

Phase 3 changed `frontend/src/lib/crypto/store.ts`, `session.ts`, `groups.ts`,
`frontend/src/App.tsx`, `frontend/src/components/VaultUnlock.tsx`, `Sidebar.tsx`,
`EmptyWorkspace.tsx`, and `SignIn.tsx`. Vault and UI tests changed under
`frontend/src/lib/crypto/__tests__/` and `frontend/src/components/__tests__/`; Vitest
now includes TSX tests via `frontend/vitest.config.ts` and `frontend/src/test-setup.ts`.
The handoff is `docs/implementation/phase-03-vault.md`; the Phase 2 vault paragraph
was corrected in `docs/implementation/phase-02-auth.md`.

| Check | Result |
|---|---|
| `npm test` in `frontend/` | Passed: 12 files, 189 tests. Vitest required a run outside the sandbox because of Windows temporary-cache rename permissions. |
| `npm run build` in `frontend/` | Passed. Vite warned that Browserslist data is about six months old. |
| `npm run lint` in `frontend/` | Passed. |
| `backend/.venv/Scripts/python.exe -m pytest -vv` | Passed: 40 tests in 3.94 seconds, using mocks/fakes. |
| `backend/.venv/Scripts/python.exe -m compileall -q app alembic tests` | Passed. |
| Backend import (`import app.main`) | Passed using the backend virtual environment. |
| Live PostgreSQL, Supabase/Google, Redis, object storage, production browser/deployment | Not run. |

The vault change touches no PostgreSQL/Alembic schema and does not change the backend
WebSocket/API contracts. No live database, Supabase/Google, Redis, object storage,
production browser, or deployment check was performed. Exact outcomes and recovery
limitations are recorded in the Phase 3 handoff document.

## Phase 4: contacts and multi-conversation authorization

**Status: COMPLETE; available automated checks passed. Live integration and deployment
checks remain unverified.** Username search is bounded, normalized, rate limited, and
does not return email. Contact requests can be accepted or rejected; accepted contacts
can be removed, and accounts can be blocked/unblocked. New direct chats and group members require accepted contacts, except the
explicit development Alice/Bob demo. Existing chat IDs, memberships, and history remain
intact. Backend policy enforces owner/admin group rename/member changes, blocks prevent
future direct-chat sends and direct key discovery while preserving shared-group key
discovery, and the frontend exposes contact and group
management. Existing thread-scoped message/reaction/reply clearing is retained, and
late asynchronous decryption results are discarded after a chat switch.

Phase 4's additive forward-only migration is
`backend/alembic/versions/0003_contacts_and_chat_admin.py`. It preserves existing
application relationships, backfills a unique lowercase/trimmed username key, and adds
contacts, contact requests, blocks, constraints, and a membership lookup index. Review
the conflict preflight and exact migration caveats in
[phase-04-contacts.md](phase-04-contacts.md); no live database was migrated.

| Check | Result |
|---|---|
| Frontend `npm test` | Passed: 13 files, 191 tests. Vitest ran outside the sandbox after its temp-cache atomic rename failed inside it. |
| Frontend `npm run build` | Passed. Vite warned Browserslist data is about six months old. |
| Frontend `npm run lint` | Passed. |
| `backend/.venv/Scripts/python.exe -m pytest -q` | Passed: 48 tests in 3.84 seconds, with mocks/fakes and no live services. |
| `backend/.venv/Scripts/python.exe -m compileall -q app alembic tests` | Passed. |
| `backend/.venv/Scripts/python.exe scripts/check_migration_matches_models.py` | Passed: 11 tables, 61 columns. |
| `backend/.venv/Scripts/alembic.exe upgrade head --sql` | Passed: offline SQL generated for all revisions; no database connection. |
| Live PostgreSQL, Redis, MinIO, Google OAuth, production browser or deployment | Not run. |

One full frontend run executed alongside other validation tasks timed out in the existing
`senderKey.test.ts` 5-second case. The isolated full suite passed all 191 tests; this is
recorded as a timing flake, not a crypto code change.

Phase 4 changed `backend/app/api/auth.py`, `backend/app/api/chats.py`, `backend/app/api/keys.py`,
`backend/app/api/media.py`, `backend/app/models/__init__.py`, `backend/app/models/chat.py`,
`backend/app/models/contact.py`, `backend/app/models/user.py`,
`backend/app/schemas/chat.py`, `backend/app/services/chat.py`,
`backend/app/services/chat_admin.py`, `backend/alembic/versions/0003_contacts_and_chat_admin.py`,
`backend/tests/test_phase4_contacts.py`, `frontend/src/App.tsx`,
`frontend/src/components/ChatHeader.tsx`, `frontend/src/components/GroupSettingsDialog.tsx`,
`frontend/src/components/NewChatDialog.tsx`, `frontend/src/components/ui/Avatar.tsx`,
`frontend/src/components/__tests__/contacts.test.tsx`, `frontend/src/lib/api.ts`,
`frontend/src/types/chat.ts`, `docs/implementation/phase-04-contacts.md`, and this ledger.

Production use remains blocked on a verified database backup/migration run, normalized
handle conflict review, live PostgreSQL concurrency and authorization integration
checks, shared Redis, storage, and provider/deployment verification. Group removal
requires client sender-key rotation; this is a Phase 6 prerequisite, not implemented in
Phase 4.

## Phase 5: private encrypted attachments

**Status: IMPLEMENTED; all available automated checks passed.** New uploads use the
Supabase Storage S3-compatible endpoint in staging/production and local MinIO in
development. Production settings require an explicit HTTPS project S3 endpoint, region,
server-only credentials, and bucket name; startup fails if the configured bucket is
unavailable. The app does not create Supabase buckets, publish URLs, or store filenames,
MIME, IVs, or decryption keys in plaintext server metadata. Existing media rows and
foreign keys are unchanged. New image descriptors are version 2 while old unversioned
image descriptors remain readable. Version 2 file descriptors add PDF and UTF-8 plain
text as download-only formats; Office archives remain unsupported. See
[phase-05-storage-files.md](phase-05-storage-files.md) for dashboard setup, limits,
historical object cutover, migration/rollback notes, and security limitations.

| Check | Result |
|---|---|
| Frontend `npm test -- --run` | Passed: 14 files, 199 tests. Vitest used an ignored temp directory under `frontend/node_modules` to avoid the sandbox Windows cache-rename restriction. A concurrent run timed out one existing Sender Keys test; the isolated full rerun passed. |
| Frontend `npm run build` | Passed. Vite noted Browserslist data is seven months old. |
| Frontend `npm run lint` | Passed. |
| Backend `python -m pytest -q` | Passed: 58 tests in 4.14 seconds, run from a temporary directory so repository `.env` files were not loaded. |
| Backend compile (`compileall`) | Passed for `app`, `alembic`, and `tests`. |
| Backend import (`import app.main`) | Passed from a temporary directory. |
| `scripts/check_migration_matches_models.py` | Passed: 11 tables, 61 columns; no schema changes were needed. |
| Alembic `upgrade head --sql` | Passed: offline SQL generated (6,951 bytes); no database connection was made. |
| `docker compose --env-file .env.example config --quiet` | Passed. |
| Live PostgreSQL, Redis, MinIO, Supabase Storage, historical object copy, production deployment | Not run. |

Phase 5 changes backend storage configuration/adapter and startup, bounded authorized
media routes, frontend attachment validation/encryption/serialization/decryption,
tests, local configuration examples, Compose wiring, and this implementation guide.
No Alembic migration or destructive cleanup was added. An installation with existing
MinIO media must copy ciphertext objects under the exact existing keys into the private
Supabase bucket before changing providers. The current browser reads files into memory;
the supported ceiling is 8 MiB plaintext, and server-side multipart/resumable upload is
not implemented. Keep MinIO intact until historical-object migration is verified.
