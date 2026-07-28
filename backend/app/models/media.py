import uuid
from datetime import UTC, datetime

from sqlalchemy import Column, DateTime, ForeignKey, Integer, String
from sqlalchemy.dialects.postgresql import UUID

from .base import Base


class MediaObject(Base):
    """Metadata for an encrypted media blob held in object storage.

    Only the storage key and size live here. The image bytes are encrypted
    client-side, and the IV plus mime type travel inside the encrypted message
    envelope, so this table reveals nothing about the picture itself.
    """

    __tablename__ = "media_objects"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    chat_id = Column(UUID(as_uuid=True), ForeignKey("chats.id"), nullable=False)
    uploader_id = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False)

    object_key = Column(String(255), nullable=False, unique=True)
    size_bytes = Column(Integer, nullable=False)

    created_at = Column(DateTime, default=lambda: datetime.now(UTC).replace(tzinfo=None))
