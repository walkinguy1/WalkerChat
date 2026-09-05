from collections.abc import AsyncIterator

from sqlalchemy import inspect
from sqlalchemy.ext.asyncio import (
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from app.core.config import get_settings
from app.models import Base

settings = get_settings()

engine = create_async_engine(settings.database_url, future=True)
SessionLocal = async_sessionmaker(engine, expire_on_commit=False, class_=AsyncSession)


async def get_db() -> AsyncIterator[AsyncSession]:
    async with SessionLocal() as session:
        yield session


async def verify_database_schema() -> None:
    """
    Confirm the database has been migrated, rather than creating tables on boot.

    This used to call ``Base.metadata.create_all``, which silently bypassed Alembic --
    the migrations drifted out of sync with the models for a long time without anyone
    noticing, because nothing ever ran them. Failing loudly here means schema problems
    surface at startup instead of as a 500 on the first request that touches a missing
    column.

    Run ``alembic upgrade head`` before starting the app.
    """
    async with engine.begin() as connection:
        tables = await connection.run_sync(
            lambda sync_connection: inspect(sync_connection).get_table_names()
        )

    missing = sorted(set(Base.metadata.tables) - set(tables))
    if missing:
        raise RuntimeError(
            "Database schema is not up to date; missing tables: "
            + ", ".join(missing)
            + ". Run 'alembic upgrade head'."
        )
