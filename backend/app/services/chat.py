from datetime import UTC, datetime
from uuid import UUID

from sqlalchemy import desc, func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.runtime_state import get_runtime_value, set_runtime_value
from app.core.security import hash_password
from app.models import Chat, ChatMember, ChatType, Device, Message, MessageEnvelope, User
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


def build_initials(display_name: str) -> str:
    parts = display_name.split()
    return "".join(part[:1] for part in parts[:2]).upper()


def display_name_for_user(user: User) -> str:
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
            )
        )

    if settings.demo_bob_id not in known_user_ids:
        session.add(
            User(
                id=settings.demo_bob_id,
                username="bob",
                password_hash=hash_password(DEMO_PASSWORD),
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


async def chat_member_ids(session: AsyncSession, chat_id: UUID) -> set[str]:
    """Everyone in a chat, as strings, ready to be used as a recipient set."""
    rows = await session.scalars(
        select(ChatMember.user_id).where(ChatMember.chat_id == chat_id)
    )
    return {str(user_id) for user_id in rows}


async def ensure_chat_delivery_allowed(
    session: AsyncSession, *, chat_id: UUID, sender_id: UUID
) -> None:
    """
    Membership is the whole authorisation rule.

    This used to also require a single named target that had to be a member, which
    quietly capped every chat at two participants. Delivery now fans out to the chat's
    membership, so the only question worth asking is whether the sender belongs to it.
    """
    if not await user_is_chat_member(session, chat_id=chat_id, user_id=sender_id):
        raise PermissionError("Sender is not a member of this chat.")


async def ensure_directed_delivery_allowed(
    session: AsyncSession, *, chat_id: UUID, sender_id: UUID, target_id: UUID
) -> None:
    """
    Both ends must belong to the chat.

    Used for call signalling, which really is addressed to one person, unlike messages
    and typing which fan out to the whole membership.
    """
    await ensure_chat_delivery_allowed(session, chat_id=chat_id, sender_id=sender_id)

    if not await user_is_chat_member(session, chat_id=chat_id, user_id=target_id):
        raise PermissionError("Target user is not a member of this chat.")


GROUP_ENVELOPE_KEY = "*"


def _to_record(message: Message, ciphertext: str) -> ChatMessageRecord:
    return ChatMessageRecord(
        message_id=message.id,
        chat_id=message.chat_id,
        sender_id=message.sender_id,
        sender_device_row_id=(
            str(message.sender_device_id) if message.sender_device_id else None
        ),
        ciphertext=ciphertext,
        status=message.status.value,
        is_media=message.is_media,
        sent_at=message.sent_at,
        client_message_id=message.client_message_id,
    )


async def _resolve_device_rows(session: AsyncSession, keys: list[str]) -> set[UUID]:
    """Keep only envelope keys that name a real device."""
    candidates = []
    for key in keys:
        if key == GROUP_ENVELOPE_KEY:
            continue
        try:
            candidates.append(UUID(key))
        except ValueError:
            continue

    if not candidates:
        return set()

    return set(
        (await session.scalars(select(Device.id).where(Device.id.in_(candidates)))).all()
    )


async def persist_chat_message(
    session: AsyncSession, event: ChatMessageEvent
) -> Message:
    """
    Store one message and its per-device envelopes.

    Returns the Message rather than a record, because there is no single ciphertext to
    report any more: what each recipient sees depends on which device is asking.
    """
    await ensure_chat_delivery_allowed(
        session, chat_id=event.chat_id, sender_id=event.sender_id
    )

    if not event.envelopes:
        raise PermissionError("A message must carry at least one envelope.")

    sender_device = None
    if event.sender_device_id:
        sender_device = await session.scalar(
            select(Device).where(
                Device.user_id == event.sender_id,
                Device.device_id == event.sender_device_id,
            )
        )

    is_group_envelope = GROUP_ENVELOPE_KEY in event.envelopes
    known_devices = await _resolve_device_rows(session, list(event.envelopes))

    if not is_group_envelope and not known_devices:
        raise PermissionError("No envelope addressed to a known device.")

    message = Message(
        chat_id=event.chat_id,
        sender_id=event.sender_id,
        sender_device_id=sender_device.id if sender_device else None,
        client_message_id=str(event.client_message_id),
        is_media=event.is_media,
        # Server-stamped. The client's own clock is not trusted for ordering: a skewed
        # or hostile clock could otherwise insert messages anywhere in history.
        sent_at=_naive_utc_now(),
    )
    session.add(message)

    try:
        await session.flush()
    except IntegrityError:
        # A resend of a message we already stored, typically after a socket reconnect
        # dropped the acknowledgement. Return the original row rather than writing a
        # duplicate, which the recipient's ratchet would reject as a replay.
        await session.rollback()
        existing = await session.scalar(
            select(Message).where(
                Message.chat_id == event.chat_id,
                Message.client_message_id == str(event.client_message_id),
            )
        )
        if existing is None:
            raise
        return existing

    for key, ciphertext in event.envelopes.items():
        if key == GROUP_ENVELOPE_KEY:
            session.add(
                MessageEnvelope(
                    message_id=message.id,
                    recipient_device_id=None,
                    encrypted_payload=ciphertext,
                )
            )
            continue

        try:
            device_row_id = UUID(key)
        except ValueError:
            continue
        if device_row_id not in known_devices:
            continue

        session.add(
            MessageEnvelope(
                message_id=message.id,
                recipient_device_id=device_row_id,
                encrypted_payload=ciphertext,
            )
        )

    await session.commit()
    await session.refresh(message)
    return message


async def sender_device_row_id(message: Message) -> str | None:
    """The server-resolved device row for a stored message, as a string."""
    return str(message.sender_device_id) if message.sender_device_id else None


async def get_recent_messages(
    session: AsyncSession, *, chat_id: UUID, limit: int, device_row_id: UUID | None
) -> list[ChatMessageRecord]:
    """
    Recent history, resolved for one device.

    Each message contributes at most one envelope: the one addressed to this device, or
    the shared group envelope. A message with neither is skipped -- it was sent before
    this device existed, and nothing here can decrypt it.
    """
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

    if not rows:
        return []

    message_ids = [message.id for message in rows]
    envelope_rows = (
        await session.execute(
            select(MessageEnvelope).where(MessageEnvelope.message_id.in_(message_ids))
        )
    ).scalars().all()

    by_message: dict[UUID, dict[UUID | None, str]] = {}
    for envelope in envelope_rows:
        by_message.setdefault(envelope.message_id, {})[envelope.recipient_device_id] = (
            envelope.encrypted_payload
        )

    records: list[ChatMessageRecord] = []
    for message in reversed(rows):
        envelopes = by_message.get(message.id, {})
        ciphertext = envelopes.get(device_row_id) if device_row_id else None
        if ciphertext is None:
            ciphertext = envelopes.get(None)
        if ciphertext is None:
            continue

        records.append(_to_record(message, ciphertext))

    return records


async def envelopes_for_message(
    session: AsyncSession, message_id: UUID
) -> dict[str, str]:
    """Every envelope for one message, keyed as the wire format expects."""
    rows = (
        await session.scalars(
            select(MessageEnvelope).where(MessageEnvelope.message_id == message_id)
        )
    ).all()

    return {
        (GROUP_ENVELOPE_KEY if row.recipient_device_id is None else str(row.recipient_device_id)): row.encrypted_payload
        for row in rows
    }


async def validate_typing_event(session: AsyncSession, event: TypingEvent) -> None:
    await ensure_chat_delivery_allowed(
        session, chat_id=event.chat_id, sender_id=event.sender_id
    )


async def validate_webrtc_event(session: AsyncSession, event: WebRTCSignalEvent) -> None:
    """Stop call signals from reaching users who do not share the chat.

    Without this, any authenticated socket could push an offer at any user id
    and force their client to ring.
    """
    await ensure_directed_delivery_allowed(
        session,
        chat_id=event.chat_id,
        sender_id=event.sender_id,
        target_id=event.target_id,
    )


def chat_display_name(chat: Chat, members: list[DemoChatMember], viewer_id: UUID) -> str:
    """A group uses its own name; a direct chat is named after the other person."""
    if chat.type == ChatType.GROUP:
        return chat.name or "Group"

    others = [member for member in members if member.user_id != viewer_id]
    return others[0].display_name if others else "Saved messages"


async def presence_of(user_id: UUID) -> str:
    state = await get_runtime_value("presence:" + str(user_id))
    return "online" if state == "online" else "offline"


async def get_bootstrap_data(session: AsyncSession, viewer: User) -> BootstrapResponse:
    """
    Everything the client needs to render its chat list.

    This used to return two hardcoded demo users and one hardcoded chat summary, so a
    chat a user actually created could never appear in the sidebar. It is now a real
    query over the viewer's memberships.
    """
    chat_ids = list(
        (
            await session.scalars(
                select(ChatMember.chat_id).where(ChatMember.user_id == viewer.id)
            )
        ).all()
    )

    if not chat_ids:
        profile = DemoUserProfile(
            id=viewer.id,
            username=viewer.username,
            display_name=display_name_for_user(viewer),
            initials=build_initials(display_name_for_user(viewer)),
            presence_state=await presence_of(viewer.id),
        )
        return BootstrapResponse(users=[profile], chats=[])

    chats = list((await session.scalars(select(Chat).where(Chat.id.in_(chat_ids)))).all())

    membership_rows = (
        await session.execute(
            select(ChatMember.chat_id, User)
            .join(User, User.id == ChatMember.user_id)
            .where(ChatMember.chat_id.in_(chat_ids))
        )
    ).all()

    everyone: dict[UUID, User] = {viewer.id: viewer}
    members_by_chat: dict[UUID, list[User]] = {chat_id: [] for chat_id in chat_ids}
    for chat_id, user in membership_rows:
        members_by_chat[chat_id].append(user)
        everyone[user.id] = user

    presence = {user_id: await presence_of(user_id) for user_id in everyone}

    def to_member(user: User) -> DemoChatMember:
        display_name = display_name_for_user(user)
        return DemoChatMember(
            user_id=user.id,
            username=user.username,
            display_name=display_name,
            initials=build_initials(display_name),
            presence_state=presence[user.id],
        )

    summaries: list[DemoChatSummary] = []
    for chat in chats:
        members = [to_member(user) for user in members_by_chat.get(chat.id, [])]
        is_group = chat.type == ChatType.GROUP
        summaries.append(
            DemoChatSummary(
                id=chat.id,
                name=chat_display_name(chat, members, viewer.id),
                type=chat.type.value,
                kind="room" if is_group else "direct",
                member_count=len(members),
                summary=(str(len(members)) + " members") if is_group else "Direct message",
                members=members,
            )
        )

    summaries.sort(key=lambda summary: summary.name.lower())

    return BootstrapResponse(
        users=[
            DemoUserProfile(
                id=user.id,
                username=user.username,
                display_name=display_name_for_user(user),
                initials=build_initials(display_name_for_user(user)),
                presence_state=presence[user.id],
            )
            for user in sorted(everyone.values(), key=lambda user: user.username)
        ],
        chats=summaries,
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
