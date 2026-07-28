from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, ConfigDict


class MediaUploadResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    media_id: UUID
    chat_id: UUID
    size_bytes: int
    created_at: datetime


class IceServer(BaseModel):
    model_config = ConfigDict(extra="forbid")

    urls: list[str]
    username: str | None = None
    credential: str | None = None


class IceConfigResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    ice_servers: list[IceServer]
