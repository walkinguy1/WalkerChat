import os

import aioboto3
from botocore.config import Config

_session = aioboto3.Session()

MINIO_ENDPOINT = f"http://{os.environ.get('MINIO_ENDPOINT', 'localhost:9000')}"
MINIO_ACCESS_KEY = os.environ.get("MINIO_ACCESS_KEY", "minioadmin")
MINIO_SECRET_KEY = os.environ.get("MINIO_SECRET_KEY", "minioadmin")


async def get_s3_client():
    """Async context manager for S3/MinIO client."""
    async with _session.client(
        "s3",
        endpoint_url=MINIO_ENDPOINT,
        aws_access_key_id=MINIO_ACCESS_KEY,
        aws_secret_access_key=MINIO_SECRET_KEY,
        config=Config(signature_version="s3v4"),
    ) as client:
        yield client
