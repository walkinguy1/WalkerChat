# WalkerChat

WalkerChat is a scalable E2EE (End-to-End Encrypted) communication platform featuring messaging, WebRTC calling capabilities, and secure media storage.

For the full working guide covering setup, architecture, event contracts, extension patterns, and verification, see `INSTRUCTIONS.md`.

## GitHub Push Readiness

Before your first push:

1. Copy `.env.example` to `.env` and replace the placeholder passwords.
2. If you run services directly instead of Docker, also copy `backend/.env.example` to `backend/.env` and `frontend/.env.example` to `frontend/.env.local` or `frontend/.env`.
3. Review `.gitignore` and confirm `node_modules`, local env files, logs, caches, and service data are not being committed.

## Features
- Signal Protocol E2EE (X3DH & Double Ratchet) 
- Persistent WebSockets using Redis Pub/Sub
- Encrypted Media Uploads to MinIO (S3-compatible)
- WebRTC Peer-to-Peer AV signaling
- Background tasks scaling using Celery

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
