import json
from datetime import UTC, datetime
from uuid import UUID

from fastapi import APIRouter, Depends, WebSocket, WebSocketDisconnect
from pydantic import ValidationError

from sqlalchemy import select

from app.core.database import SessionLocal
from app.core.rate_limiter import WebSocketRateLimiter
from app.core.security import get_ws_user
from app.core.ws_manager import manager
from app.models import Device
from app.schemas.chat import (
    ChatMessageEvent,
    ErrorEvent,
    SenderKeyEvent,
    TypingEvent,
    WebRTCSignalEvent,
    realtime_event_adapter,
)
from app.services.chat import (
    build_presence_events,
    chat_member_ids,
    ensure_directed_delivery_allowed,
    envelopes_for_message,
    persist_chat_message,
    set_presence_state,
    validate_typing_event,
    validate_webrtc_event,
)

router = APIRouter()

# Rate limiter will be initialized per request to avoid startup issues
rate_limiter = None


def _naive_utc_now() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)


def _to_naive_utc(value: datetime) -> datetime:
    return value.astimezone(UTC).replace(tzinfo=None) if value.tzinfo else value


@router.websocket("/chat")
async def websocket_endpoint(
    websocket: WebSocket,
    user_id: UUID = Depends(get_ws_user),
) -> None:
    # Initialize rate limiter with current Redis connection
    global rate_limiter
    if rate_limiter is None:
        rate_limiter = WebSocketRateLimiter(manager.redis)
    
    user_id_str = str(user_id)
    is_first_connection = await manager.connect(websocket, user_id_str)

    if is_first_connection:
        await set_presence_state(user_id, "online")
        async with SessionLocal() as session:
            presence_events = await build_presence_events(
                session, user_id=user_id, state="online"
            )

        for presence_event in presence_events:
            await manager.publish(
                presence_event.model_dump(mode="json"),
                {str(presence_event.target_id)},
            )

    try:
        while True:
            raw_data = await websocket.receive_text()
            try:
                payload = json.loads(raw_data)
                event = realtime_event_adapter.validate_python(payload)
            except (json.JSONDecodeError, ValidationError):
                await manager.send_to_socket(
                    websocket, ErrorEvent(detail="Invalid realtime payload.").model_dump()
                )
                continue

            if str(event.sender_id) != user_id_str:
                await manager.send_to_socket(
                    websocket,
                    ErrorEvent(detail="Sender identity does not match the socket user.").model_dump(),
                )
                continue

            event = event.model_copy(
                update={"sent_at": _to_naive_utc(event.sent_at or _naive_utc_now())}
            )

            if isinstance(event, ChatMessageEvent):
                # Rate limit message sending
                if not await rate_limiter.can_send_message(user_id_str):
                    await manager.send_to_socket(
                        websocket, 
                        ErrorEvent(detail="Rate limit exceeded. Please wait before sending more messages.").model_dump()
                    )
                    continue

                async with SessionLocal() as session:
                    try:
                        stored_message = await persist_chat_message(session, event)
                    except PermissionError as exc:
                        await manager.send_to_socket(
                            websocket, ErrorEvent(detail=str(exc)).model_dump()
                        )
                        continue

                    # Everyone in the chat, sender included: the echo carries the
                    # server-assigned id back so the sender can mark it delivered.
                    recipients = await chat_member_ids(session, event.chat_id)
                    # Re-read from storage so a resend echoes the envelopes actually
                    # stored, not whatever the duplicate attempt carried.
                    envelopes = await envelopes_for_message(session, stored_message.id)

                outbound_event = event.model_copy(
                    update={
                        "message_id": stored_message.id,
                        "sent_at": stored_message.sent_at,
                        "envelopes": envelopes,
                        # Server-resolved, not taken from the sender's claim: receivers
                        # key their ratchet session on it.
                        "sender_device_row_id": (
                            str(stored_message.sender_device_id)
                            if stored_message.sender_device_id
                            else None
                        ),
                    }
                )
                # Every device receives the whole envelope set and picks out its own.
                # One event beats one per device, and the extra bytes are ciphertext
                # the other devices cannot read anyway.
                await manager.publish(outbound_event.model_dump(mode="json"), recipients)
                continue

            if isinstance(event, TypingEvent):
                # Rate limit typing indicators
                if not await rate_limiter.can_send_typing(user_id_str):
                    continue  # Silently ignore excessive typing events

                async with SessionLocal() as session:
                    try:
                        await validate_typing_event(session, event)
                    except PermissionError as exc:
                        await manager.send_to_socket(
                            websocket, ErrorEvent(detail=str(exc)).model_dump()
                        )
                        continue

                    recipients = await chat_member_ids(session, event.chat_id)

                # Echoing your own typing state back is noise.
                recipients.discard(user_id_str)
                await manager.publish(event.model_dump(mode="json"), recipients)
                continue

            if isinstance(event, SenderKeyEvent):
                # Group key setup, addressed to one member. Relayed, never stored: the
                # payload is key material, and the server has no reason to keep it.
                async with SessionLocal() as session:
                    try:
                        await ensure_directed_delivery_allowed(
                            session,
                            chat_id=event.chat_id,
                            sender_id=event.sender_id,
                            target_id=event.target_id,
                        )
                    except PermissionError as exc:
                        await manager.send_to_socket(
                            websocket, ErrorEvent(detail=str(exc)).model_dump()
                        )
                        continue

                    sender_device = None
                    if event.sender_device_id:
                        sender_device = await session.scalar(
                            select(Device).where(
                                Device.user_id == event.sender_id,
                                Device.device_id == event.sender_device_id,
                            )
                        )

                outbound = event.model_copy(
                    update={
                        "sender_device_row_id": (
                            str(sender_device.id) if sender_device else None
                        )
                    }
                )
                await manager.publish(
                    outbound.model_dump(mode="json"), {str(event.target_id)}
                )
                continue

            if isinstance(event, WebRTCSignalEvent):
                # Call signaling rides this socket; media itself stays
                # peer-to-peer and never reaches the server.
                async with SessionLocal() as session:
                    try:
                        await validate_webrtc_event(session, event)
                    except PermissionError as exc:
                        await manager.send_to_socket(
                            websocket, ErrorEvent(detail=str(exc)).model_dump()
                        )
                        continue

                await manager.publish(
                    event.model_dump(mode="json"), {str(event.target_id)}
                )
                continue

            await manager.publish(event.model_dump(mode="json"), {user_id_str})
    except WebSocketDisconnect:
        is_last_connection = manager.disconnect(websocket, user_id_str)
        if is_last_connection:
            await set_presence_state(user_id, "offline")
            async with SessionLocal() as session:
                presence_events = await build_presence_events(
                    session, user_id=user_id, state="offline"
                )

            for presence_event in presence_events:
                await manager.publish(
                    presence_event.model_dump(mode="json"),
                    {str(presence_event.target_id)},
                )
