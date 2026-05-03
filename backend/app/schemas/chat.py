from datetime import datetime
from typing import Annotated, Any, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, TypeAdapter


class EncryptionMetadata(BaseModel):
    model_config = ConfigDict(extra="forbid")

    algorithm: str = "aes-256-gcm"
    version: int = 1
    key_id: str = "local-device"


class ChatMessageEvent(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: Literal["chat_message"]
    chat_id: UUID
    client_message_id: UUID
    message_id: UUID | None = None
    sender_id: UUID
    target_id: UUID
    ciphertext: str = Field(min_length=1)
    encryption: EncryptionMetadata = Field(default_factory=EncryptionMetadata)
    sent_at: datetime | None = None


class WebRTCSignalEvent(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: Literal["webrtc_offer", "webrtc_answer", "webrtc_ice"]
    sender_id: UUID
    target_id: UUID
    payload: dict[str, Any]
    sent_at: datetime | None = None


class TypingEvent(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: Literal["typing"]
    chat_id: UUID
    sender_id: UUID
    target_id: UUID
    is_typing: bool
    sent_at: datetime | None = None


class PresenceEvent(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: Literal["presence"]
    chat_id: UUID
    user_id: UUID
    target_id: UUID
    state: Literal["online", "offline"]
    sent_at: datetime | None = None


class ErrorEvent(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: Literal["error"] = "error"
    detail: str


RealtimeEvent = Annotated[
    ChatMessageEvent | WebRTCSignalEvent | TypingEvent,
    Field(discriminator="type"),
]
realtime_event_adapter = TypeAdapter(RealtimeEvent)


class ChatMessageRecord(BaseModel):
    message_id: UUID
    chat_id: UUID
    sender_id: UUID
    ciphertext: str
    status: str
    is_media: bool
    sent_at: datetime
    encryption: EncryptionMetadata = Field(default_factory=EncryptionMetadata)


class ChatHistoryResponse(BaseModel):
    items: list[ChatMessageRecord]


class DemoUserProfile(BaseModel):
    id: UUID
    username: str
    display_name: str
    initials: str
    presence_state: Literal["online", "offline"] = "offline"


class DemoChatMember(BaseModel):
    user_id: UUID
    username: str
    display_name: str
    initials: str
    presence_state: Literal["online", "offline"] = "offline"


class DemoChatSummary(BaseModel):
    id: UUID
    name: str
    type: str
    summary: str
    members: list[DemoChatMember]


class BootstrapResponse(BaseModel):
    users: list[DemoUserProfile]
    chats: list[DemoChatSummary]
