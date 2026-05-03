import enum
import uuid
from datetime import UTC, datetime

from sqlalchemy import Boolean, Column, DateTime, Enum as SQLEnum, ForeignKey, String, Text
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
    created_at = Column(DateTime, default=lambda: datetime.now(UTC))


class ChatMember(Base):
    __tablename__ = "chat_members"

    chat_id = Column(UUID(as_uuid=True), ForeignKey("chats.id"), primary_key=True)
    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id"), primary_key=True)
    role = Column(String, default="MEMBER")


class Message(Base):
    __tablename__ = "messages"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    chat_id = Column(UUID(as_uuid=True), ForeignKey("chats.id"))
    sender_id = Column(UUID(as_uuid=True), ForeignKey("users.id"))

    encrypted_payload = Column(Text, nullable=False)
    is_media = Column(Boolean, default=False)

    status = Column(SQLEnum(MessageStatus), default=MessageStatus.SENT)
    sent_at = Column(DateTime, default=lambda: datetime.now(UTC))
