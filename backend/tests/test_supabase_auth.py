import base64
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from unittest.mock import AsyncMock
from uuid import uuid4

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import ec
from fastapi import HTTPException
from fastapi.security import HTTPAuthorizationCredentials
from sqlalchemy.exc import IntegrityError

from app.core.config import Settings
from app.core import supabase_auth
from app.core.security import hash_password
from app.models.user import User

def auth_settings() -> Settings:
    return Settings(
        _env_file=None,
        supabase_url="https://phase2-test.supabase.co",
        supabase_publishable_key="sb_publishable_phase2_unit_test_key",
    )


def auth_token(
    private_key: ec.EllipticCurvePrivateKey,
    *,
    sub: str = "00000000-0000-0000-0000-000000000001",
    issuer: str = "https://phase2-test.supabase.co/auth/v1",
    audience: str = "authenticated",
    expires: datetime | None = None,
) -> str:
    now = datetime.now(UTC)
    return jwt.encode(
        {
            "sub": sub,
            "iss": issuer,
            "aud": audience,
            "iat": now,
            "exp": expires or now + timedelta(minutes=5),
        },
        private_key,
        algorithm="ES256",
        headers={"kid": "test-key"},
    )


def public_jwk(private_key: ec.EllipticCurvePrivateKey) -> dict[str, str]:
    numbers = private_key.public_key().public_numbers()
    encode = lambda value: base64.urlsafe_b64encode(value.to_bytes(32, "big")).rstrip(b"=").decode()
    return {"kty": "EC", "crv": "P-256", "x": encode(numbers.x), "y": encode(numbers.y)}


@pytest.fixture
def signing_key() -> ec.EllipticCurvePrivateKey:
    return ec.derive_private_key(987654321, ec.SECP256R1())


