"""
Chat administration: creating chats, managing membership, and finding people.

None of this existed before. `api/chats.py` held a single history endpoint, so there was
no way to create a chat, add anyone to one, or discover another user -- which is why the
`GROUP` chat type was unreachable in practice.
"""

from uuid import UUID

from sqlalchemy import delete, func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Chat, ChatMember, ChatType, User
from app.models.contact import Contact, ContactBlock, ContactRequest
from app.schemas.chat import DemoUserProfile
from app.services.chat import (
    build_initials,
    chat_member_ids,
    display_name_for_user,
    presence_of,
    user_is_chat_member,
)


def _naive_utc_now():
    from datetime import UTC, datetime
    return datetime.now(UTC).replace(tzinfo=None)


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
    if chat_type == ChatType.GROUP and not member_ids:
        raise ValueError("A group needs at least one other member.")
    if chat_type == ChatType.GROUP and len(name or "") > 120:
        raise ValueError("Group names must be 120 characters or fewer.")

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
        peer_id = next(user_id for user_id in participants if user_id != creator.id)
        if await users_block_each_other(session, creator.id, peer_id):
            raise ValueError("This conversation is unavailable.")
        if not await are_contacts(session, creator.id, peer_id) and not await _is_demo_pair(session, creator.id, peer_id):
            raise ValueError("An accepted contact request is required to start a direct chat.")
    elif chat_type == ChatType.GROUP:
        for user_id in participants - {creator.id}:
            if not await are_contacts(session, creator.id, user_id) and not await _is_demo_pair(session, creator.id, user_id):
                raise ValueError("Group members must be accepted contacts.")

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

    owner_id = await group_owner_id(session, chat)
    if owner_id is None:
        raise ValueError("This group has no configured owner.")
    if await users_block_each_other(session, owner_id, user_id):
        raise ValueError("This conversation is unavailable.")
    if not await are_contacts(session, owner_id, user_id) and not await _is_demo_pair(session, owner_id, user_id):
        raise ValueError("Group members must be accepted contacts of the group owner.")

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

    owner_id = await group_owner_id(session, chat)
    if user_id == owner_id:
        raise ValueError("The group owner cannot be removed.")
    if not await user_is_chat_member(session, chat_id=chat.id, user_id=user_id):
        raise ValueError("User is not a member of this group.")

    await session.execute(
        delete(ChatMember).where(
            ChatMember.chat_id == chat.id, ChatMember.user_id == user_id
        )
    )
    await session.commit()


async def group_owner_id(session: AsyncSession, chat: Chat) -> UUID | None:
    if chat.created_by and await user_is_chat_member(session, chat_id=chat.id, user_id=chat.created_by):
        return chat.created_by
    return await session.scalar(
        select(ChatMember.user_id).where(ChatMember.chat_id == chat.id, ChatMember.role.in_(["OWNER", "ADMIN"])).order_by(ChatMember.role.asc()).limit(1)
    )


async def can_administer_group(session: AsyncSession, chat: Chat, user_id: UUID) -> bool:
    if chat.type != ChatType.GROUP:
        return False
    if chat.created_by == user_id:
        return await user_is_chat_member(session, chat_id=chat.id, user_id=user_id)
    return await session.scalar(
        select(ChatMember.user_id).where(ChatMember.chat_id == chat.id, ChatMember.user_id == user_id, ChatMember.role.in_(["OWNER", "ADMIN"]))
    ) is not None


async def are_contacts(session: AsyncSession, left: UUID, right: UUID) -> bool:
    low, high = sorted((left, right), key=str)
    return await session.get(Contact, {"user_low_id": low, "user_high_id": high}) is not None


async def users_block_each_other(session: AsyncSession, left: UUID, right: UUID) -> bool:
    return await session.scalar(
        select(ContactBlock.blocker_id).where(
            ((ContactBlock.blocker_id == left) & (ContactBlock.blocked_id == right))
            | ((ContactBlock.blocker_id == right) & (ContactBlock.blocked_id == left))
        ).limit(1)
    ) is not None


