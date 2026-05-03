import json
from datetime import UTC, datetime
from uuid import UUID

from fastapi import APIRouter, Depends, WebSocket, WebSocketDisconnect
from pydantic import ValidationError

from app.core.database import SessionLocal
from app.core.security import get_ws_user
from app.core.ws_manager import manager
from app.schemas.chat import ChatMessageEvent, ErrorEvent, TypingEvent, realtime_event_adapter
from app.services.chat import (
    build_presence_events,
    persist_chat_message,
    set_presence_state,
    validate_typing_event,
)

router = APIRouter()


def _naive_utc_now() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)


def _to_naive_utc(value: datetime) -> datetime:
    return value.astimezone(UTC).replace(tzinfo=None) if value.tzinfo else value


@router.websocket("/chat")
async def websocket_endpoint(
    websocket: WebSocket,
    user_id: UUID = Depends(get_ws_user),
) -> None:
    user_id_str = str(user_id)
    is_first_connection = await manager.connect(websocket, user_id_str)

    if is_first_connection:
        await set_presence_state(user_id, "online")
        async with SessionLocal() as session:
            presence_events = await build_presence_events(
                session, user_id=user_id, state="online"
            )

        for presence_event in presence_events:
            await manager.publish(presence_event.model_dump(mode="json"))

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
                async with SessionLocal() as session:
                    try:
                        stored_message = await persist_chat_message(session, event)
                    except PermissionError as exc:
                        await manager.send_to_socket(
                            websocket, ErrorEvent(detail=str(exc)).model_dump()
                        )
                        continue

                outbound_event = event.model_copy(
                    update={
                        "message_id": stored_message.message_id,
                        "sent_at": stored_message.sent_at,
                    }
                )
                await manager.publish(outbound_event.model_dump(mode="json"))
                continue

            if isinstance(event, TypingEvent):
                async with SessionLocal() as session:
                    try:
                        await validate_typing_event(session, event)
                    except PermissionError as exc:
                        await manager.send_to_socket(
                            websocket, ErrorEvent(detail=str(exc)).model_dump()
                        )
                        continue

                await manager.publish(event.model_dump(mode="json"))
                continue

            await manager.publish(event.model_dump(mode="json"))
    except WebSocketDisconnect:
        is_last_connection = manager.disconnect(websocket, user_id_str)
        if is_last_connection:
            await set_presence_state(user_id, "offline")
            async with SessionLocal() as session:
                presence_events = await build_presence_events(
                    session, user_id=user_id, state="offline"
                )

            for presence_event in presence_events:
                await manager.publish(presence_event.model_dump(mode="json"))
