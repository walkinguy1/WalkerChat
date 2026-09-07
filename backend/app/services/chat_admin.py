"""
Chat administration: creating chats, managing membership, and finding people.

None of this existed before. `api/chats.py` held a single history endpoint, so there was
no way to create a chat, add anyone to one, or discover another user -- which is why the
`GROUP` chat type was unreachable in practice.
"""

from uuid import UUID

from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Chat, ChatMember, ChatType, User
from app.schemas.chat import DemoUserProfile
from app.services.chat import (
    build_initials,
    chat_member_ids,
    display_name_for_user,
    presence_of,
    user_is_chat_member,
)


async def create_chat(
    session: AsyncSession,
    *,
    creator: User,
    chat_type: ChatType,
    name: str | None,
    member_ids: list[UUID],
) -> Chat:
    """Create a chat containing the creator plus the named members."""
    participants = {creator.id, *member_ids}

    if chat_type == ChatType.DIRECT and len(participants) != 2:
        raise ValueError("A direct chat needs exactly one other participant.")
    if chat_type == ChatType.GROUP and not name:
        raise ValueError("A group chat needs a name.")

    known = set(
        (await session.scalars(select(User.id).where(User.id.in_(participants)))).all()
    )
    missing = participants - known
    if missing:
        raise ValueError("Unknown user: " + ", ".join(str(user_id) for user_id in missing))

    if chat_type == ChatType.DIRECT:
        # Reuse an existing direct thread rather than creating a second one, which
        # would silently split the same conversation across two chats.
        existing = await _find_direct_chat(session, participants)
        if existing is not None:
            return existing

    chat = Chat(type=chat_type, name=name, created_by=creator.id)
    session.add(chat)
    await session.flush()

    for user_id in participants:
        session.add(
            ChatMember(
                chat_id=chat.id,
                user_id=user_id,
                role="OWNER" if user_id == creator.id else "MEMBER",
            )
        )

    await session.commit()
    await session.refresh(chat)
    return chat


async def _find_direct_chat(session: AsyncSession, participants: set[UUID]) -> Chat | None:
    candidate_ids = (
        await session.scalars(
            select(ChatMember.chat_id)
            .join(Chat, Chat.id == ChatMember.chat_id)
            .where(Chat.type == ChatType.DIRECT, ChatMember.user_id.in_(participants))
            .group_by(ChatMember.chat_id)
            .having(func.count(ChatMember.user_id) == len(participants))
        )
    ).all()

    wanted = {str(user_id) for user_id in participants}
    for chat_id in candidate_ids:
        if await chat_member_ids(session, chat_id) == wanted:
            return await session.get(Chat, chat_id)
    return None


async def add_chat_member(session: AsyncSession, *, chat: Chat, user_id: UUID) -> bool:
    """Add someone to a group. Returns False if they were already a member."""
    if chat.type != ChatType.GROUP:
        raise ValueError("Members can only be added to a group chat.")

    if await user_is_chat_member(session, chat_id=chat.id, user_id=user_id):
        return False

    if await session.get(User, user_id) is None:
        raise ValueError("Unknown user.")

    session.add(ChatMember(chat_id=chat.id, user_id=user_id, role="MEMBER"))
    await session.commit()
    return True


async def remove_chat_member(session: AsyncSession, *, chat: Chat, user_id: UUID) -> None:
    """
    Remove someone from a group.

    The cryptographic half of this happens on the clients: every remaining member has to
    rotate their sender key, or the removed member could still read future messages with
    the chain key they already hold.
    """
    if chat.type != ChatType.GROUP:
        raise ValueError("Members can only be removed from a group chat.")

    await session.execute(
        delete(ChatMember).where(
            ChatMember.chat_id == chat.id, ChatMember.user_id == user_id
        )
    )
    await session.commit()


async def search_users(
    session: AsyncSession, *, query: str, exclude_id: UUID, limit: int = 20
) -> list[DemoUserProfile]:
    """Find people to start a chat with, by username prefix."""
    rows = (
        await session.scalars(
            select(User)
            .where(User.username.ilike(query + "%"), User.id != exclude_id)
            .order_by(User.username.asc())
            .limit(limit)
        )
    ).all()

    profiles = []
    for user in rows:
        display_name = display_name_for_user(user)
        profiles.append(
            DemoUserProfile(
                id=user.id,
                username=user.username,
                display_name=display_name,
                initials=build_initials(display_name),
                presence_state=await presence_of(user.id),
            )
        )
    return profiles
