import enum
import uuid
from datetime import UTC, datetime

from sqlalchemy import (
    Boolean,
    Column,
    DateTime,
    Enum as SQLEnum,
    ForeignKey,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import UUID

from .base import Base


class ChatType(enum.Enum):
    DIRECT = "DIRECT"
    GROUP = "GROUP"


class MessageStatus(enum.Enum):
    SENT = "SENT"
    DELIVERED = "DELIVERED"
    READ = "READ"


class Chat(Base):
    __tablename__ = "chats"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    type = Column(SQLEnum(ChatType), default=ChatType.DIRECT)
    # Groups carry a name; direct chats are named after the other participant by the
    # client, so there is nothing meaningful to store.
    name = Column(String, nullable=True)
    created_by = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=True)
    created_at = Column(DateTime, default=lambda: datetime.now(UTC).replace(tzinfo=None))


class ChatMember(Base):
    __tablename__ = "chat_members"

    chat_id = Column(UUID(as_uuid=True), ForeignKey("chats.id"), primary_key=True)
    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id"), primary_key=True)
    role = Column(String, default="MEMBER")


class Message(Base):
    """
    The logical message: who sent what, where, and when.

    The ciphertext is not here. A pairwise ratchet encrypts to one device's chain, so a
    message sent to a two-device recipient needs two different ciphertexts. Those live
    in `MessageEnvelope`, one row per destination device.

    Group messages are the exception -- Sender Keys produce a single ciphertext for
    everyone -- and are stored as one envelope with a null device, readable by all
    members.
    """

    __tablename__ = "messages"
    __table_args__ = (
        # Idempotency. Without this a WebSocket reconnect mid-send writes the row
        # twice, and the receiving ratchet sees the duplicate as a replay.
        UniqueConstraint("chat_id", "client_message_id", name="uq_messages_chat_client_id"),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    chat_id = Column(UUID(as_uuid=True), ForeignKey("chats.id"))
    sender_id = Column(UUID(as_uuid=True), ForeignKey("users.id"))
    sender_device_id = Column(UUID(as_uuid=True), ForeignKey("devices.id"), nullable=True)

    client_message_id = Column(String, nullable=False)

    is_media = Column(Boolean, default=False)

    status = Column(SQLEnum(MessageStatus), default=MessageStatus.SENT)
    # Server-assigned receive time. The client's own timestamp is advisory only: a
    # skewed or malicious clock must not be able to reorder history.
    sent_at = Column(DateTime, default=lambda: datetime.now(UTC).replace(tzinfo=None))


class MessageEnvelope(Base):
    """
    One ciphertext, addressed to one device.

    `encrypted_payload` is fully opaque: it carries the message type, the ratchet
    header, and the ciphertext as one sealed blob. The ratchet header is deliberately
    *not* broken out into queryable columns -- doing so would publish the sender's
    ratchet key and message counters to the server for no operational benefit.

    A null `recipient_device_id` means a group message, which is one ciphertext for the
    whole membership rather than one per device.
    """

    __tablename__ = "message_envelopes"
    __table_args__ = (
        UniqueConstraint(
            "message_id", "recipient_device_id", name="uq_envelopes_message_device"
        ),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    message_id = Column(
        UUID(as_uuid=True), ForeignKey("messages.id"), nullable=False, index=True
    )
    recipient_device_id = Column(
        UUID(as_uuid=True), ForeignKey("devices.id"), nullable=True, index=True
    )
    encrypted_payload = Column(Text, nullable=False)
