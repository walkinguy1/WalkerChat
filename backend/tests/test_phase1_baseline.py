import asyncio
from unittest.mock import AsyncMock
from uuid import uuid4

import pytest
from fastapi import HTTPException
from httpx import ASGITransport, AsyncClient
from redis.exceptions import ConnectionError as RedisConnectionError

from app.core.config import Settings
from app.services import chat as chat_service
from app.services.chat import (
    ensure_chat_delivery_allowed,
    ensure_directed_delivery_allowed,
    seed_demo_data,
)


def production_settings(**overrides: object) -> Settings:
    values: dict[str, object] = {
        "_env_file": None,
        "app_env": "production",
        "jwt_secret": "aB3!dE5@fG7#hJ9$kL2%mN4^pQ6&sT8*",
        "database_url": (
            "postgresql+asyncpg://appuser:DatabasePass-2026-Strong@"
            "postgres.db.internal:5432/walkerchat"
        ),
        "redis_url": "rediss://redis.internal:6379/0",
        "cors_origins": ["https://chat.example.com"],
        "minio_endpoint": "storage.internal:9000",
        "minio_access_key": "minio-live-access-8",
        "minio_secret_key": "A7!cD9@fG2#hJ5$k",
        "minio_secure": True,
    }
    values.update(overrides)
    return Settings(**values)


def test_non_development_rejects_default_jwt_and_services_without_leaking_values() -> None:
    with pytest.raises(ValueError) as error:
        Settings(_env_file=None, app_env="production")

    message = str(error.value)
    assert "JWT_SECRET" in message
    assert "development-only-change-this-jwt-secret" not in message


@pytest.mark.parametrize(
    ("app_env", "feature"),
    [
        ("staging", {"seed_demo_accounts": True}),
        ("production", {"enable_test_routes": True}),
        ("production", {"debug": True}),
    ],
)
def test_non_development_rejects_demo_routes_seeding_and_debug(
    app_env: str, feature: dict[str, bool]
) -> None:
    with pytest.raises(ValueError):
        Settings(_env_file=None, app_env=app_env, **feature)


def test_non_development_requires_non_local_services_and_explicit_https_cors() -> None:
    with pytest.raises(ValueError, match="DATABASE_URL"):
        production_settings(
            database_url=(
                "postgresql+asyncpg://appuser:DatabasePass-2026-Strong@"
                "localhost:5432/walkerchat"
            )
        )

    with pytest.raises(ValueError, match="CORS_ORIGINS"):
        production_settings(cors_origins=["http://localhost:5173"])

    with pytest.raises(ValueError, match="CORS_ORIGINS"):
        production_settings(cors_origins=["https://*.example.com"])

    with pytest.raises(ValueError, match="REDIS_URL"):
        production_settings(redis_url="redis://localhost:6379/0")

    with pytest.raises(ValueError, match="MINIO_ENDPOINT"):
        production_settings(minio_secret_key="change-this-minio-password")


def test_production_settings_accept_explicit_service_origins_and_credentials() -> None:
    settings = production_settings()
    assert settings.app_env == "production"
    assert settings.cors_origins == ["https://chat.example.com"]


def test_settings_parse_errors_do_not_echo_supplied_values() -> None:
    with pytest.raises(ValueError) as error:
        Settings(_env_file=None, cors_origins="sensitive-config-value")  # type: ignore[arg-type]

    assert "cors_origins" in str(error.value)
    assert "sensitive-config-value" not in str(error.value)


def test_test_routes_are_unmounted_by_default_and_only_opt_in_in_development() -> None:
    from app.main import create_app

    default_app = create_app(Settings(_env_file=None))
    default_paths = default_app.openapi()["paths"]
    assert "/test/redis" not in default_paths
    assert default_paths["/api/bootstrap"]["get"]["security"]

    development_app = create_app(
        Settings(_env_file=None, enable_test_routes=True)
    )
    development_paths = development_app.openapi()["paths"]
    assert "/test/redis" in development_paths

    production_app = create_app(production_settings())
    assert "/test/redis" not in production_app.openapi()["paths"]


async def test_root_endpoint_uses_httpx_without_external_services() -> None:
    from app.main import create_app

    app = create_app(Settings(_env_file=None))
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        response = await client.get("/")
    assert response.status_code == 200
    assert response.json() == {"message": "WalkerChat Backend is Running"}


