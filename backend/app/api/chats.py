from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from pydantic import BaseModel, Field
from sqlalchemy import delete, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.security import get_current_user
from app.models import Chat, ChatType, Device
from app.models.user import User
from app.models.contact import Contact, ContactBlock, ContactRequest
from app.core.runtime_state import increment_with_ttl
from app.schemas.chat import ChatHistoryResponse, DemoUserProfile
from app.services.chat import get_recent_messages, user_is_chat_member
from app.services.chat_admin import (
    add_chat_member,
    block_user,
    can_administer_group,
    create_chat,
    respond_contact_request,
    request_contact,
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


class RenameChatRequest(BaseModel):
    name: str = Field(min_length=1, max_length=120)


class ContactRequestBody(BaseModel):
    user_id: UUID


async def _contact_rate_limit(request: Request, user_id: UUID, action: str) -> None:
    host = request.client.host if request.client else "unknown"
    from app.core.config import get_settings
    config = get_settings()
    attempts = await increment_with_ttl(f"contacts:{action}:{user_id}:{host}", config.auth_rate_limit_window_seconds)
    if attempts > min(config.auth_rate_limit_attempts, 30):
        raise HTTPException(status_code=429, detail="Too many contact actions. Try again later.")


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
    request: Request,
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
) -> dict:
    await _contact_rate_limit(request, current_user.id, "membership")
    chat = await _member_chat(chat_id, current_user, session)
    if not await can_administer_group(session, chat, current_user.id):
        raise HTTPException(status_code=403, detail="Only group owners and admins can manage members.")

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
    request: Request,
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
) -> dict:
    """
    Remove a member from a group.

    Removal alone does not stop the departing member reading future messages: they still
    hold the sender keys distributed to them. The remaining clients must rotate, which
    is why the response says so explicitly rather than implying the job is done.
    """
    await _contact_rate_limit(request, current_user.id, "membership")
    chat = await _member_chat(chat_id, current_user, session)
    if not await can_administer_group(session, chat, current_user.id):
        raise HTTPException(status_code=403, detail="Only group owners and admins can manage members.")

    try:
        await remove_chat_member(session, chat=chat, user_id=user_id)
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)
        ) from exc

    return {"removed": True, "sender_key_rotation_required": True}


@router.patch("/{chat_id}", status_code=status.HTTP_200_OK)
async def rename_group(
    chat_id: UUID,
    body: RenameChatRequest,
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
) -> dict:
    chat = await _member_chat(chat_id, current_user, session)
    if not await can_administer_group(session, chat, current_user.id):
        raise HTTPException(status_code=403, detail="Only group owners and admins can rename this group.")
    chat.name = body.name.strip()
    if not chat.name:
        raise HTTPException(status_code=422, detail="Group name cannot be empty.")
    await session.commit()
    return {"renamed": True, "name": chat.name}


@router.get("/contacts")
async def list_contacts(
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
) -> dict:
    contacts = (await session.execute(select(Contact).where(or_(Contact.user_low_id == current_user.id, Contact.user_high_id == current_user.id)))).scalars().all()
    requests = (await session.execute(select(ContactRequest).where(or_(ContactRequest.target_id == current_user.id, ContactRequest.requester_id == current_user.id), ContactRequest.status == "pending"))).scalars().all()
    blocks = (await session.scalars(select(ContactBlock).where(ContactBlock.blocker_id == current_user.id))).all()
    user_ids = {pair.user_high_id if pair.user_low_id == current_user.id else pair.user_low_id for pair in contacts}
    user_ids.update(row.requester_id if row.target_id == current_user.id else row.target_id for row in requests)
    user_ids.update(row.blocked_id for row in blocks)
    users = (await session.scalars(select(User).where(User.id.in_(user_ids)))).all() if user_ids else []
    profiles = {
        str(user.id): {
            "id": str(user.id),
            "username": user.username,
            "display_name": user.display_name or user.username,
            "initials": "".join(part[:1] for part in (user.display_name or user.username).split()[:2]).upper(),
            "presence_state": "offline",
        }
        for user in users
    }
    return {
        "contacts": [profiles[str(user_id)] for user_id in user_ids if any(user_id in (pair.user_low_id, pair.user_high_id) for pair in contacts)],
        "requests": [{"id": str(row.id), "direction": "incoming" if row.target_id == current_user.id else "outgoing", "user": profiles[str(row.requester_id if row.target_id == current_user.id else row.target_id)]} for row in requests],
        "blocked": [profiles[str(row.blocked_id)] for row in blocks],
    }


@router.post("/contacts/requests", status_code=status.HTTP_201_CREATED)
async def create_contact_request(
    body: ContactRequestBody,
    request: Request,
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
) -> dict:
    await _contact_rate_limit(request, current_user.id, "request")
    try:
        row = await request_contact(session, requester_id=current_user.id, target_id=body.user_id)
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return {"id": str(row.id), "status": row.status}


@router.post("/contacts/requests/{request_id}/{action}", status_code=status.HTTP_200_OK)
async def respond_to_contact_request(
    request_id: UUID,
    action: str,
    request: Request,
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
) -> dict:
    if action not in {"accept", "reject"}:
        raise HTTPException(status_code=404, detail="Not found.")
    await _contact_rate_limit(request, current_user.id, action)
    try:
        await respond_contact_request(session, request_id=request_id, target_id=current_user.id, accept=action == "accept")
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return {"status": action + "ed" if action == "accept" else "rejected"}


@router.post("/contacts/blocks", status_code=status.HTTP_201_CREATED)
async def create_contact_block(
    body: ContactRequestBody,
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
) -> dict:
    try:
        await block_user(session, blocker_id=current_user.id, blocked_id=body.user_id)
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return {"blocked": True}


@router.delete("/contacts/{user_id}", status_code=status.HTTP_200_OK)
async def remove_contact(
    user_id: UUID,
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
) -> dict:
    low, high = sorted((current_user.id, user_id), key=str)
    result = await session.execute(delete(Contact).where(Contact.user_low_id == low, Contact.user_high_id == high))
    await session.commit()
    return {"removed": bool(result.rowcount)}


@router.delete("/contacts/blocks/{user_id}", status_code=status.HTTP_200_OK)
async def remove_contact_block(
    user_id: UUID,
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
) -> dict:
    await session.execute(delete(ContactBlock).where(ContactBlock.blocker_id == current_user.id, ContactBlock.blocked_id == user_id))
    await session.commit()
    return {"blocked": False}


@router.get("/users/search", response_model=list[DemoUserProfile])
async def find_users(
    request: Request,
    query: str = Query(min_length=1, max_length=32),
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
) -> list[DemoUserProfile]:
    """Username-prefix search, so a user can find someone to start a chat with."""
    await _contact_rate_limit(request, current_user.id, "search")
    return await search_users(session, query=query, exclude_id=current_user.id)
