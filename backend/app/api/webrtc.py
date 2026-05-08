import json
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, WebSocket, WebSocketDisconnect, status
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.security import get_ws_user, get_current_user
from app.core.ws_manager import manager
from app.schemas.chat import ErrorEvent, realtime_event_adapter

router = APIRouter()


class WebRTCOfferEvent(BaseModel):
    type: str = Field(default="webrtc_offer")
    chat_id: str
    sender_id: str
    target_id: str
    offer: dict


class WebRTCAnswerEvent(BaseModel):
    type: str = Field(default="webrtc_answer")
    chat_id: str
    sender_id: str
    target_id: str
    answer: dict


class WebRTCIceCandidateEvent(BaseModel):
    type: str = Field(default="webrtc_ice_candidate")
    chat_id: str
    sender_id: str
    target_id: str
    candidate: dict


class WebRTCHangupEvent(BaseModel):
    type: str = Field(default="webrtc_hangup")
    chat_id: str
    sender_id: str
    target_id: str


@router.websocket("/signaling")
async def webrtc_signaling_endpoint(
    websocket: WebSocket,
    user_id: UUID = Depends(get_ws_user),
) -> None:
    """WebSocket endpoint for WebRTC signaling."""
    user_id_str = str(user_id)
    await manager.connect(websocket, user_id_str)

    try:
        while True:
            raw_data = await websocket.receive_text()
            try:
                payload = json.loads(raw_data)
                event_type = payload.get("type")
                
                if event_type not in ["webrtc_offer", "webrtc_answer", "webrtc_ice_candidate", "webrtc_hangup"]:
                    await manager.send_to_socket(
                        websocket, 
                        ErrorEvent(detail="Invalid WebRTC event type.").model_dump()
                    )
                    continue

                # Validate sender identity
                if str(payload.get("sender_id")) != user_id_str:
                    await manager.send_to_socket(
                        websocket,
                        ErrorEvent(detail="Sender identity does not match the socket user.").model_dump(),
                    )
                    continue

                # Route WebRTC events to target user
                target_id = payload.get("target_id")
                if target_id:
                    await manager.send_personal_message(payload, target_id)
                
            except (json.JSONDecodeError, ValueError):
                await manager.send_to_socket(
                    websocket, 
                    ErrorEvent(detail="Invalid WebRTC signaling payload.").model_dump()
                )
                continue

    except WebSocketDisconnect:
        manager.disconnect(websocket, user_id_str)


@router.post("/offer")
async def send_offer(
    offer_data: WebRTCOfferEvent,
    current_user_id: UUID = Depends(get_ws_user),
) -> dict:
    """Send WebRTC offer through WebSocket signaling."""
    if str(offer_data.sender_id) != str(current_user_id):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Sender ID mismatch"
        )
    
    await manager.send_personal_message(offer_data.model_dump(), offer_data.target_id)
    return {"status": "offer_sent"}


@router.post("/answer")
async def send_answer(
    answer_data: WebRTCAnswerEvent,
    current_user_id: UUID = Depends(get_ws_user),
) -> dict:
    """Send WebRTC answer through WebSocket signaling."""
    if str(answer_data.sender_id) != str(current_user_id):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Sender ID mismatch"
        )
    
    await manager.send_personal_message(answer_data.model_dump(), answer_data.target_id)
    return {"status": "answer_sent"}


@router.post("/ice-candidate")
async def send_ice_candidate(
    candidate_data: WebRTCIceCandidateEvent,
    current_user_id: UUID = Depends(get_ws_user),
) -> dict:
    """Send WebRTC ICE candidate through WebSocket signaling."""
    if str(candidate_data.sender_id) != str(current_user_id):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Sender ID mismatch"
        )
    
    await manager.send_personal_message(candidate_data.model_dump(), candidate_data.target_id)
    return {"status": "candidate_sent"}


@router.post("/hangup")
async def send_hangup(
    hangup_data: WebRTCHangupEvent,
    current_user_id: UUID = Depends(get_ws_user),
) -> dict:
    """Send WebRTC hangup signal through WebSocket signaling."""
    if str(hangup_data.sender_id) != str(current_user_id):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Sender ID mismatch"
        )
    
    await manager.send_personal_message(hangup_data.model_dump(), hangup_data.target_id)
    return {"status": "hangup_sent"}
