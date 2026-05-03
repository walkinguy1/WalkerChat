import os
from celery import Celery

celery_app = Celery("walkerchat_worker")
celery_app.conf.broker_url = os.environ.get("CELERY_BROKER_URL", "redis://localhost:6379/1")
celery_app.conf.result_backend = os.environ.get("CELERY_RESULT_BACKEND", "redis://localhost:6379/1")

@celery_app.task
def process_media_upload(s3_uri: str):
    print(f"Processing media securely at {s3_uri}")
    return True
