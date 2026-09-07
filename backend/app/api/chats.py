from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.security import get_current_user
from app.models import Chat, ChatType, Device
from app.models.user import User
from app.schemas.chat import ChatHistoryResponse, DemoUserProfile
from app.services.chat import get_recent_messages, user_is_chat_member
from app.services.chat_admin import (
    add_chat_member,
    create_chat,
    remove_chat_member,
    search_users,
)

router = APIRouter(prefix="/api/chats", tags=["chat"])


class CreateChatRequest(BaseModel):
    type: str = Field(default="DIRECT", pattern="^(DIRECT|GROUP)$")
    name: str | None = Field(default=None, max_length=120)
    member_ids: list[UUID] = Field(default_factory=list, max_length=256)


class CreateChatResponse(BaseModel):
    chat_id: UUID
    type: str


class AddMemberRequest(BaseModel):
    user_id: UUID


async def _member_chat(chat_id: UUID, user: User, session: AsyncSession) -> Chat:
    """Load a chat, refusing anyone who is not a member of it."""
    if not await user_is_chat_member(session, chat_id=chat_id, user_id=user.id):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Viewer is not a member of this chat.",
        )

    chat = await session.get(Chat, chat_id)
    if chat is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Chat not found."
        )
    return chat


@router.get("/{chat_id}/messages", response_model=ChatHistoryResponse)
async def fetch_recent_messages(
    chat_id: UUID,
    device_id: str | None = Query(default=None),
    limit: int = Query(50, ge=1, le=100),
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
) -> ChatHistoryResponse:
    """
    History for one device.

    The device matters: each message is stored as one envelope per recipient device, so
    which ciphertext you get back depends on which installation is asking.
    """
    await _member_chat(chat_id, current_user, session)

    device_row_id = None
    if device_id:
        device = await session.scalar(
            select(Device).where(
                Device.user_id == current_user.id, Device.device_id == device_id
            )
        )
        device_row_id = device.id if device else None

    items = await get_recent_messages(
        session, chat_id=chat_id, limit=limit, device_row_id=device_row_id
    )
    return ChatHistoryResponse(items=items)


@router.post("", response_model=CreateChatResponse, status_code=status.HTTP_201_CREATED)
async def create_new_chat(
    body: CreateChatRequest,
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
) -> CreateChatResponse:
    """Create a direct or group chat. Direct chats are deduplicated by participants."""
    try:
        chat = await create_chat(
            session,
            creator=current_user,
            chat_type=ChatType(body.type),
            name=body.name,
            member_ids=body.member_ids,
        )
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)
        ) from exc

    return CreateChatResponse(chat_id=chat.id, type=chat.type.value)


@router.post("/{chat_id}/members", status_code=status.HTTP_201_CREATED)
async def add_member(
    chat_id: UUID,
    body: AddMemberRequest,
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
) -> dict:
    chat = await _member_chat(chat_id, current_user, session)

    try:
        added = await add_chat_member(session, chat=chat, user_id=body.user_id)
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)
        ) from exc

    return {"added": added}


@router.delete("/{chat_id}/members/{user_id}", status_code=status.HTTP_200_OK)
async def remove_member(
    chat_id: UUID,
    user_id: UUID,
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
) -> dict:
    """
    Remove a member from a group.

    Removal alone does not stop the departing member reading future messages: they still
    hold the sender keys distributed to them. The remaining clients must rotate, which
    is why the response says so explicitly rather than implying the job is done.
    """
    chat = await _member_chat(chat_id, current_user, session)

    try:
        await remove_chat_member(session, chat=chat, user_id=user_id)
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)
        ) from exc

    return {"removed": True, "sender_key_rotation_required": True}


@router.get("/users/search", response_model=list[DemoUserProfile])
async def find_users(
    query: str = Query(min_length=1, max_length=32),
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
) -> list[DemoUserProfile]:
    """Username-prefix search, so a user can find someone to start a chat with."""
    return await search_users(session, query=query, exclude_id=current_user.id)
