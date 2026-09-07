import uuid
from datetime import UTC, datetime

from sqlalchemy import Column, DateTime, ForeignKey, String, UniqueConstraint
from sqlalchemy.dialects.postgresql import UUID

from .base import Base


class OneTimePreKey(Base):
    """
    One-time prekeys (OPKs) for X3DH forward secrecy.

    Owned by a device rather than a user: each installation runs its own X3DH, so
    prekeys published by one device are useless to another.

    A claimed prekey is deleted rather than flagged. The private half lives only on the
    owning device, so a consumed row has no further use to the server, and the previous
    "used" flag meant consumed rows accumulated forever with nothing ever resetting them.
    """

    __tablename__ = "one_time_prekeys"
    __table_args__ = (
        UniqueConstraint("device_id", "key_id", name="uq_one_time_prekeys_device_key"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    device_id = Column(
        UUID(as_uuid=True), ForeignKey("devices.id"), nullable=False, index=True
    )
    key_id = Column(String, nullable=False)
    public_key = Column(String, nullable=False)
    created_at = Column(
        DateTime, default=lambda: datetime.now(UTC).replace(tzinfo=None), nullable=False
    )
