from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.security import get_current_user
from app.models.user import User
from app.schemas.chat import ChatHistoryResponse
from app.services.chat import get_recent_messages, user_is_chat_member

router = APIRouter(prefix="/api/chats", tags=["chat"])


@router.get("/{chat_id}/messages", response_model=ChatHistoryResponse)
async def fetch_recent_messages(
    chat_id: UUID,
    limit: int = Query(50, ge=1, le=100),
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
) -> ChatHistoryResponse:
    if not await user_is_chat_member(session, chat_id=chat_id, user_id=current_user.id):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Viewer is not a member of this chat.",
        )

    items = await get_recent_messages(session, chat_id=chat_id, limit=limit)
    return ChatHistoryResponse(items=items)
