import uuid
from datetime import UTC, datetime

from sqlalchemy import CheckConstraint, Column, DateTime, ForeignKey, Index, String, UniqueConstraint
from sqlalchemy.dialects.postgresql import UUID

from .base import Base


def _now() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)


class ContactRequest(Base):
    __tablename__ = "contact_requests"
    __table_args__ = (
        UniqueConstraint("requester_id", "target_id", name="uq_contact_request_pair"),
        CheckConstraint("requester_id <> target_id", name="ck_contact_request_not_self"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    requester_id = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False, index=True)
    target_id = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False, index=True)
    status = Column(String(16), nullable=False, default="pending")
    created_at = Column(DateTime, nullable=False, default=_now)


class Contact(Base):
    __tablename__ = "contacts"
    __table_args__ = (
        CheckConstraint("user_low_id < user_high_id", name="ck_contact_pair_ordered"),
        Index("ix_contacts_user_high_id", "user_high_id"),
    )

    user_low_id = Column(UUID(as_uuid=True), ForeignKey("users.id"), primary_key=True)
    user_high_id = Column(UUID(as_uuid=True), ForeignKey("users.id"), primary_key=True)
    created_at = Column(DateTime, nullable=False, default=_now)


class ContactBlock(Base):
    __tablename__ = "contact_blocks"
    __table_args__ = (
        CheckConstraint("blocker_id <> blocked_id", name="ck_contact_block_not_self"),
        Index("ix_contact_blocks_blocked_id", "blocked_id"),
    )

    blocker_id = Column(UUID(as_uuid=True), ForeignKey("users.id"), primary_key=True)
    blocked_id = Column(UUID(as_uuid=True), ForeignKey("users.id"), primary_key=True)
    created_at = Column(DateTime, nullable=False, default=_now)
