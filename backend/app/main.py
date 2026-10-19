from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.core.logging_config import setup_logging
from app.core.exceptions import setup_exception_handlers

from app.api.auth import router as auth_router
from app.api.bootstrap import router as bootstrap_router
from app.api.chats import router as chat_router
from app.api.health import router as health_router
from app.api.keys import router as keys_router
from app.api.media import router as media_router
from app.api.ws import router as ws_router
from app.api.webrtc import router as webrtc_router
from app.core.config import Settings, get_settings
from app.core.database import SessionLocal, verify_database_schema
from app.core.runtime_state import close_runtime_redis
from app.core.storage import ensure_media_bucket
from app.core.ws_manager import manager
from app.services.chat import seed_demo_data

# Initialize logging
setup_logging()


def create_app(config: Settings | None = None) -> FastAPI:
    app_settings = config or get_settings()

    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        await verify_database_schema()

        if app_settings.seed_demo_accounts:
            async with SessionLocal() as session:
                await seed_demo_data(session, app_settings)

        # Non-fatal: chat still works without object storage, only photos break.
        await ensure_media_bucket()

        await manager.startup()
        try:
            yield
        finally:
            await manager.shutdown()
            await close_runtime_redis()

    application = FastAPI(
        title=app_settings.app_name,
        debug=app_settings.debug,
        lifespan=lifespan,
    )

    setup_exception_handlers(application)
    application.add_middleware(
        CORSMiddleware,
        allow_origins=app_settings.cors_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    application.include_router(auth_router)
    application.include_router(bootstrap_router)
    application.include_router(chat_router)
    application.include_router(health_router)
    application.include_router(keys_router)
    application.include_router(media_router)
    application.include_router(ws_router, prefix="/api/ws", tags=["websocket"])
    application.include_router(webrtc_router, prefix="/api/webrtc", tags=["webrtc"])

    # Import and register debug endpoints only when an explicit development-only
    # switch is enabled. Non-development configurations reject that switch itself.
    if app_settings.app_env == "development" and app_settings.enable_test_routes:
        from app.api.test import router as test_router

        application.include_router(test_router)

    @application.get("/")
    async def root() -> dict[str, str]:
        return {"message": "WalkerChat Backend is Running"}

    return application


app = create_app()
