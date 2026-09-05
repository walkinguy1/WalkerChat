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
    password_hash = Column(String, nullable=False)

    # X3DH public key material.
    #
    # These are nullable because a freshly registered account has not generated keys
    # yet: key generation happens in the browser, after registration returns. The
    # previous schema used a "pending-client-upload" sentinel in a NOT NULL public-key
    # column, which meant an unusable string was indistinguishable from a real key.
    identity_key_pub = Column(String, nullable=True)
    identity_key_changed_at = Column(DateTime, nullable=True)

    signed_prekey_id = Column(String, nullable=True)
    signed_prekey_pub = Column(String, nullable=True)
    signed_prekey_sig = Column(String, nullable=True)
    signed_prekey_created_at = Column(DateTime, nullable=True)

    created_at = Column(DateTime, default=_naive_utc_now)

    @property
    def has_published_keys(self) -> bool:
        """Whether this account can take part in an X3DH handshake yet."""
        return bool(
            self.identity_key_pub
            and self.signed_prekey_pub
            and self.signed_prekey_sig
            and self.signed_prekey_id
        )
