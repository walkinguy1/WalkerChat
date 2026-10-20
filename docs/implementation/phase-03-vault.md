# Phase 3: browser encryption vault

## Current vault layout

`CryptoStore` uses IndexedDB schema version 4. The stores are `meta`, `identity`,
`signedPreKeys`, `oneTimePreKeys`, `sessions`, `peers`, `outgoing`, and `senderKeys`.
Private identity and prekey material, ratchet state, sender-key state, and locally
retained outgoing plaintext are wrapped with AES-GCM before writing. Each wrap uses a
fresh random 12-byte IV. The current storage format uses empty AES-GCM additional
authenticated data; version changes must not silently reinterpret this format.

The metadata store contains a random 16-byte salt, PBKDF2-HMAC-SHA-256 iteration count
(600,000 for new vaults), version markers, and a sealed verifier. The passphrase is
never persisted. New vaults require at least 16 characters. Existing vaults continue
to derive their keys with their saved iteration count and can be unlocked with their
original passphrase; this phase does not silently change that passphrase. The KDF and
AES-GCM implementation use the existing WebCrypto primitives.

Public identity/prekey data, peer public identity records and trust metadata, device
UUID, and session lookup metadata remain readable in IndexedDB. The stable device UUID
is stored with the vault metadata; it is distinct from the account ID. Server-side
device rows contain public identity keys and prekeys. The IndexedDB database is scoped
to the immutable WalkerChat user ID (`walkerchat-vault-v2-<encoded user id>`), so
different accounts do not share the new namespace. Each browser profile has separate
IndexedDB storage and creates its own device UUID and key material.

## Upgrade and legacy migration

Before Phase 3, the database name was `walkerchat-crypto-${username || user_id}`. Phase
3 checks the old name only when the new account-scoped database has no vault. It asks
for the old local vault passphrase, loads the old public identity and stored device ID,
and requires an exact device-ID and public-identity match in the authenticated
account's FastAPI device directory. It does not use email to identify the vault and
does not assume the user's WalkerChat or Google password is the vault passphrase.

Once verified, all existing stores are copied into the account namespace in one
IndexedDB read/write transaction. The destination gets an owner binding and a
versioned migration marker. The copied verifier and each sealed record are reopened
and authenticated before the UI uses the destination. A failed copy or verification
does not clear, overwrite, or delete the old database. The source is not modified by
the copy path. A prior completed migration is verified and reused; an invalid prior
copy is replaced from the still-authenticated source in another atomic transaction.
Starting a fresh device vault leaves any unmatched legacy database untouched.

The verifier has explicit vault, KDF, and record format versions. On a successful
unlock, the old verifier format is upgraded without changing the KDF or re-encrypting
the existing key/session records. If the page closes before this short metadata
transaction completes, the old verifier remains valid and the next unlock retries the
upgrade. Unsupported version or malformed KDF metadata fails closed. One-time prekey
claim now removes the record in the same IndexedDB read/write transaction that reads
it, so only one tab can consume it.

## First use, unlock, lock, and sign-out

- First use asks the user to create and confirm a separate local vault passphrase. It is
  not derived from Google credentials and is never sent to FastAPI or Supabase.
- Returning sign-in restores the Supabase session, exchanges it for the existing
  WalkerChat API token, then prompts for the local vault passphrase.
- Wrong passphrases and damaged sealed records fail without clearing local data.
- **Lock vault** closes the unlocked crypto store, wipes its derived key and
  `SessionManager`'s in-memory identity private-key buffer best-effort, and clears app
  message/search/session references while retaining the authenticated account session.
- **Sign out** revokes the WalkerChat token when possible, signs out Supabase, clears
  the same in-memory state and leaves encrypted IndexedDB data in place.
- Account switching closes the old managers and database handles before opening the
  account-scoped vault. Abandoned onboarding can be signed out of without creating a
  vault. A browser restart restores the account session and asks for vault unlock
  again. A new browser/device creates an independent device identity.

JavaScript memory wiping is best-effort and is not guaranteed secure erasure. Existing
image object URL cleanup remains tied to component lifecycle; lock/sign-out also closes
the active lightbox. The local search index and rendered plaintext lists are cleared.

## Recovery and security limits

This phase intentionally does not add a recovery code or server-side key escrow. The
current data key is derived directly from the local passphrase; safely adding another
unlock method requires a separately versioned random master-key envelope and migration
design. A code alone also cannot restore missing IndexedDB contents or the device's
ratchet state. If the local database or passphrase is lost, this browser's private
identity and conversation state may be unrecoverable. Password reset does not recover
E2EE keys.

The browser vault does not protect secrets from XSS, malicious browser extensions,
browser debugging tools, or theft while the vault is unlocked. A stolen profile while
locked still exposes public identities, peer metadata, database structure, and
ciphertext for offline passphrase guessing. Server-visible metadata includes account,
chat membership, message timing/routing and device public keys. A replacement device
must establish and verify a new identity; this phase does not copy old ratchets across
devices or claim that a new device is the old one.

Cross-tab ratchet, group-key, and identity-bootstrap mutations use the browser Web
Locks API. If unavailable, those operations fail closed with a browser requirement
message; use a supported browser over localhost or HTTPS. This only coordinates tabs
in one browser profile, not distinct devices.

## Automated validation

The implementation entry points are `frontend/src/lib/crypto/store.ts` (account
namespace, KDF/verifier versions, copy verification and atomic prekey consumption),
`session.ts` and `groups.ts` (shared-tab locks and session-key cleanup), and
`frontend/src/App.tsx` plus `frontend/src/components/VaultUnlock.tsx`, `Sidebar.tsx`,
`EmptyWorkspace.tsx`, and `SignIn.tsx` (migration and lock/sign-out experience). Focused
tests live in `frontend/src/lib/crypto/__tests__/store.test.ts`, `session.test.ts`,
`groups.test.ts`, and `frontend/src/components/__tests__/auth-flows.test.tsx`.

The frontend tests exercise crypto primitives/protocols, local persistence, wrong and
corrupted verifier handling, account namespace ownership, legacy verifier upgrade and
restart, migration idempotence/source preservation, atomic one-time prekey consumption,
session persistence across reloads, and the passphrase/lock/sign-out/empty-workspace UI.
The Web Locks test shim is in-process only; production code still requires the browser
API.

| Command | Result |
|---|---|
| `npm test` (`frontend/`) | Passed: 12 files, 189 tests. Vitest needed a rerun outside the sandbox because Windows denied temporary cache renames. |
| `npm run build` (`frontend/`) | Passed; Vite warned that Browserslist data is about six months old. |
| `npm run lint` (`frontend/`) | Passed. |
| `backend/.venv/Scripts/python.exe -m pytest -vv` | Passed: 40 tests in 3.94 seconds, using mocks/fakes. |
| `python -m compileall -q app alembic tests` (`backend/`) | Passed. |
| Backend import (`import app.main`) | Passed using the backend virtual environment. |

No live database, Supabase, Google OAuth, Redis, object-storage, production browser, or
deployment check is part of these vault unit tests.

## Next-phase prerequisites

Before designing any recovery envelope, specify the random master-key format, key
wrapping and derivation parameters, versioned associated data, authentication-failure
behavior, and forward-only migration procedure. Test interruption and source
preservation with disposable IndexedDB fixtures. Do not add cross-device identity or
ratchet copying without a protocol-supported device-link flow and user-visible safety
verification.
