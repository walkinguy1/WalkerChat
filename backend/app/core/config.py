from functools import lru_cache
from uuid import UUID

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        extra="ignore", env_file=".env", env_file_encoding="utf-8"
    )

    app_name: str = "WalkerChat API"
    debug: bool = False
    database_url: str = (
        "postgresql+asyncpg://walker:change-this-postgres-password@localhost:5432/walkerchat"
    )
    redis_url: str = "redis://localhost:6379/0"
    websocket_channel: str = "walkerchat:deliveries"
    cors_origins: list[str] = Field(
        default_factory=lambda: [
            "http://localhost:5173",
            "http://127.0.0.1:5173",
        ]
    )

    # JWT
    jwt_secret: str = "change-this-jwt-secret-in-production"
    jwt_algorithm: str = "HS256"
    jwt_expiry_minutes: int = 60
    ws_ticket_expiry_seconds: int = 45
    auth_rate_limit_attempts: int = 10
    auth_rate_limit_window_seconds: int = 60

    demo_chat_id: UUID = UUID("11111111-1111-1111-1111-111111111111")
    demo_alice_id: UUID = UUID("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa")
    demo_bob_id: UUID = UUID("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb")


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()


def reset_settings_cache() -> None:
    get_settings.cache_clear()
