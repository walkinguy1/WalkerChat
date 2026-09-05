from datetime import datetime
from typing import Annotated, Any, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, TypeAdapter


class ChatMessageEvent(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: Literal["chat_message"]
    chat_id: UUID
    client_message_id: UUID
    message_id: UUID | None = None
    sender_id: UUID
    target_id: UUID
    ciphertext: str = Field(min_length=1)
    is_media: bool = False
    sent_at: datetime | None = None


class WebRTCSignalEvent(BaseModel):
    """Call signaling relayed over the chat socket.

    The server never inspects `payload` beyond forwarding it; SDP and ICE
    candidates are opaque here. `chat_id` exists so membership can be verified
    before a signal reaches anybody.
    """

    model_config = ConfigDict(extra="forbid")

    type: Literal[
        "webrtc_offer",
        "webrtc_answer",
        "webrtc_ice",
        "webrtc_hangup",
        "webrtc_reject",
    ]
    chat_id: UUID
    call_id: UUID
    sender_id: UUID
    target_id: UUID
    media: Literal["audio", "video"] = "video"
    payload: dict[str, Any] = Field(default_factory=dict)
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
    # Echoed back so the client can reconcile its optimistic copy across a reload,
    # not just within the lifetime of one page.
    client_message_id: UUID


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
    # Rooms and direct threads are listed apart in the sidebar, so the client
    # needs the distinction without having to count members itself.
    kind: Literal["room", "direct"] = "direct"
    member_count: int = 0
    summary: str
    members: list[DemoChatMember]


class BootstrapResponse(BaseModel):
    users: list[DemoUserProfile]
    chats: list[DemoChatSummary]
