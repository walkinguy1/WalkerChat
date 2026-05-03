import uuid
from datetime import datetime
from sqlalchemy import Column, String, DateTime
from sqlalchemy.dialects.postgresql import UUID
from .base import Base

class User(Base):
    __tablename__ = "users"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    username = Column(String, unique=True, index=True, nullable=False)
    
    # E2EE Public Keys (X3DH)
    identity_key_pub = Column(String, nullable=False)
    signed_prekey_pub = Column(String, nullable=False)
    
    created_at = Column(DateTime, default=datetime.utcnow)
