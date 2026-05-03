import uuid

from sqlalchemy import Boolean, Column, ForeignKey, String
from sqlalchemy.dialects.postgresql import UUID

from .base import Base


class OneTimePreKey(Base):
    """One-time prekeys (OPKs) for X3DH forward secrecy."""

    __tablename__ = "one_time_prekeys"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False, index=True)
    key_id = Column(String, nullable=False)
    public_key = Column(String, nullable=False)
    used = Column(Boolean, default=False)
