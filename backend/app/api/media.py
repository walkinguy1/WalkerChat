"""Encrypted media upload and retrieval.

The browser encrypts an image with the chat's AES-GCM session key before it
reaches this router, so every byte handled here is ciphertext. The IV and the
original mime type ride inside the encrypted chat message envelope instead of
being stored alongside the blob.
"""

import uuid
from datetime import UTC, datetime

from fastapi import APIRouter, Depends, File, HTTPException, Path, UploadFile, status
from fastapi.responses import Response
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.database import get_db
from app.core.runtime_state import increment_with_ttl
from app.core.security import get_current_user
from app.core.storage import (
    delete_encrypted_object,
    get_encrypted_object,
    put_encrypted_object,
)
from app.models.media import MediaObject
from app.models.user import User
from app.schemas.media import MediaUploadResponse
from app.services.chat import user_is_chat_member

router = APIRouter(prefix="/api/media", tags=["media"])
settings = get_settings()

# The client adds a 12-byte IV and a 16-byte GCM tag, so allow a little
# headroom above the configured plaintext ceiling.
_CIPHERTEXT_OVERHEAD_BYTES = 64


async def _enforce_upload_rate_limit(user_id: uuid.UUID) -> None:
    attempts = await increment_with_ttl(
        f"media-upload:{user_id}", settings.media_rate_limit_window_seconds
    )
    if attempts > settings.media_rate_limit_uploads:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Too many uploads. Wait a moment before sending more photos.",
        )


@router.post(
    "/{chat_id}/upload",
    response_model=MediaUploadResponse,
    status_code=status.HTTP_201_CREATED,
)
async def upload_encrypted_media(
    chat_id: uuid.UUID = Path(...),
    file: UploadFile = File(...),
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
) -> MediaUploadResponse:
    if not await user_is_chat_member(session, chat_id=chat_id, user_id=current_user.id):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Uploader is not a member of this chat.",
        )

    await _enforce_upload_rate_limit(current_user.id)

    max_bytes = settings.media_max_bytes + _CIPHERTEXT_OVERHEAD_BYTES
    payload = await file.read(max_bytes + 1)

    if not payload:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Uploaded media was empty.",
        )

    if len(payload) > max_bytes:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail=(
                f"Media exceeds the {settings.media_max_bytes // (1024 * 1024)}MB limit."
            ),
        )

    media_id = uuid.uuid4()
    object_key = f"{chat_id}/{media_id}.bin"

    try:
        await put_encrypted_object(object_key, payload)
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Encrypted media storage is unavailable.",
        ) from exc

    record = MediaObject(
        id=media_id,
        chat_id=chat_id,
        uploader_id=current_user.id,
        object_key=object_key,
        size_bytes=len(payload),
        created_at=datetime.now(UTC).replace(tzinfo=None),
    )

    try:
        session.add(record)
        await session.commit()
        await session.refresh(record)
    except Exception:
        # Do not leave an unreferenced blob behind if the row never landed.
        await session.rollback()
        await delete_encrypted_object(object_key)
        raise

    return MediaUploadResponse(
        media_id=record.id,
        chat_id=record.chat_id,
        size_bytes=record.size_bytes,
        created_at=record.created_at,
    )


@router.get("/{media_id}")
async def download_encrypted_media(
    media_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
) -> Response:
    record = await session.get(MediaObject, media_id)
    if record is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Media not found.",
        )

    if not await user_is_chat_member(
        session, chat_id=record.chat_id, user_id=current_user.id
    ):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Viewer is not a member of this chat.",
        )

    try:
        payload = await get_encrypted_object(record.object_key)
    except KeyError as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Media blob is missing from storage.",
        ) from exc
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Encrypted media storage is unavailable.",
        ) from exc

    return Response(
        content=payload,
        media_type="application/octet-stream",
        headers={"Cache-Control": "private, max-age=3600"},
    )
