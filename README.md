# WalkerChat

WalkerChat is a realtime chat platform featuring encrypted message storage, WebRTC signaling hooks, and secure media storage scaffolding.

For the full working guide covering setup, architecture, event contracts, extension patterns, and verification, see `INSTRUCTIONS.md`.

## GitHub Push Readiness

Before your first push:

1. Copy `.env.example` to `.env` and replace the placeholder passwords.
2. If you run services directly instead of Docker, also copy `backend/.env.example` to `backend/.env` and `frontend/.env.example` to `frontend/.env.local` or `frontend/.env`.
3. Review `.gitignore` and confirm `node_modules`, local env files, logs, caches, and service data are not being committed.

## Features
- End-to-end encryption: X3DH key agreement and the Double Ratchet, implemented against the published Signal specifications
- Persistent WebSockets using Redis Pub/Sub
- Encrypted Media Uploads to MinIO (S3-compatible)
- Group chat with Sender Keys, and multi-device support
- WebRTC Peer-to-Peer AV signaling
- Background tasks scaling using Celery

## Security Status

- Message bodies are stored as ciphertext, not plaintext, and a payload that fails
  authentication is never rendered as text.
- X3DH and the Double Ratchet are implemented per the published specifications, giving
  forward secrecy and post-compromise security. See [docs/CRYPTO.md](docs/CRYPTO.md) for
  the parameters and two documented deviations.
- Private keys are sealed at rest under a password-derived key; the server only ever
  holds public key material and ciphertext.
- Signed prekeys are verified client-side before any key agreement, and identity-key
  changes surface as a safety-number warning.

- Group chat uses Sender Keys, with per-message signatures and rotation on membership
  change. Multi-device is supported: keys belong to a device, a message is encrypted once
  per recipient installation, and safety numbers cover the whole device set.

Still outstanding before this would be production-grade:

- Ratchet headers are not encrypted, so the server sees message counters. Metadata --
  who talks to whom, when, how often, and group membership -- is not protected.
- Groups have no post-compromise security: every member holds every other member's
  sender chain key until it is rotated.
- Removing someone from a group requires the remaining clients to rotate their sender
  keys. The server flags this, but rotation is not yet triggered automatically.
- The default JWT and object-storage secrets in `.env.example` are placeholders, the
  seeded demo accounts use a fixed password, and the `/test/*` debug routes are still
  mounted without authentication.

## Directory Structure
- `/backend`: FastAPI (Async), SQLAlchemy, Alembic, Celery.
- `/frontend`: React, Vite, Tailwind CSS, Zustand.

## Beginner's Guide to Docker

If you are new to Docker, follow these simple steps to get the entire project running on your local machine instantly, without needing to install PostgreSQL, Redis, or MinIO manually on your OS!

### 1. Install Docker Desktop
Make sure [Docker Desktop](https://www.docker.com/products/docker-desktop) is installed and currently running on your system. 

### 2. Startup the Services
Open your terminal in this repository folder (where `docker-compose.yml` lives), create `.env` from `.env.example`, then run:
`docker-compose up --build`
*(This command will download the necessary environments and build the containers. It might take a few minutes the first time.)*

### 3. Accessing the Apps
- **Frontend** (React): [http://localhost:5173](http://localhost:5173)
- **Backend API Docs** (Swagger): [http://localhost:8000/docs](http://localhost:8000/docs)
- **MinIO Console** (Media Storage): [http://localhost:9001](http://localhost:9001) *(Login uses the values from your `.env` file.)*

### 4. Stopping the Services
Press `Ctrl+C` in the terminal where it's running, or run:
`docker-compose down`
To wipe the DB and media data cleanly, use `docker-compose down -v`.
