from contextlib import asynccontextmanager
from io import BytesIO
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock
from uuid import uuid4

import pytest
from botocore.exceptions import ClientError
from fastapi import HTTPException, UploadFile

from app.api import media as media_api
from app.core import storage
from app.core.config import Settings
from app import main as main_module
from app.models.user import User


class FakeBody:
    def __init__(self, value: bytes):
        self.value = value
        self.offset = 0

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_args):
        return None

    async def read(self, size=-1):
        if size < 0:
            size = len(self.value) - self.offset
        chunk = self.value[self.offset : self.offset + size]
        self.offset += len(chunk)
        return chunk


class FakeS3:
    def __init__(self):
        self.objects: dict[str, bytes] = {}
        self.put_args: dict | None = None
        self.create_calls = 0
        self.missing_bucket = False

    async def head_bucket(self, **_kwargs):
        if self.missing_bucket:
            raise ClientError({"Error": {"Code": "404"}}, "HeadBucket")

    async def create_bucket(self, **_kwargs):
        self.create_calls += 1

    async def put_object(self, **kwargs):
        self.put_args = kwargs
        self.objects[kwargs["Key"]] = kwargs["Body"]

    async def get_object(self, **kwargs):
        return {"Body": FakeBody(self.objects[kwargs["Key"]])}

    async def delete_object(self, **kwargs):
        self.objects.pop(kwargs["Key"], None)


def patch_s3(monkeypatch, client: FakeS3):
    @asynccontextmanager
    async def fake_client():
        yield client

    monkeypatch.setattr(storage, "s3_client", fake_client)


@pytest.mark.asyncio
async def test_s3_adapter_round_trips_ciphertext_with_opaque_private_metadata(monkeypatch):
    client = FakeS3()
    patch_s3(monkeypatch, client)
    plaintext = b"private attachment plaintext"
    ciphertext = b"\x91\x00\xfe\x03authenticated-ciphertext"

    await storage.put_encrypted_object("chat-id/random-id.bin", ciphertext)
    assert client.put_args["Body"] != plaintext
    assert client.put_args["ContentType"] == "application/octet-stream"
    assert client.put_args["CacheControl"] == "private, no-store"
    assert await storage.get_encrypted_object("chat-id/random-id.bin") == ciphertext
    await storage.delete_encrypted_object("chat-id/random-id.bin")
    assert not client.objects


@pytest.mark.asyncio
async def test_supabase_bucket_is_never_created_implicitly(monkeypatch):
    client = FakeS3()
    client.missing_bucket = True
    patch_s3(monkeypatch, client)
    monkeypatch.setattr(storage, "_connection", lambda: ("endpoint", "region", "key", "secret", True))
    assert await storage.ensure_media_bucket() is False
    assert client.create_calls == 0


@pytest.mark.asyncio
async def test_media_upload_rejects_empty_and_oversized_bodies(monkeypatch):
    user = User(id=uuid4(), username="sender")
    monkeypatch.setattr(media_api, "ensure_chat_delivery_allowed", AsyncMock())
    monkeypatch.setattr(media_api, "_enforce_upload_rate_limit", AsyncMock())
    monkeypatch.setattr(media_api.settings, "media_max_bytes", 8)
    for payload, expected in [(b"", 400), (b"x" * 73, 413)]:
        with pytest.raises(HTTPException) as error:
            await media_api.upload_encrypted_media(
                uuid4(), UploadFile(filename="cipher.bin", file=BytesIO(payload)), user, AsyncMock()
            )
        assert error.value.status_code == expected


@pytest.mark.asyncio
async def test_nonmember_cannot_download_private_blob(monkeypatch):
    user = User(id=uuid4(), username="intruder")
    media_id = uuid4()
    record = SimpleNamespace(id=media_id, chat_id=uuid4(), object_key="private/object.bin")
    session = AsyncMock()
    session.get.return_value = record
    monkeypatch.setattr(media_api, "user_is_chat_member", AsyncMock(return_value=False))
    get_blob = AsyncMock()
    monkeypatch.setattr(media_api, "get_encrypted_object", get_blob)

    with pytest.raises(HTTPException) as error:
        await media_api.download_encrypted_media(media_id, user, session)
    assert error.value.status_code == 403
    get_blob.assert_not_awaited()


@pytest.mark.asyncio
async def test_nonmember_upload_is_rejected_before_storage(monkeypatch):
    user = User(id=uuid4(), username="outsider")
    put_blob = AsyncMock()
    monkeypatch.setattr(
        media_api,
        "ensure_chat_delivery_allowed",
        AsyncMock(side_effect=PermissionError("membership required")),
    )
    monkeypatch.setattr(media_api, "put_encrypted_object", put_blob)
    with pytest.raises(HTTPException) as error:
        await media_api.upload_encrypted_media(
            uuid4(), UploadFile(filename="cipher.bin", file=BytesIO(b"ciphertext")), user, AsyncMock()
        )
    assert error.value.status_code == 403
    put_blob.assert_not_awaited()


