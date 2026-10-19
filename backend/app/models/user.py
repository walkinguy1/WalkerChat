import uuid
from datetime import UTC, datetime

from sqlalchemy import Column, DateTime, String
from sqlalchemy.dialects.postgresql import UUID

from .base import Base


def _naive_utc_now() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)


class User(Base):
    __tablename__ = "users"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    username = Column(String, unique=True, index=True, nullable=False)
    password_hash = Column(String, nullable=True)
    display_name = Column(String, nullable=True)
    supabase_subject = Column(String(255), unique=True, index=True, nullable=True)

    created_at = Column(DateTime, default=_naive_utc_now)

    # Key material lives on `devices`, not here. An account can be signed in on several
    # installations at once, and each holds its own identity key and ratchets.
