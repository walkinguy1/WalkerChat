import uuid
from datetime import UTC, datetime

from sqlalchemy import Column, DateTime, ForeignKey, String, UniqueConstraint
from sqlalchemy.dialects.postgresql import UUID

from .base import Base


def _naive_utc_now() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)


class Device(Base):
    """
    One installation of the app.

    Key material belongs to a *device*, not an account. It used to live on `users`, in a
    single set of columns, which meant signing in on a second browser overwrote the
    first device's identity key and silently broke every session it had. A device is
    also the unit of delivery: a message is encrypted separately for each one, because
    each holds its own ratchet.
    """

    __tablename__ = "devices"
    __table_args__ = (
        UniqueConstraint("user_id", "device_id", name="uq_devices_user_device"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False, index=True)

    # Client-generated and stable for the life of the installation, so the same browser
    # profile keeps its identity across sign-outs.
    device_id = Column(String, nullable=False)
    display_name = Column(String, nullable=True)

    identity_key_pub = Column(String, nullable=False)
    identity_key_changed_at = Column(DateTime, nullable=True)

    signed_prekey_id = Column(String, nullable=False)
    signed_prekey_pub = Column(String, nullable=False)
    signed_prekey_sig = Column(String, nullable=False)
    signed_prekey_created_at = Column(DateTime, nullable=True)

    created_at = Column(DateTime, default=_naive_utc_now)
    last_seen_at = Column(DateTime, default=_naive_utc_now)
