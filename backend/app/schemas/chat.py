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
    # The client's own installation id, as it published it. Untrusted input.
    sender_device_id: str | None = None
    # Server-resolved device row for the sender. Receivers key their ratchet session on
    # this, so it must come from the server rather than from the sender's claim.
    sender_device_row_id: str | None = None
    # Optional and unused for routing: delivery follows chat membership. Kept so a
    # client can still name a recipient in a direct chat without the server trusting it.
    target_id: UUID | None = None
    # One ciphertext per recipient device, keyed by device row id. A pairwise ratchet
    # encrypts to one device's chain, so a two-device recipient needs two ciphertexts.
    # Group messages use the single "*" key: Sender Keys produce one ciphertext for all.
    envelopes: dict[str, str] = Field(default_factory=dict, max_length=64)
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
    # Same as chat messages: routing follows chat membership, not this field.
    target_id: UUID | None = None
    is_typing: bool
    sent_at: datetime | None = None


class SenderKeyEvent(BaseModel):
    """
    A sender key distribution, relayed to exactly one member.

    The payload is encrypted with the pairwise Double Ratchet session between sender and
    target, so the server relays bytes it cannot read. It is deliberately *not* stored:
    it is key setup, not conversation, and keeping copies of key material around serves
    no one.
    """

    model_config = ConfigDict(extra="forbid")

    type: Literal["sender_key"]
    chat_id: UUID
    sender_id: UUID
    sender_device_id: str | None = None
    # Server-resolved, as for chat messages: the recipient keys its session on it.
    sender_device_row_id: str | None = None
    target_id: UUID
    ciphertext: str = Field(min_length=1)
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
    ChatMessageEvent | WebRTCSignalEvent | TypingEvent | SenderKeyEvent,
    Field(discriminator="type"),
]
realtime_event_adapter = TypeAdapter(RealtimeEvent)


class ChatMessageRecord(BaseModel):
    message_id: UUID
    chat_id: UUID
    sender_id: UUID
    sender_device_row_id: str | None = None
    # The one envelope addressed to the requesting device.
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
