from datetime import UTC, datetime
from uuid import UUID

from sqlalchemy import desc, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.runtime_state import get_runtime_value, set_runtime_value
from app.core.security import hash_password
from app.models import Chat, ChatMember, ChatType, Message, User
from app.schemas.chat import (
    BootstrapResponse,
    ChatMessageEvent,
    ChatMessageRecord,
    DemoChatMember,
    DemoChatSummary,
    DemoUserProfile,
    PresenceEvent,
    TypingEvent,
    WebRTCSignalEvent,
)

settings = get_settings()
DEMO_DISPLAY_NAMES = {
    settings.demo_alice_id: "Alice Walker",
    settings.demo_bob_id: "Bob Stone",
}
DEMO_CHAT_NAME = "Engineering Sync"
DEMO_CHAT_SUMMARY = "Encrypted delivery, live presence, and typing signals."
DEMO_PASSWORD = "walkerchat123"


def _naive_utc_now() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)


def _to_naive_utc(value: datetime) -> datetime:
    return value.astimezone(UTC).replace(tzinfo=None) if value.tzinfo else value


def _build_initials(display_name: str) -> str:
    parts = display_name.split()
    return "".join(part[:1] for part in parts[:2]).upper()


def _display_name_for_user(user: User) -> str:
    return DEMO_DISPLAY_NAMES.get(user.id, user.username.replace("_", " ").title())


async def seed_demo_data(session: AsyncSession) -> None:
    known_user_ids = {
        row[0]
        for row in (
            await session.execute(
                select(User.id).where(
                    User.id.in_([settings.demo_alice_id, settings.demo_bob_id])
                )
            )
        ).all()
    }

    if settings.demo_alice_id not in known_user_ids:
        session.add(
            User(
                id=settings.demo_alice_id,
                username="alice",
                password_hash=hash_password(DEMO_PASSWORD),
                identity_key_pub="pending-client-upload",
                signed_prekey_pub="pending-client-upload",
            )
        )

    if settings.demo_bob_id not in known_user_ids:
        session.add(
            User(
                id=settings.demo_bob_id,
                username="bob",
                password_hash=hash_password(DEMO_PASSWORD),
                identity_key_pub="pending-client-upload",
                signed_prekey_pub="pending-client-upload",
            )
        )

    chat_exists = await session.scalar(
        select(Chat.id).where(Chat.id == settings.demo_chat_id)
    )
    if chat_exists is None:
        session.add(Chat(id=settings.demo_chat_id, type=ChatType.DIRECT))

    membership_count = await session.scalar(
        select(func.count())
        .select_from(ChatMember)
        .where(ChatMember.chat_id == settings.demo_chat_id)
    )
    if membership_count == 0:
        session.add_all(
            [
                ChatMember(chat_id=settings.demo_chat_id, user_id=settings.demo_alice_id),
                ChatMember(chat_id=settings.demo_chat_id, user_id=settings.demo_bob_id),
            ]
        )

    await session.commit()


async def user_is_chat_member(
    session: AsyncSession, *, chat_id: UUID, user_id: UUID
) -> bool:
    membership = await session.scalar(
        select(ChatMember.user_id).where(
            ChatMember.chat_id == chat_id,
            ChatMember.user_id == user_id,
        )
    )
    return membership is not None


async def ensure_chat_delivery_allowed(
    session: AsyncSession, *, chat_id: UUID, sender_id: UUID, target_id: UUID
) -> None:
    if not await user_is_chat_member(session, chat_id=chat_id, user_id=sender_id):
        raise PermissionError("Sender is not a member of this chat.")

    if not await user_is_chat_member(session, chat_id=chat_id, user_id=target_id):
        raise PermissionError("Target user is not a member of this chat.")


