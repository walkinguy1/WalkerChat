from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.bootstrap import router as bootstrap_router
from app.api.chats import router as chat_router
from app.api.ws import router as ws_router
from app.core.config import get_settings
from app.core.database import SessionLocal, init_database
from app.core.ws_manager import manager
from app.services.chat import seed_demo_data

settings = get_settings()


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    await init_database()

    async with SessionLocal() as session:
        await seed_demo_data(session)

    await manager.startup()
    try:
        yield
    finally:
        await manager.shutdown()


app = FastAPI(title=settings.app_name, lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(bootstrap_router)
app.include_router(chat_router)
app.include_router(ws_router, prefix="/api/ws", tags=["websocket"])


@app.get("/")
async def root() -> dict[str, str]:
    return {"message": "WalkerChat Backend is Running"}
