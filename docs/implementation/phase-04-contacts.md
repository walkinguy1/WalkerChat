# Phase 4: contact discovery and multi-conversation authorization

Updated: 2026-10-20

## Scope and behavior

Phase 4 adds a contact graph to WalkerChat's existing FastAPI and PostgreSQL identity
model. Usernames are the discoverable handle; profile display names remain separate.
Search is a bounded, case-insensitive username prefix query (minimum two characters,
maximum 32), treats `%` and `_` literally, excludes the viewer, is rate limited, and
returns no email address. New usernames are stored lowercase with a unique normalized
key. The migration backfills that key from `lower(trim(username))` without changing
existing usernames or user IDs.

Users can send, accept, reject, and retry a previously rejected contact request; they
can remove accepted contacts and block/unblock accounts. Removing contact status alone
does not remove an existing chat membership or stop messages in an already established
conversation; use Block to stop future direct-chat activity. A request cannot target its sender, duplicate
pending requests are rejected, and database uniqueness/check constraints protect
concurrent requests and invalid self-pairs. The frontend's Find People flow exposes
requests, accepted contacts, and blocks. Only accepted contacts can be selected for new
direct chats and new group members. The development Alice/Bob direct thread remains
available under the existing opt-in development-demo setting.

Existing direct conversations and memberships are not removed or merged. When a user
starts an existing direct conversation again, the existing thread is reused. Blocking
removes an accepted-contact relation and pending requests and prevents new direct-chat
messages, typing, calls, direct-chat key discovery, and media uploads. Key discovery for
a shared group remains available so blocking does not break that group. It does not silently delete
the prior thread or its history; current chat members can still read history. Groups
remain unchanged by a direct-contact block. Removing a group member keeps the existing
history and signals that sender-key rotation is required. Phase 6 must implement and
verify group sender-key rotation before relying on removal to protect future group
messages from a former member.

Group creators are owners even for existing records whose membership role was not
backfilled. Only an owner or a membership row explicitly carrying `ADMIN` can rename a
group, add accepted contacts, or remove non-owner members. The backend enforces these
checks for every mutation; the browser hides the management action from other roles but
is not an authorization boundary. Bootstrap includes only the current user's actual
chat memberships and their public profiles, plus the existing current-user-only empty
workspace response. Membership roles are exposed to the frontend and shown in group
management. Existing opaque message envelopes, IDs, WebSocket payloads, and device/chat
foreign keys are unchanged.

Presence remains an advisory online/offline hint. It is not a delivery or read receipt.
The server continues to fan out encrypted events according to chat membership. No
WebSocket payload or status semantics were changed.

## Source entry points

- Contact, block, group mutation, and username-search endpoints: `backend/app/api/chats.py`.
- Contact request/block rules, accepted-contact checks, group-owner/admin checks, and
  direct-chat deduplication: `backend/app/services/chat_admin.py`.
- Direct-chat block enforcement for messages, typing, calls, and media uploads:
  `backend/app/services/chat.py`, `backend/app/api/media.py`, and the existing
  `backend/app/api/ws.py` call paths.
- Device-key visibility and bundle claim authorization:
  `backend/app/api/keys.py`.
- Contact tables: `backend/app/models/contact.py`; existing user handle normalization:
  `backend/app/models/user.py`.
- Forward-only migration: `backend/alembic/versions/0003_contacts_and_chat_admin.py`.
- Frontend contact requests and selection: `frontend/src/components/NewChatDialog.tsx`.
- Frontend group management: `frontend/src/components/GroupSettingsDialog.tsx` and
  `frontend/src/components/ChatHeader.tsx`.
- API adapter: `frontend/src/lib/api.ts`; chat switching/state and dialog wiring:
  `frontend/src/App.tsx`.

## Migration and compatibility

Revision `0003_contacts_and_chat_admin` follows `0002_supabase_identity`. It adds a
nullable normalized username column, backfills it, creates its unique index, adds
contact/request/block tables with foreign keys and constraints, and adds a reverse
lookup index for chat memberships. It preserves every existing `users.id`, chat,
membership, message, envelope, media row, and device key. It does not use `create_all`
or perform a downgrade. Existing direct threads do not automatically become contact
relationships.

Before a real upgrade, make a verified backup and check normalized-name conflicts with
the target database's equivalent of:

```sql
SELECT lower(trim(username)) AS normalized, count(*)
FROM users
GROUP BY lower(trim(username))
HAVING count(*) > 1;
```

Resolve any reported conflicts with a separately reviewed account-owner process before
the unique index is installed; do not merge accounts or alter IDs automatically. Review
the generated SQL with `cd backend; .venv/Scripts/alembic.exe upgrade head --sql` and
confirm the target's Alembic revision before applying the migration. A rollback is not
provided because deleting relationship data is not a safe automated action. If an
upgrade must be reversed, stop writes, restore a verified backup in a rehearsed recovery
window, or prepare a separately reviewed forward migration.

## Checks and results

| Check | Result |
|---|---|
| `backend/.venv/Scripts/python.exe -m compileall -q app alembic tests` | Passed. |
| `backend/.venv/Scripts/python.exe scripts/check_migration_matches_models.py` | Passed: 11 tables, 61 columns. |
| `backend/.venv/Scripts/alembic.exe upgrade head --sql` | Passed: offline SQL generated for all three revisions; no database connection. |
| `backend/.venv/Scripts/python.exe -m pytest -q` | Passed: 48 tests, 3.84 seconds, using mocks/fakes. |
| `npm test` (`frontend/`) | Passed: 13 files, 192 tests. Vitest needed an outside-sandbox run because Windows blocked its temporary-cache atomic rename. |
| `npm run build` (`frontend/`) | Passed. Vite reports Browserslist data is about six months old. |
| `npm run lint` (`frontend/`) | Passed. |
| Live PostgreSQL concurrency, Redis, object storage, WebRTC, Google OAuth, production browser/deployment | Not run. |

An initial full frontend run alongside other validation commands hit the existing
`senderKey.test.ts` 5-second timeout. An isolated full-suite rerun passed all 191 tests;
the timeout is recorded as a timing flake, not a crypto behavior change.

## Known limitations and next-phase prerequisites

- No live database test confirmed migration locking, unique-index build behavior, request
  concurrency, constraints, or query plans. The normalized-username unique index can
  intentionally stop the migration if old usernames collide after lowercase/trim.
- Contact-block operations and direct-message checks are separate transactions; a
  message already authorized in flight when a block commits may complete. Validate
  transaction ordering under real PostgreSQL before deployment if strict linearization
  is required.
- In-memory rate-limit/runtime fallback is for a single development process only.
  Production must use the configured shared Redis service.
- Removing a group member requires sender-key rotation on every remaining client. The
  server reports this requirement but cannot rotate a client-held Sender Key.
- Presence remains best-effort. `DELIVERED`/`READ` values in the model are not backed by
  a delivery/read acknowledgement protocol and should not be interpreted as verified
  receipts.
- No public deployment or provider/resource integration was part of Phase 4.
