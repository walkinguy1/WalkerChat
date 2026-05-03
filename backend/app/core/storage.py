import os
import boto3
from botocore.config import Config

s3_client = boto3.client(
    "s3",
    endpoint_url=f"http://{os.environ.get('MINIO_ENDPOINT', 'localhost:9000')}",
    aws_access_key_id=os.environ.get("MINIO_ACCESS_KEY", "minioadmin"),
    aws_secret_access_key=os.environ.get("MINIO_SECRET_KEY", "minioadmin"),
    config=Config(signature_version='s3v4')
)
