from io import BytesIO
from types import SimpleNamespace
from unittest.mock import AsyncMock
from uuid import uuid4

import pytest
from fastapi import HTTPException, UploadFile

from app.models.chat import Chat, ChatType
from app.models.user import User
from app.api.keys import _may_discover_user
from app.api import chats as chats_api
from app.api import media as media_api
from app.services.chat import ensure_chat_delivery_allowed
from app.services.chat_admin import (
    can_administer_group,
    request_contact,
    users_block_each_other,
)


async def test_contact_request_rejects_self_without_database_access() -> None:
    user_id = uuid4()
    session = AsyncMock()
    with pytest.raises(ValueError, match="yourself"):
        await request_contact(session, requester_id=user_id, target_id=user_id)
    session.get.assert_not_awaited()
    session.commit.assert_not_awaited()


async def test_group_creator_must_still_be_a_member_to_administer() -> None:
    creator_id = uuid4()
    chat = Chat(id=uuid4(), type=ChatType.GROUP, created_by=creator_id)
    session = AsyncMock()
    session.scalar.return_value = None
    assert not await can_administer_group(session, chat, creator_id)


async def test_group_role_authorization_requires_owner_or_admin() -> None:
    creator_id, admin_id, member_id = uuid4(), uuid4(), uuid4()
    chat = Chat(id=uuid4(), type=ChatType.GROUP, created_by=creator_id)
    session = AsyncMock()
    session.scalar.side_effect = [creator_id, admin_id, None]
    assert await can_administer_group(session, chat, creator_id)
    assert await can_administer_group(session, chat, admin_id)
    assert not await can_administer_group(session, chat, member_id)


async def test_direct_chat_block_prevents_future_messages() -> None:
    chat_id, sender_id, peer_id = uuid4(), uuid4(), uuid4()
    session = AsyncMock()
    session.scalar.side_effect = [sender_id, sender_id]
    session.get.return_value = Chat(id=chat_id, type=ChatType.DIRECT)
    session.scalars.return_value = SimpleNamespace(all=lambda: [sender_id, peer_id])
    with pytest.raises(PermissionError, match="Messages are disabled"):
        await ensure_chat_delivery_allowed(session, chat_id=chat_id, sender_id=sender_id)


async def test_block_check_is_directional_in_storage_but_pair_wide_in_effect() -> None:
    left, right = uuid4(), uuid4()
    session = AsyncMock()
    session.scalar.return_value = left
    assert await users_block_each_other(session, left, right)
    query = str(session.scalar.await_args.args[0])
    assert "contact_blocks.blocker_id" in query
    assert "contact_blocks.blocked_id" in query


async def test_key_discovery_is_limited_to_contacts_or_shared_chat_members() -> None:
    requester_id, target_id = uuid4(), uuid4()
    requester = User(id=requester_id, username="requester")
    session = AsyncMock()
    session.scalar.side_effect = [None, None]
    session.get.return_value = object()
    assert await _may_discover_user(session, requester, target_id)

    session = AsyncMock()
    session.scalar.side_effect = [None, target_id]
    session.get.return_value = None
    assert await _may_discover_user(session, requester, target_id)

    session = AsyncMock()
    session.scalar.side_effect = [requester_id, None]
    assert not await _may_discover_user(session, requester, target_id)

    session = AsyncMock()
    session.scalar.side_effect = [requester_id, uuid4()]
    assert await _may_discover_user(session, requester, target_id)


async def test_non_admin_cannot_add_group_member_at_api_boundary(monkeypatch) -> None:
    chat_id, owner_id, member_id, target_id = uuid4(), uuid4(), uuid4(), uuid4()
    chat = Chat(id=chat_id, type=ChatType.GROUP, created_by=owner_id)
    session = AsyncMock()
    session.scalar.side_effect = [member_id, None]
    session.get.return_value = chat
    monkeypatch.setattr(chats_api, "_contact_rate_limit", AsyncMock())
    monkeypatch.setattr(chats_api, "add_chat_member", AsyncMock())

    with pytest.raises(HTTPException) as error:
        await chats_api.add_member(
            chat_id,
            chats_api.AddMemberRequest(user_id=target_id),
            SimpleNamespace(client=SimpleNamespace(host="test")),
            User(id=member_id, username="member"),
            session,
        )

    assert error.value.status_code == 403
    chats_api.add_chat_member.assert_not_awaited()


async def test_media_upload_rejects_blocked_sender_before_storage(monkeypatch) -> None:
    user = User(id=uuid4(), username="blocked_sender")
    chat_id = uuid4()
    session = AsyncMock()
    monkeypatch.setattr(
        media_api,
        "ensure_chat_delivery_allowed",
        AsyncMock(side_effect=PermissionError("blocked")),
    )
    put_blob = AsyncMock()
    monkeypatch.setattr(media_api, "put_encrypted_object", put_blob)

    with pytest.raises(HTTPException) as error:
        await media_api.upload_encrypted_media(
            chat_id,
            UploadFile(filename="ciphertext.bin", file=BytesIO(b"ciphertext")),
            user,
            session,
        )

    assert error.value.status_code == 403
    put_blob.assert_not_awaited()
