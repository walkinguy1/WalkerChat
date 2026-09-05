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

    # Prekey bundle claims. Each claim consumes one of the target's one-time prekeys,
    # so an unlimited rate lets any authenticated user drain another user's pool.
    key_claim_rate_limit_attempts: int = 30
    key_claim_rate_limit_window_seconds: int = 60
    # Clients top up when their published count drops below this.
    one_time_prekey_low_water: int = 20
    one_time_prekey_max_stored: int = 200

    # Encrypted media storage (MinIO / S3-compatible)
    minio_endpoint: str = "localhost:9000"
    minio_access_key: str = "minioadmin"
    minio_secret_key: str = "minioadmin"
    minio_secure: bool = False
    media_bucket: str = "walkerchat-media"
    media_max_bytes: int = 8 * 1024 * 1024
    media_rate_limit_uploads: int = 20
    media_rate_limit_window_seconds: int = 60

    # WebRTC
    webrtc_stun_urls: list[str] = Field(
        default_factory=lambda: [
            "stun:stun.l.google.com:19302",
            "stun:stun1.l.google.com:19302",
        ]
    )
    webrtc_turn_url: str = ""
    webrtc_turn_username: str = ""
    webrtc_turn_credential: str = ""

    demo_chat_id: UUID = UUID("11111111-1111-1111-1111-111111111111")
    demo_alice_id: UUID = UUID("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa")
    demo_bob_id: UUID = UUID("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb")


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()


def reset_settings_cache() -> None:
    get_settings.cache_clear()