async def test_demo_seeding_is_guarded_inside_the_seeder(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        chat_service,
        "settings",
        production_settings(app_env="staging"),
    )
    session = AsyncMock()

    with pytest.raises(RuntimeError, match="Demo seeding requires"):
        await seed_demo_data(session)

    session.execute.assert_not_awaited()
    session.commit.assert_not_awaited()


def test_demo_seeding_requires_an_explicit_non_default_password() -> None:
    with pytest.raises(ValueError, match="DEMO_ACCOUNT_PASSWORD"):
        Settings(_env_file=None, seed_demo_accounts=True)

    with pytest.raises(ValueError, match="DEMO_ACCOUNT_PASSWORD"):
        Settings(
            _env_file=None,
            seed_demo_accounts=True,
            demo_account_password="walkerchat123",
        )


async def test_password_hashing_and_access_token_basics(monkeypatch: pytest.MonkeyPatch) -> None:
    from app.core import security

    password = "unit-test-password-only"
    hashed = security.hash_password(password)
    assert hashed != password
    assert security.verify_password(password, hashed)
    assert not security.verify_password("wrong-password", hashed)

    user_id = uuid4()
    token = security.create_access_token(user_id)
    payload = security._decode_token_payload(token)
    assert payload["sub"] == str(user_id)
    assert payload["jti"]

    monkeypatch.setattr(
        security, "get_ephemeral_value", AsyncMock(return_value=None)
    )
    assert await security._decode_access_token(token) == user_id

    with pytest.raises(HTTPException) as error:
        security._decode_token_payload("not-a-token")
    assert error.value.status_code == 401


async def test_websocket_ticket_is_single_use(monkeypatch: pytest.MonkeyPatch) -> None:
    from app.core import runtime_state, security

    monkeypatch.setattr(runtime_state, "get_runtime_redis", AsyncMock(return_value=None))
    user_id = uuid4()
    ticket = await security.create_ws_ticket(user_id)

    assert await security.consume_ws_ticket(ticket) == user_id
    with pytest.raises(HTTPException) as error:
        await security.consume_ws_ticket(ticket)
    assert error.value.status_code == 401


async def test_websocket_rate_limiter_denies_when_redis_errors() -> None:
    from app.core.rate_limiter import RedisRateLimiter

    redis = AsyncMock()
    redis.zremrangebyscore.side_effect = RedisConnectionError("unavailable")
    assert not await RedisRateLimiter(redis).is_allowed("ws:messages:test")


async def test_runtime_redis_fallback_is_development_only(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from app.core import runtime_state

    client = AsyncMock()
    client.ping.side_effect = RedisConnectionError("unavailable")
    monkeypatch.setattr(runtime_state, "_redis_client", None)
    monkeypatch.setattr(runtime_state.Redis, "from_url", lambda *args, **kwargs: client)
    monkeypatch.setattr(runtime_state, "settings", Settings(_env_file=None))

    assert await runtime_state.get_runtime_redis() is None

    monkeypatch.setattr(runtime_state, "_redis_lock", asyncio.Lock())
    monkeypatch.setattr(runtime_state, "settings", production_settings())
    with pytest.raises(RuntimeError, match="Redis is required outside development"):
        await runtime_state.get_runtime_redis()


async def test_chat_membership_remains_the_message_authorization_rule() -> None:
    chat_id, sender_id = uuid4(), uuid4()
    session = AsyncMock()
    session.scalar.return_value = None

    with pytest.raises(PermissionError, match="Sender is not a member"):
        await ensure_chat_delivery_allowed(
            session, chat_id=chat_id, sender_id=sender_id
        )


async def test_directed_delivery_requires_both_chat_members() -> None:
    chat_id, sender_id, target_id = uuid4(), uuid4(), uuid4()
    session = AsyncMock()
    session.scalar.side_effect = [sender_id, None]

    with pytest.raises(PermissionError, match="Target user is not a member"):
        await ensure_directed_delivery_allowed(
            session,
            chat_id=chat_id,
            sender_id=sender_id,
            target_id=target_id,
        )
    assert session.scalar.await_count == 2
