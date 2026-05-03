# WalkerChat Instructions

This file is the working guide for building, running, extending, and reviewing WalkerChat.

## 1. What This Project Is

WalkerChat is a secure chat platform with:

- FastAPI backend using asynchronous endpoints only
- React + Vite frontend
- PostgreSQL for encrypted message persistence
- Redis Pub/Sub for cross-instance WebSocket delivery
- WebSockets for realtime chat and signaling
- WebRTC reserved for voice/video signaling
- E2EE direction based on Signal Protocol concepts, but not yet a full Signal implementation

## 2. Current State

The app currently includes:

- Demo bootstrap endpoint that returns seeded users and chats
- Realtime encrypted chat message delivery
- Encrypted payload persistence in PostgreSQL
- Demo identity switching in the UI
- Presence updates on connect/disconnect
- Typing indicators over WebSockets
- Redis-backed fanout for horizontal scaling

Important:

- Messages are stored as ciphertext only
- The current frontend crypto is an experimental demo path, not a full Signal implementation yet
- The backend contract is shaped so a real Signal layer can replace the demo encryption later
- Do not describe the current build as having production-ready Signal Protocol E2EE

## 3. Project Rules

These must stay true:

- All API endpoints must be async
- Use Pydantic v2 models for validation
- Use WebSockets for messaging
- Use WebRTC signaling for calls
- Do not store plain-text messages in the database
- Design realtime delivery so multiple backend instances can work together through Redis

## 4. Repository Layout

- `backend/app/main.py`
  App startup, lifespan, router registration, DB init
- `backend/app/api/bootstrap.py`
  Bootstrap API for demo users and chats
- `backend/app/api/chats.py`
  Chat history API
- `backend/app/api/ws.py`
  WebSocket chat endpoint and realtime event handling
- `backend/app/core/config.py`
  Central settings
- `backend/app/core/database.py`
  Async SQLAlchemy engine and sessions
- `backend/app/core/ws_manager.py`
  Connection tracking and Redis Pub/Sub fanout
- `backend/app/services/chat.py`
  Chat business logic, seeding, presence, persistence
- `backend/app/schemas/chat.py`
  Pydantic v2 request/response/event schemas
- `frontend/src/App.tsx`
  Main UI shell and realtime client flow
- `frontend/src/hooks/useWebSocket.ts`
  Reconnecting WebSocket hook
- `frontend/src/lib/api.ts`
  Frontend fetch helpers
- `frontend/src/lib/chat.ts`
  Chat view-model mapping helpers
- `frontend/src/lib/crypto.ts`
  Demo encrypted envelope logic
- `frontend/src/types/chat.ts`
  Shared frontend types for bootstrap/history/realtime events

## 5. How To Run The App

### Docker path

1. Start Docker Desktop.
2. Copy `.env.example` to `.env` and replace placeholder passwords.
3. From repo root run:

```powershell
docker-compose up --build
```

4. Open:

- Frontend: `http://localhost:5173`
- Backend docs: `http://localhost:8000/docs`
- MinIO console: `http://localhost:9001`

### Local backend path

1. Create a Python environment.
2. Install `backend/requirements.txt`.
3. Copy `backend/.env.example` to `backend/.env` or export the variables manually.
4. Ensure PostgreSQL and Redis are running.
5. Set:

- `DATABASE_URL`
- `REDIS_URL`
- `MINIO_ENDPOINT`
- `MINIO_ACCESS_KEY`
- `MINIO_SECRET_KEY`

6. Start:

```powershell
uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload
```

### Local frontend path

1. Install dependencies in `frontend`.
2. Copy `frontend/.env.example` to `frontend/.env.local` or `frontend/.env`.
3. Set:

- `VITE_API_URL`
- `VITE_WS_URL`

4. Start:

```powershell
npm run dev -- --host 0.0.0.0
```

## 6. Seeded Demo Identities

The backend seeds:

- Alice Walker
- Bob Stone
- One direct chat: `Engineering Sync`

The frontend uses `/api/bootstrap` to discover them. Do not hardcode identities in new features if the API can provide them.