async def _is_demo_pair(session: AsyncSession, left: UUID, right: UUID) -> bool:
    # Preserve only the explicitly configured two-account development demo.
    from app.core.config import get_settings
    config = get_settings()
    return config.app_env == "development" and {left, right} == {config.demo_alice_id, config.demo_bob_id}


async def request_contact(session: AsyncSession, *, requester_id: UUID, target_id: UUID) -> ContactRequest:
    if requester_id == target_id:
        raise ValueError("You cannot send a contact request to yourself.")
    target = await session.get(User, target_id)
    if target is None:
        raise ValueError("User not found.")
    if await users_block_each_other(session, requester_id, target_id):
        raise ValueError("This contact request is unavailable.")
    if await are_contacts(session, requester_id, target_id):
        raise ValueError("You are already contacts.")
    previous = await session.scalar(select(ContactRequest).where(ContactRequest.requester_id == requester_id, ContactRequest.target_id == target_id, ContactRequest.status == "pending"))
    if previous:
        raise ValueError("A contact request is already pending.")
    reverse = await session.scalar(select(ContactRequest).where(ContactRequest.requester_id == target_id, ContactRequest.target_id == requester_id, ContactRequest.status == "pending"))
    if reverse:
        raise ValueError("Accept the pending request from this user instead.")
    row = await session.scalar(select(ContactRequest).where(ContactRequest.requester_id == requester_id, ContactRequest.target_id == target_id))
    if row is None:
        row = ContactRequest(requester_id=requester_id, target_id=target_id)
        session.add(row)
    else:
        row.status = "pending"
        row.created_at = _naive_utc_now()
    try:
        await session.commit()
    except IntegrityError:
        await session.rollback()
        raise ValueError("A contact request already exists.")
    await session.refresh(row)
    return row


async def respond_contact_request(session: AsyncSession, *, request_id: UUID, target_id: UUID, accept: bool) -> None:
    row = await session.scalar(select(ContactRequest).where(ContactRequest.id == request_id, ContactRequest.target_id == target_id, ContactRequest.status == "pending").with_for_update())
    if row is None:
        raise ValueError("Pending contact request not found.")
    if accept:
        if await users_block_each_other(session, row.requester_id, row.target_id):
            raise ValueError("This contact request is unavailable.")
        low, high = sorted((row.requester_id, row.target_id), key=str)
        session.add(Contact(user_low_id=low, user_high_id=high))
    row.status = "accepted" if accept else "rejected"
    try:
        await session.commit()
    except IntegrityError:
        await session.rollback()
        raise ValueError("Unable to update this contact request.")


async def block_user(session: AsyncSession, *, blocker_id: UUID, blocked_id: UUID) -> None:
    if blocker_id == blocked_id:
        raise ValueError("You cannot block yourself.")
    if await session.get(User, blocked_id) is None:
        raise ValueError("User not found.")
    if await session.get(ContactBlock, {"blocker_id": blocker_id, "blocked_id": blocked_id}) is None:
        session.add(ContactBlock(blocker_id=blocker_id, blocked_id=blocked_id))
    await session.execute(delete(Contact).where(Contact.user_low_id == min(blocker_id, blocked_id, key=str), Contact.user_high_id == max(blocker_id, blocked_id, key=str)))
    await session.execute(delete(ContactRequest).where(((ContactRequest.requester_id == blocker_id) & (ContactRequest.target_id == blocked_id)) | ((ContactRequest.requester_id == blocked_id) & (ContactRequest.target_id == blocker_id)), ContactRequest.status == "pending"))
    try:
        await session.commit()
    except IntegrityError:
        # A concurrent identical block is already the desired state.
        await session.rollback()


async def search_users(
    session: AsyncSession, *, query: str, exclude_id: UUID, limit: int = 20
) -> list[DemoUserProfile]:
    """Find people to start a chat with, by username prefix."""
    query = query.strip().replace("%", "\\%").replace("_", "\\_")
    if len(query) < 2:
        return []
    rows = (
        await session.scalars(
            select(User)
            .where(User.username_normalized.ilike(query.lower() + "%", escape="\\"), User.id != exclude_id)
            .order_by(User.username_normalized.asc())
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