async def persist_chat_message(
    session: AsyncSession, event: ChatMessageEvent
) -> ChatMessageRecord:
    await ensure_chat_delivery_allowed(
        session,
        chat_id=event.chat_id,
        sender_id=event.sender_id,
        target_id=event.target_id,
    )

    message = Message(
        chat_id=event.chat_id,
        sender_id=event.sender_id,
        encrypted_payload=event.ciphertext,
        is_media=event.is_media,
        sent_at=_to_naive_utc(event.sent_at or _naive_utc_now()),
    )
    session.add(message)
    await session.commit()
    await session.refresh(message)

    return ChatMessageRecord(
        message_id=message.id,
        chat_id=message.chat_id,
        sender_id=message.sender_id,
        ciphertext=message.encrypted_payload,
        status=message.status.value,
        is_media=message.is_media,
        sent_at=message.sent_at,
    )


async def get_recent_messages(
    session: AsyncSession, *, chat_id: UUID, limit: int
) -> list[ChatMessageRecord]:
    rows = (
        (
            await session.execute(
                select(Message)
                .where(Message.chat_id == chat_id)
                .order_by(desc(Message.sent_at), desc(Message.id))
                .limit(limit)
            )
        )
        .scalars()
        .all()
    )

    return [
        ChatMessageRecord(
            message_id=message.id,
            chat_id=message.chat_id,
            sender_id=message.sender_id,
            ciphertext=message.encrypted_payload,
            status=message.status.value,
            is_media=message.is_media,
            sent_at=message.sent_at,
        )
        for message in reversed(rows)
    ]


async def validate_typing_event(session: AsyncSession, event: TypingEvent) -> None:
    await ensure_chat_delivery_allowed(
        session,
        chat_id=event.chat_id,
        sender_id=event.sender_id,
        target_id=event.target_id,
    )


async def validate_webrtc_event(session: AsyncSession, event: WebRTCSignalEvent) -> None:
    """Stop call signals from reaching users who do not share the chat.

    Without this, any authenticated socket could push an offer at any user id
    and force their client to ring.
    """
    await ensure_chat_delivery_allowed(
        session,
        chat_id=event.chat_id,
        sender_id=event.sender_id,
        target_id=event.target_id,
    )


async def get_bootstrap_data(session: AsyncSession) -> BootstrapResponse:
    users = (
        (
            await session.execute(
                select(User)
                .where(User.id.in_([settings.demo_alice_id, settings.demo_bob_id]))
                .order_by(User.username.asc())
            )
        )
        .scalars()
        .all()
    )

    members = [
        DemoChatMember(
            user_id=user.id,
            username=user.username,
            display_name=_display_name_for_user(user),
            initials=_build_initials(_display_name_for_user(user)),
            presence_state=(
                "online"
                if await get_runtime_value(f"presence:{user.id}") == "online"
                else "offline"
            ),
        )
        for user in users
    ]

    return BootstrapResponse(
        users=[
            DemoUserProfile(
                id=user.id,
                username=user.username,
                display_name=_display_name_for_user(user),
                initials=_build_initials(_display_name_for_user(user)),
                presence_state=(
                    "online"
                    if await get_runtime_value(f"presence:{user.id}") == "online"
                    else "offline"
                ),
            )
            for user in users
        ],
        chats=[
            DemoChatSummary(
                id=settings.demo_chat_id,
                name=DEMO_CHAT_NAME,
                type=ChatType.DIRECT.value,
                summary=DEMO_CHAT_SUMMARY,
                members=members,
            )
        ],
    )


async def build_presence_events(
    session: AsyncSession, *, user_id: UUID, state: str
) -> list[PresenceEvent]:
    peer_rows = (
        await session.execute(
            select(ChatMember.chat_id, ChatMember.user_id).where(
                ChatMember.chat_id.in_(
                    select(ChatMember.chat_id).where(ChatMember.user_id == user_id)
                ),
                ChatMember.user_id != user_id,
            )
        )
    ).all()

    return [
        PresenceEvent(
            type="presence",
            chat_id=chat_id,
            user_id=user_id,
            target_id=target_id,
            state=state,
            sent_at=datetime.now(UTC),
        )
        for chat_id, target_id in peer_rows
    ]


async def set_presence_state(user_id: UUID, state: str) -> None:
    await set_runtime_value(f"presence:{user_id}", state)