## 7. Realtime Event Contract

Current WebSocket event types:

- `chat_message`
- `typing`
- `webrtc_offer`
- `webrtc_answer`
- `webrtc_ice`
- `presence` (server-published)
- `error` (server to client)

### Chat message requirements

- Must include `chat_id`
- Must include `sender_id`
- Must include `target_id`
- Must include `ciphertext`
- Must include encryption metadata

### Typing event requirements

- Must include `chat_id`
- Must include `sender_id`
- Must include `target_id`
- Must include `is_typing`

## 8. Message Flow

### Outbound chat message

1. Frontend creates an encrypted envelope.
2. Frontend sends a `chat_message` event over WebSocket.
3. Backend validates the payload with Pydantic v2.
4. Backend verifies both sender and target belong to the chat.
5. Backend stores only the encrypted payload in PostgreSQL.
6. Backend publishes the event through Redis Pub/Sub.
7. Active WebSocket sessions receive the event.

### Presence flow

1. User socket connects.
2. Backend registers the connection.
3. If this is the first active socket for that user, the backend publishes `online`.
4. When the last socket disconnects, the backend publishes `offline`.

### Typing flow

1. Frontend emits `typing`.
2. Backend validates membership.
3. Backend republishes the typing signal to the target user.

## 9. How To Add Features Correctly

### Add a new REST endpoint

1. Add a schema in `backend/app/schemas`.
2. Add business logic in `backend/app/services`.
3. Add an async route in `backend/app/api`.
4. Register the router in `backend/app/main.py`.
5. Keep the route async and typed.

### Add a new realtime event

1. Add a Pydantic schema in `backend/app/schemas/chat.py`.
2. Add it to the discriminated union.
3. Validate it in `backend/app/api/ws.py`.
4. Update routing behavior in `backend/app/core/ws_manager.py` if recipient rules differ.
5. Add matching TypeScript types in `frontend/src/types/chat.ts`.
6. Handle it in `frontend/src/App.tsx` or a dedicated hook/store.

### Add a DB-backed feature

1. Update the SQLAlchemy model.
2. Update Alembic migration files.
3. Add service-layer logic for reads/writes.
4. Expose typed API or WebSocket contracts.
5. Update frontend types and UI.

## 10. How To Replace Demo Crypto With Real Signal Logic

Current state:

- `frontend/src/lib/crypto.ts` produces demo ciphertext envelopes

Migration direction:

1. Introduce identity keys, signed prekeys, one-time prekeys, and sessions.
2. Add backend APIs for bundle publication and retrieval.
3. Perform X3DH session establishment on the client.
4. Replace demo envelope generation with Double Ratchet message encryption.
5. Keep only ciphertext and public key material on the server.
6. Do not move plaintext handling into backend services.

## 11. How To Add Calling

For calls:

1. Keep media peer-to-peer with WebRTC.
2. Use WebSockets only for signaling.
3. Add new signaling payload schemas if needed.
4. Keep ICE, offer, and answer messages typed and validated.

## 12. Verification Checklist

Before considering a change complete:

1. Frontend type-check passes.
2. Frontend lint passes.
3. Backend code compiles/imports.
4. New async endpoints are typed.
5. No plaintext message bodies are stored.
6. Redis-backed fanout behavior still works.

Useful commands:

```powershell
cd frontend
node_modules\.bin\tsc.cmd -b
node_modules\.bin\eslint.cmd src
```

Backend syntax check with bundled runtime:

```powershell
& "C:\Users\Acer\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe" -m compileall backend\app
```

## 13. Known Limitations

- Signal Protocol is not fully implemented yet
- Demo data is intentionally seeded for development
- The current UI is single-thread demo oriented
- Media upload flow exists as scaffolding only
- Background worker logic is still minimal

## 14. Recommended Next Steps

Best next upgrades:

1. Real Signal Protocol key bundle APIs and ratchet state
2. Auth and per-user session identity
3. Group chat membership management
4. Delivery/read receipts persisted in DB
5. WebRTC calling UI and signaling polish
6. Media message encryption and MinIO integration
