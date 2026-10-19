# WalkerChat implementation status

Updated: 2026-10-19

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
| Frontend | `frontend/src/main.tsx`, `frontend/src/App.tsx`; React/Vite. Sign-in calls the existing username/password API through `frontend/src/lib/api.ts` and `frontend/src/components/SignIn.tsx`. |
| Backend | `backend/app/main.py` creates the FastAPI app and lifespan; routers live in `backend/app/api/`, models in `backend/app/models/`, and business logic in `backend/app/services/`. Endpoints are async. |
| PostgreSQL and migrations | SQLAlchemy models in `backend/app/models/`; the checked-in migration is `backend/alembic/versions/0001_e2ee_baseline.py`. `backend/alembic/env.py` takes the database URL from validated app settings. `backend/app/core/database.py` checks for missing model tables at startup. `backend/scripts/check_migration_matches_models.py` compares baseline table and column names without a database. |
| Authentication | `backend/app/api/auth.py` implements register, login, logout, and WebSocket-ticket endpoints. `backend/app/core/security.py` handles password hashing, JWTs, revocation, and ticket authentication. `backend/app/core/rate_limit.py` limits auth and prekey-claim requests. |
| WebSockets | `backend/app/api/ws.py` handles `/api/ws/chat`; `backend/app/schemas/chat.py` defines the realtime contract; `backend/app/core/ws_manager.py` tracks sockets and uses Redis Pub/Sub; `backend/app/core/runtime_state.py` stores tickets, revocations, and counters. Message routing follows chat membership. |
| Cryptography | `frontend/src/lib/crypto/` contains X3DH, XEdDSA, Double Ratchet, Sender Keys, fingerprints, and local key storage. The existing crypto and chat tests are under `frontend/src/lib/crypto/__tests__/` and `frontend/src/lib/__tests__/`. `docs/CRYPTO.md` describes protocol details and known limits. |
| Encrypted media | `frontend/src/lib/media.ts` encrypts/prepares images; `backend/app/api/media.py` checks membership and handles upload/download; `backend/app/core/storage.py` connects to MinIO/S3-compatible storage. The server stores opaque bytes and metadata. |
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

**Safe to start Phase 2 implementation.** The local workflow and baseline checks are in
place, and no Phase 2 feature was started. This is not a production-readiness claim:
production secrets, service connectivity, and the existing-database migration path still
need environment-specific review.
