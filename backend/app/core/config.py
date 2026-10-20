from functools import lru_cache
from typing import Any, Literal
from urllib.parse import unquote, urlsplit
from uuid import UUID

from pydantic import Field, ValidationError
from pydantic_settings import BaseSettings, SettingsConfigDict


_PLACEHOLDER_MARKERS = (
    "change-this",
    "changeme",
    "placeholder",
    "example",
    "development-only",
    "dev-only",
    "insecure",
    "secret",
    "password",
    "your-",
    "qwerty",
    "123456",
    "minioadmin",
    "walkerchat",
)
_URL_PLACEHOLDER_MARKERS = ("your-project", "example", "placeholder", "change-this")
_LOCAL_HOSTS = {"localhost", "127.0.0.1", "::1"}


def _contains_placeholder(value: str) -> bool:
    normalized = value.strip().lower()
    return not normalized or any(marker in normalized for marker in _PLACEHOLDER_MARKERS)


def _host_from_url(value: str) -> str | None:
    try:
        return urlsplit(value).hostname
    except ValueError:
        return None


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        extra="ignore", env_file=".env", env_file_encoding="utf-8"
    )

    app_env: Literal["development", "staging", "production"] = "development"
    app_name: str = "WalkerChat API"
    debug: bool = False
    seed_demo_accounts: bool = False
    enable_test_routes: bool = False
    demo_account_password: str | None = None

    # Browser-safe Supabase configuration. The backend validates access tokens using
    # the project's public JWKS or Auth user endpoint; no service-role key is needed.
    supabase_url: str | None = None
    supabase_publishable_key: str | None = None

    # These local service defaults are for development only. Non-development modes
    # validate that service URLs and credentials were deliberately configured.
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

    # Development-only signing key. Production and staging require a generated key.
    jwt_secret: str = "development-only-change-this-jwt-secret"
    jwt_algorithm: str = "HS256"
    jwt_expiry_minutes: int = 60
    ws_ticket_expiry_seconds: int = 45
    auth_rate_limit_attempts: int = 10
    auth_rate_limit_window_seconds: int = 60

    # Prekey bundle claims. Each claim consumes one of the target's one-time prekeys,
    # so an unlimited rate lets any authenticated user drain another user's pool.
    key_claim_rate_limit_attempts: int = 30
    key_claim_rate_limit_window_seconds: int = 60
    one_time_prekey_low_water: int = 20
    one_time_prekey_max_stored: int = 200

    # Local MinIO defaults are development-only; non-development modes reject them.
    minio_endpoint: str = "localhost:9000"
    minio_access_key: str = "minioadmin"
    minio_secret_key: str = "minioadmin"
    minio_secure: bool = False
    media_bucket: str = "walkerchat-media"
    media_max_bytes: int = 8 * 1024 * 1024
    media_rate_limit_uploads: int = 20
    media_rate_limit_window_seconds: int = 60

    # WebRTC configuration is unchanged in Phase 1.
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

    def __init__(self, **values: Any) -> None:
        # Pydantic's normal ValidationError includes raw input values, which can expose
        # secrets from environment variables. Report field names only on parse errors.
        try:
            super().__init__(**values)
        except ValidationError as exc:
            fields = sorted(
                {
                    str(error["loc"][0])
                    for error in exc.errors(include_input=False)
                    if error.get("loc")
                }
            )
            detail = ", ".join(fields) if fields else "environment settings"
            raise ValueError(f"Invalid configuration for: {detail}.") from None

        self.validate_deployment_settings()

    def validate_deployment_settings(self) -> None:
        """Reject development-only features and unsafe production configuration."""
        if self.seed_demo_accounts and self.app_env != "development":
            raise ValueError(
                "SEED_DEMO_ACCOUNTS is allowed only when APP_ENV=development."
            )
        if self.enable_test_routes and self.app_env != "development":
            raise ValueError(
                "ENABLE_TEST_ROUTES is allowed only when APP_ENV=development."
            )
        if self.seed_demo_accounts:
            demo_password = self.demo_account_password or ""
            if (
                len(demo_password) < 12
                or _contains_placeholder(demo_password)
                or len(set(demo_password)) < 6
            ):
                raise ValueError(
                    "DEMO_ACCOUNT_PASSWORD must be a unique local value of at least "
                    "12 characters when demo seeding is enabled."
                )

        if self.app_env == "development":
            return

        # Staging follows production's fail-closed configuration requirements too.
        if self.debug:
            raise ValueError("DEBUG must be false outside development.")

        if (
            len(self.jwt_secret) < 32
            or len(set(self.jwt_secret)) < 8
            or _contains_placeholder(self.jwt_secret)
        ):
            raise ValueError(
                "JWT_SECRET must be a strong, non-placeholder value of at least "
                "32 characters outside development."
            )

        if not self.supabase_url or not self.supabase_publishable_key:
            raise ValueError(
                "SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY are required outside development."
            )
        supabase_parts = urlsplit(self.supabase_url)
        if (
            supabase_parts.scheme != "https"
            or not supabase_parts.netloc
            or supabase_parts.path not in {"", "/"}
            or supabase_parts.query
            or supabase_parts.fragment
            or any(
                marker in self.supabase_url.lower()
                for marker in _URL_PLACEHOLDER_MARKERS
            )
            or _contains_placeholder(self.supabase_publishable_key)
        ):
            raise ValueError(
                "SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY must be explicitly configured outside development."
            )

        database_host = _host_from_url(self.database_url)
        database_parts = urlsplit(self.database_url)
        database_password = unquote(database_parts.password or "")
        if (
            not database_host
            or database_host.lower() in _LOCAL_HOSTS
            or len(database_password) < 16
            or len(set(database_password)) < 8
            or _contains_placeholder(database_password)
        ):
            raise ValueError(
                "DATABASE_URL must name a non-local database and use a "
                "non-placeholder password outside development."
            )

        redis_parts = urlsplit(self.redis_url)
        redis_host = redis_parts.hostname
        redis_password = unquote(redis_parts.password or "")
        if (
            redis_parts.scheme not in {"redis", "rediss"}
            or not redis_host
            or redis_host.lower() in _LOCAL_HOSTS
            or (redis_password and _contains_placeholder(redis_password))
        ):
            raise ValueError(
                "REDIS_URL must name an explicitly configured non-local Redis "
                "service outside development."
            )

        storage_host = _host_from_url(f"//{self.minio_endpoint}")
        if (
            not storage_host
            or "://" in self.minio_endpoint
            or storage_host.lower() in _LOCAL_HOSTS
            or not self.minio_access_key
            or _contains_placeholder(self.minio_access_key)
            or len(self.minio_secret_key) < 16
            or len(set(self.minio_secret_key)) < 8
            or _contains_placeholder(self.minio_secret_key)
            or not self.minio_secure
        ):
            raise ValueError(
                "MINIO_ENDPOINT, MINIO_ACCESS_KEY, MINIO_SECRET_KEY, and "
                "MINIO_SECURE must be explicitly configured for non-development "
                "use."
            )

        if not self.cors_origins:
            raise ValueError("CORS_ORIGINS must be explicitly configured.")
        for origin in self.cors_origins:
            parts = urlsplit(origin)
            host = (parts.hostname or "").lower()
            if (
                parts.scheme != "https"
                or not parts.netloc
                or "*" in origin
                or host in _LOCAL_HOSTS
                or parts.path not in {"", "/"}
                or parts.query
                or parts.fragment
            ):
                raise ValueError(
                    "CORS_ORIGINS must contain explicit HTTPS application origins "
                    "outside development."
                )


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()


def reset_settings_cache() -> None:
    get_settings.cache_clear()
