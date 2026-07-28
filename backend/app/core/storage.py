"""S3/MinIO helpers for encrypted media blobs.

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


def _endpoint_url() -> str:
    scheme = "https" if settings.minio_secure else "http"
    return f"{scheme}://{settings.minio_endpoint}"


@asynccontextmanager
async def s3_client() -> AsyncIterator[Any]:
    """Yield a configured async S3 client bound to the MinIO endpoint."""
    async with _session.client(
        "s3",
        endpoint_url=_endpoint_url(),
        aws_access_key_id=settings.minio_access_key,
        aws_secret_access_key=settings.minio_secret_key,
        config=Config(signature_version="s3v4"),
    ) as client:
        yield client


async def ensure_media_bucket() -> bool:
    """Create the media bucket when missing. Returns True when usable."""
    try:
        async with s3_client() as client:
            try:
                await client.head_bucket(Bucket=settings.media_bucket)
                return True
            except ClientError as exc:
                error_code = exc.response.get("Error", {}).get("Code", "")
                if error_code not in {"404", "NoSuchBucket", "NotFound"}:
                    raise
                await client.create_bucket(Bucket=settings.media_bucket)
                logger.info("Created media bucket %s", settings.media_bucket)
                return True
    except Exception:
        logger.exception(
            "Object storage is unavailable at %s. Encrypted media upload will fail "
            "until MinIO is reachable.",
            _endpoint_url(),
        )
        return False


async def put_encrypted_object(key: str, data: bytes) -> None:
    """Store an encrypted blob under the given key."""
    async with s3_client() as client:
        await client.put_object(
            Bucket=settings.media_bucket,
            Key=key,
            Body=data,
            ContentType=OPAQUE_CONTENT_TYPE,
        )


async def get_encrypted_object(key: str) -> bytes:
    """Read an encrypted blob back. Raises KeyError when the object is gone."""
    async with s3_client() as client:
        try:
            response = await client.get_object(Bucket=settings.media_bucket, Key=key)
        except ClientError as exc:
            error_code = exc.response.get("Error", {}).get("Code", "")
            if error_code in {"404", "NoSuchKey", "NotFound"}:
                raise KeyError(key) from exc
            raise

        async with response["Body"] as stream:
            return await stream.read()


async def delete_encrypted_object(key: str) -> None:
    """Best-effort removal, used to roll back a failed upload."""
    try:
        async with s3_client() as client:
            await client.delete_object(Bucket=settings.media_bucket, Key=key)
    except Exception:
        logger.warning("Unable to delete orphaned media object %s", key, exc_info=True)