@pytest.fixture(autouse=True)
def configured_auth(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(supabase_auth, "get_settings", auth_settings)


def fake_user_for(subject: str) -> dict[str, object]:
    return {"id": subject, "app_metadata": {"provider": "google", "providers": ["google"]}}


async def verify_with_key(
    monkeypatch: pytest.MonkeyPatch,
    signing_key: ec.EllipticCurvePrivateKey,
    token: str,
) -> supabase_auth.SupabaseIdentity:
    jwk = public_jwk(signing_key)
    jwk.update({"kid": "test-key", "alg": "ES256"})
    monkeypatch.setattr(supabase_auth, "_load_jwks", AsyncMock(return_value={"test-key": jwk}))
    monkeypatch.setattr(
        supabase_auth,
        "_get_auth_user",
        AsyncMock(
            side_effect=lambda _token: fake_user_for(
                jwt.decode(_token, options={"verify_signature": False})["sub"]
            )
        ),
    )
    return await supabase_auth.verify_supabase_access_token(token)


async def test_jwks_valid_access_token_and_rotation_refresh(monkeypatch, signing_key) -> None:
    token = auth_token(signing_key)
    identity = await verify_with_key(monkeypatch, signing_key, token)
    assert identity.subject == "00000000-0000-0000-0000-000000000001"


async def test_jwks_refreshes_cache_for_rotated_key(monkeypatch, signing_key) -> None:
    token = auth_token(signing_key)
    jwk = public_jwk(signing_key)
    jwk.update({"kid": "test-key", "alg": "ES256"})
    load_jwks = AsyncMock(side_effect=[{}, {"test-key": jwk}])
    monkeypatch.setattr(supabase_auth, "_load_jwks", load_jwks)
    monkeypatch.setattr(
        supabase_auth,
        "_get_auth_user",
        AsyncMock(return_value=fake_user_for("00000000-0000-0000-0000-000000000001")),
    )
    await supabase_auth.verify_supabase_access_token(token)
    assert load_jwks.await_count == 2


async def test_rejects_unsigned_or_unsupported_algorithm(monkeypatch) -> None:
    token = jwt.encode(
        {
            "sub": "subject",
            "iss": "https://phase2-test.supabase.co/auth/v1",
            "aud": "authenticated",
            "iat": datetime.now(UTC),
            "exp": datetime.now(UTC) + timedelta(minutes=5),
        },
        key="",
        algorithm="none",
    )
    with pytest.raises(HTTPException) as error:
        await supabase_auth.verify_supabase_access_token(token)
    assert error.value.status_code == 401


@pytest.mark.parametrize(
    "claims",
    [
        {"issuer": "https://wrong-project.supabase.co/auth/v1"},
        {"audience": "anon"},
        {"expires": datetime.now(UTC) - timedelta(minutes=1)},
    ],
)
async def test_jwks_rejects_wrong_issuer_audience_and_expiry(
    monkeypatch, signing_key, claims
) -> None:
    token = auth_token(signing_key, **claims)
    with pytest.raises(HTTPException) as error:
        await verify_with_key(monkeypatch, signing_key, token)
    assert error.value.status_code == 401


async def test_jwks_rejects_wrong_signature(monkeypatch, signing_key) -> None:
    token = auth_token(ec.derive_private_key(123456789, ec.SECP256R1()))
    jwk = public_jwk(signing_key)
    jwk.update({"kid": "test-key", "alg": "ES256"})
    monkeypatch.setattr(supabase_auth, "_load_jwks", AsyncMock(return_value={"test-key": jwk}))
    with pytest.raises(HTTPException) as error:
        await supabase_auth.verify_supabase_access_token(token)
    assert error.value.status_code == 401


async def test_hs256_uses_auth_server_validation_without_shared_secret(monkeypatch) -> None:
    now = datetime.now(UTC)
    subject = "00000000-0000-0000-0000-000000000001"
    token = jwt.encode(
        {
            "sub": subject,
            "iss": "https://phase2-test.supabase.co/auth/v1",
            "aud": "authenticated",
            "iat": now,
            "exp": now + timedelta(minutes=5),
        },
        "unit-test-only-shared-secret-value-long-enough",
        algorithm="HS256",
    )
    monkeypatch.setattr(supabase_auth, "_get_auth_user", AsyncMock(return_value=fake_user_for(subject)))
    result = await supabase_auth.verify_supabase_access_token(token)
    assert result.subject == subject

    monkeypatch.setattr(
        supabase_auth,
        "_get_auth_user",
        AsyncMock(side_effect=HTTPException(status_code=401, detail="invalid")),
    )
    with pytest.raises(HTTPException) as error:
        await supabase_auth.verify_supabase_access_token(token)
    assert error.value.status_code == 401


async def test_auth_server_must_report_google_provider(monkeypatch, signing_key) -> None:
    token = auth_token(signing_key)
    jwk = public_jwk(signing_key)
    jwk.update({"kid": "test-key", "alg": "ES256"})
    monkeypatch.setattr(supabase_auth, "_load_jwks", AsyncMock(return_value={"test-key": jwk}))
    monkeypatch.setattr(
        supabase_auth,
        "_get_auth_user",
        AsyncMock(return_value={"id": "00000000-0000-0000-0000-000000000001", "app_metadata": {"provider": "email"}}),
    )
    with pytest.raises(HTTPException) as error:
        await supabase_auth.verify_supabase_access_token(token)
    assert error.value.status_code == 403


class FakeSession:
    def __init__(self, *scalar_results: object) -> None:
        self.scalar = AsyncMock(side_effect=list(scalar_results))
        self.commit = AsyncMock()
        self.refresh = AsyncMock()
        self.rollback = AsyncMock()
        self.added: list[User] = []

    def add(self, user: User) -> None:
        user.id = uuid4()
        self.added.append(user)


def bearer(token: str = "supabase-access-token") -> HTTPAuthorizationCredentials:
    return HTTPAuthorizationCredentials(scheme="Bearer", credentials=token)


def fake_request() -> SimpleNamespace:
    return SimpleNamespace(client=SimpleNamespace(host="test"), headers={})


async def test_onboarding_persists_provider_subject_and_display_name(monkeypatch) -> None:
    from app.api import auth

    session = FakeSession(None, None)
    monkeypatch.setattr(auth, "verify_supabase_access_token", AsyncMock(return_value=supabase_auth.SupabaseIdentity("google-subject")))
    monkeypatch.setattr(auth, "enforce_auth_rate_limit", AsyncMock())
    response = await auth.onboard_supabase_identity(
        auth.SupabaseOnboardingRequest(username="walker_one", display_name="Walker One"),
        fake_request(),
        bearer(),
        session,
    )
    assert response.username == "walker_one"
    assert session.added[0].display_name == "Walker One"
    assert session.added[0].supabase_subject == "google-subject"
    assert session.added[0].password_hash is None
    assert jwt.decode(response.access_token, auth.get_settings().jwt_secret, algorithms=["HS256"])["provider_sub"] == "google-subject"


@pytest.mark.parametrize("duplicate", ["username", "subject"])
async def test_onboarding_rejects_duplicate_username_or_provider_subject(monkeypatch, duplicate) -> None:
    from app.api import auth

    existing_id = uuid4()
    values = (existing_id, None) if duplicate == "username" else (None, existing_id)
    session = FakeSession(*values)
    monkeypatch.setattr(auth, "verify_supabase_access_token", AsyncMock(return_value=supabase_auth.SupabaseIdentity("google-subject")))
    monkeypatch.setattr(auth, "enforce_auth_rate_limit", AsyncMock())
    with pytest.raises(HTTPException) as error:
        await auth.onboard_supabase_identity(
            auth.SupabaseOnboardingRequest(username="walker_one"),
            fake_request(), bearer(), session
        )
    assert error.value.status_code == 409
    assert session.added == []


async def test_onboarding_handles_concurrent_unique_constraint_conflict(monkeypatch) -> None:
    from app.api import auth

    session = FakeSession(None, None)
    session.commit.side_effect = IntegrityError("insert", {}, Exception("duplicate"))
    monkeypatch.setattr(auth, "verify_supabase_access_token", AsyncMock(return_value=supabase_auth.SupabaseIdentity("google-subject")))
    monkeypatch.setattr(auth, "enforce_auth_rate_limit", AsyncMock())
    with pytest.raises(HTTPException) as error:
        await auth.onboard_supabase_identity(
            auth.SupabaseOnboardingRequest(username="walker_one"),
            fake_request(), bearer(), session
        )
    assert error.value.status_code == 409
    session.rollback.assert_awaited_once()


async def test_exchange_requires_an_existing_verified_subject_mapping(monkeypatch) -> None:
    from app.api import auth

    monkeypatch.setattr(auth, "verify_supabase_access_token", AsyncMock(return_value=supabase_auth.SupabaseIdentity("unmapped")))
    with pytest.raises(HTTPException) as error:
        await auth.exchange_supabase_session(bearer(), FakeSession(None))
    assert error.value.status_code == 404
    assert error.value.detail["code"] == "identity_not_onboarded"


async def test_exchange_mints_internal_token_for_mapped_user(monkeypatch) -> None:
    from app.api import auth

    user = User(id=uuid4(), username="mapped_user", display_name="Mapped User", supabase_subject="google-subject")
    monkeypatch.setattr(auth, "verify_supabase_access_token", AsyncMock(return_value=supabase_auth.SupabaseIdentity("google-subject")))
    response = await auth.exchange_supabase_session(bearer(), FakeSession(user))
    claims = jwt.decode(response.access_token, auth.get_settings().jwt_secret, algorithms=["HS256"])
    assert response.user_id == str(user.id)
    assert response.username == user.username
    assert claims["sub"] == str(user.id)
    assert claims["provider_sub"] == "google-subject"


async def test_explicit_existing_account_link_requires_local_password(monkeypatch) -> None:
    from app.api import auth

    user = User(id=uuid4(), username="old_account", password_hash=hash_password("local-password"))
    session = FakeSession(user, None)
    monkeypatch.setattr(auth, "verify_supabase_access_token", AsyncMock(return_value=supabase_auth.SupabaseIdentity("google-subject")))
    monkeypatch.setattr(auth, "enforce_auth_rate_limit", AsyncMock())
    response = await auth.link_existing_account(
        auth.ExistingAccountLinkRequest(username="old_account", password="local-password"),
        fake_request(), bearer(), session
    )
    assert user.supabase_subject == "google-subject"
    assert response.user_id == str(user.id)


async def test_existing_account_link_rejects_wrong_password(monkeypatch) -> None:
    from app.api import auth

    user = User(id=uuid4(), username="old_account", password_hash=hash_password("local-password"))
    session = FakeSession(user)
    monkeypatch.setattr(auth, "verify_supabase_access_token", AsyncMock(return_value=supabase_auth.SupabaseIdentity("google-subject")))
    monkeypatch.setattr(auth, "enforce_auth_rate_limit", AsyncMock())
    with pytest.raises(HTTPException) as error:
        await auth.link_existing_account(
            auth.ExistingAccountLinkRequest(username="old_account", password="wrong-password"),
            fake_request(), bearer(), session
        )
    assert error.value.status_code == 401
    assert user.supabase_subject is None


async def test_revoked_internal_session_is_rejected(monkeypatch) -> None:
    from app.core import security

    token = security.create_access_token(uuid4(), provider_subject="stable-subject")
    monkeypatch.setattr(security, "get_ephemeral_value", AsyncMock(return_value="1"))
    with pytest.raises(HTTPException) as error:
        await security._decode_access_token(token)
    assert error.value.status_code == 401


async def test_logout_revokes_internal_token_until_its_expiry(monkeypatch) -> None:
    from app.core import security

    token = security.create_access_token(uuid4(), provider_subject="stable-subject")
    set_value = AsyncMock()
    monkeypatch.setattr(security, "set_ephemeral_value", set_value)
    await security.revoke_access_token(token)
    args = set_value.await_args.args
    assert args[0].startswith("revoked-token:")
    assert args[1] == "1"
    assert args[2] > 0


async def test_application_user_lookup_requires_immutable_provider_mapping(monkeypatch) -> None:
    from app.core import security

    user = User(id=uuid4(), username="mapped", supabase_subject="immutable-subject")
    token = security.create_access_token(user.id, provider_subject="immutable-subject")
    session = FakeSession(user)
    monkeypatch.setattr(security, "get_ephemeral_value", AsyncMock(return_value=None))
    result = await security.get_current_user(bearer(token), session)
    assert result is user
    session.scalar.assert_awaited_once()


async def test_websocket_ticket_is_issued_for_authenticated_local_user(monkeypatch) -> None:
    from app.api import auth

    user_id = uuid4()
    monkeypatch.setattr(auth, "create_ws_ticket", AsyncMock(return_value="one-time-test-ticket"))
    result = await auth.issue_ws_ticket(User(id=user_id, username="mapped"))
    assert result.ticket == "one-time-test-ticket"
    auth.create_ws_ticket.assert_awaited_once_with(user_id)


async def test_local_password_routes_are_not_available_outside_development(monkeypatch) -> None:
    from app.api import auth

    current = auth.settings
    monkeypatch.setattr(auth, "settings", Settings(**{
        "_env_file": None,
        "app_env": "production",
        "jwt_secret": "aB3!dE5@fG7#hJ9$kL2%mN4^pQ6&sT8*",
        "database_url": "postgresql+asyncpg://appuser:DatabasePass-2026-Strong@postgres.db.internal:5432/walkerchat",
        "redis_url": "rediss://redis.internal:6379/0",
        "cors_origins": ["https://chat.example.com"],
        "supabase_url": "https://phase2-test.supabase.co",
        "supabase_publishable_key": "sb_publishable_unit_test_key_abc123",
        "minio_endpoint": "storage.internal:9000",
        "minio_access_key": "minio-live-access-8",
        "minio_secret_key": "A7!cD9@fG2#hJ5$k",
        "minio_secure": True,
    }))
    with pytest.raises(HTTPException) as error:
        await auth.login(auth.LoginRequest(username="old_account", password="pw"), fake_request(), FakeSession())
    assert error.value.status_code == 404
    monkeypatch.setattr(auth, "settings", current)