@pytest.mark.asyncio
async def test_authorized_download_returns_private_opaque_ciphertext(monkeypatch):
    user = User(id=uuid4(), username="member")
    record = SimpleNamespace(id=uuid4(), chat_id=uuid4(), object_key="opaque/object.bin")
    session = AsyncMock()
    session.get.return_value = record
    monkeypatch.setattr(media_api, "user_is_chat_member", AsyncMock(return_value=True))
    monkeypatch.setattr(media_api, "get_encrypted_object", AsyncMock(return_value=b"\x00ciphertext"))
    response = await media_api.download_encrypted_media(record.id, user, session)
    assert response.body == b"\x00ciphertext"
    assert response.headers["content-type"] == "application/octet-stream"
    assert response.headers["cache-control"] == "private, no-store"
    assert response.headers["x-content-type-options"] == "nosniff"


@pytest.mark.asyncio
async def test_storage_failures_are_returned_without_provider_details(monkeypatch):
    user = User(id=uuid4(), username="member")
    monkeypatch.setattr(media_api, "ensure_chat_delivery_allowed", AsyncMock())
    monkeypatch.setattr(media_api, "_enforce_upload_rate_limit", AsyncMock())
    monkeypatch.setattr(media_api, "put_encrypted_object", AsyncMock(side_effect=RuntimeError("secret endpoint detail")))
    with pytest.raises(HTTPException) as error:
        await media_api.upload_encrypted_media(
            uuid4(), UploadFile(filename="cipher.bin", file=BytesIO(b"ciphertext")), user, AsyncMock()
        )
    assert error.value.status_code == 503
    assert "secret endpoint detail" not in error.value.detail

    record = SimpleNamespace(id=uuid4(), chat_id=uuid4(), object_key="opaque/object.bin")
    session = AsyncMock()
    session.get.return_value = record
    monkeypatch.setattr(media_api, "user_is_chat_member", AsyncMock(return_value=True))
    monkeypatch.setattr(media_api, "get_encrypted_object", AsyncMock(side_effect=KeyError(record.object_key)))
    with pytest.raises(HTTPException) as missing:
        await media_api.download_encrypted_media(record.id, user, session)
    assert missing.value.status_code == 404


@pytest.mark.asyncio
async def test_upload_database_failure_removes_orphaned_blob(monkeypatch):
    user = User(id=uuid4(), username="sender")
    session = AsyncMock()
    session.add = MagicMock()
    session.commit.side_effect = RuntimeError("db unavailable")
    uploaded = AsyncMock()
    deleted = AsyncMock()
    monkeypatch.setattr(media_api, "ensure_chat_delivery_allowed", AsyncMock())
    monkeypatch.setattr(media_api, "_enforce_upload_rate_limit", AsyncMock())
    monkeypatch.setattr(media_api, "put_encrypted_object", uploaded)
    monkeypatch.setattr(media_api, "delete_encrypted_object", deleted)

    with pytest.raises(RuntimeError, match="db unavailable"):
        await media_api.upload_encrypted_media(
            uuid4(), UploadFile(filename="cipher.bin", file=BytesIO(b"ciphertext")), user, session
        )
    uploaded.assert_awaited_once()
    deleted.assert_awaited_once_with(uploaded.await_args.args[0])


@pytest.mark.asyncio
async def test_bounded_upload_reader_reads_no_more_than_limit_plus_one():
    file = UploadFile(filename="large.bin", file=BytesIO(b"x" * 1000))
    value = await media_api._read_bounded_upload(file, 99)
    assert len(value) == 100


@pytest.mark.asyncio
async def test_non_development_startup_fails_when_private_storage_is_unavailable(monkeypatch):
    config = Settings(
        _env_file=None,
        app_env="production",
        jwt_secret="aB3!dE5@fG7#hJ9$kL2%mN4^pQ6&sT8*",
        database_url="postgresql+asyncpg://appuser:DatabasePass-2026-Strong@postgres.db.internal:5432/walkerchat",
        redis_url="rediss://redis.internal:6379/0",
        cors_origins=["https://chat.example.com"],
        supabase_url="https://phase5-test.supabase.co",
        supabase_publishable_key="sb_publishable_unit_test_key_abc123",
        storage_backend="supabase",
        supabase_storage_endpoint="https://phase5-test.storage.supabase.co/storage/v1/s3",
        supabase_storage_region="us-west-1",
        supabase_storage_access_key="storage-access-key-2026",
        supabase_storage_secret_key="A7!cD9@fG2#hJ5$kL8!mN2@pQ5",
        media_bucket="walkerchat-private-test",
    )
    monkeypatch.setattr(main_module, "verify_database_schema", AsyncMock())
    monkeypatch.setattr(main_module, "ensure_media_bucket", AsyncMock(return_value=False))
    app = main_module.create_app(config)
    with pytest.raises(RuntimeError, match="object storage is unavailable"):
        async with app.router.lifespan_context(app):
            pass
