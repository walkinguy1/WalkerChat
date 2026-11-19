"""S3-compatible helpers for encrypted media blobs.

The backend only ever handles ciphertext here. Images are encrypted in the
browser with the chat's AES-GCM session key before upload, so the bytes stored
in MinIO are opaque to the server and to anyone with bucket access.
"""

import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

import aioboto3
from botocore.config import Config
from botocore.exceptions import ClientError

from app.core.config import get_settings

logger = logging.getLogger(__name__)
settings = get_settings()

_session = aioboto3.Session()

# Ciphertext is meaningless to any image parser, so everything is stored as an
# opaque byte stream regardless of the original image type.
OPAQUE_CONTENT_TYPE = "application/octet-stream"


def _bucket_name() -> str:
    return settings.media_bucket or "walkerchat-media"


def _connection() -> tuple[str, str, str, str, bool]:
    if settings.storage_backend == "supabase":
        return (
            settings.supabase_storage_endpoint or "",
            settings.supabase_storage_region or "",
            settings.supabase_storage_access_key or "",
            settings.supabase_storage_secret_key or "",
            True,
        )
    scheme = "https" if settings.minio_secure else "http"
    return (
        f"{scheme}://{settings.minio_endpoint}",
        "us-east-1",
        settings.minio_access_key,
        settings.minio_secret_key,
        False,
    )


@asynccontextmanager
async def s3_client() -> AsyncIterator[Any]:
    """Yield a path-style SigV4 client for the configured private object store."""
    endpoint, region, access_key, secret_key, _is_supabase = _connection()
    async with _session.client(
        "s3",
        endpoint_url=endpoint,
        region_name=region,
        aws_access_key_id=access_key,
        aws_secret_access_key=secret_key,
        config=Config(
            signature_version="s3v4",
            s3={"addressing_style": "path"},
        ),
    ) as client:
        yield client


async def ensure_media_bucket() -> bool:
    """Check the configured bucket; only local MinIO is auto-created."""
    _endpoint, _region, _access, _secret, is_supabase = _connection()
    try:
        async with s3_client() as client:
            try:
                await client.head_bucket(Bucket=_bucket_name())
                return True
            except ClientError as exc:
                error_code = exc.response.get("Error", {}).get("Code", "")
                if error_code not in {"404", "NoSuchBucket", "NotFound"}:
                    raise
                if is_supabase:
                    logger.error("Configured Supabase Storage bucket is unavailable.")
                    return False
                await client.create_bucket(Bucket=_bucket_name())
                logger.info("Created local development media bucket.")
                return True
    except Exception:
        logger.error("Configured object storage is unavailable; media requests will fail.")
        return False


async def put_encrypted_object(key: str, data: bytes) -> None:
    """Store an encrypted blob under the given key."""
    async with s3_client() as client:
        await client.put_object(
            Bucket=_bucket_name(),
            Key=key,
            Body=data,
            ContentType=OPAQUE_CONTENT_TYPE,
            CacheControl="private, no-store",
        )


async def get_encrypted_object(key: str) -> bytes:
    """Read an encrypted blob back. Raises KeyError when the object is gone."""
    max_size = settings.media_max_bytes + 64
    async with s3_client() as client:
        try:
            response = await client.get_object(Bucket=_bucket_name(), Key=key)
        except ClientError as exc:
            error_code = exc.response.get("Error", {}).get("Code", "")
            if error_code in {"404", "NoSuchKey", "NotFound"}:
                raise KeyError(key) from exc
            raise

        if response.get("ContentLength", 0) > max_size:
            raise ValueError("Stored encrypted media exceeds the configured limit.")
        chunks: list[bytes] = []
        total = 0
        async with response["Body"] as stream:
            while total <= max_size:
                chunk = await stream.read(min(64 * 1024, max_size + 1 - total))
                if not chunk:
                    break
                chunks.append(chunk)
                total += len(chunk)
        if total > max_size:
            raise ValueError("Stored encrypted media exceeds the configured limit.")
        return b"".join(chunks)


async def delete_encrypted_object(key: str) -> None:
    """Best-effort removal, used to roll back a failed upload."""
    try:
        async with s3_client() as client:
            await client.delete_object(Bucket=_bucket_name(), Key=key)
    except Exception:
        logger.warning("Unable to delete an orphaned encrypted media object.")
