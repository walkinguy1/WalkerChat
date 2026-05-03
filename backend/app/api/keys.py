from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.security import get_current_user
from app.models.prekey import OneTimePreKey
from app.models.user import User

router = APIRouter(prefix="/api/keys", tags=["keys"])


class PrekeyBundleResponse(BaseModel):
    user_id: str
    identity_key_pub: str
    signed_prekey_pub: str
    one_time_prekey: str | None = None
    one_time_prekey_id: str | None = None


class UploadOPKsRequest(BaseModel):
    prekeys: list[dict]  # [{key_id: str, public_key: str}, ...]


@router.get("/{target_user_id}/bundle", response_model=PrekeyBundleResponse)
async def get_prekey_bundle(
    target_user_id: UUID,
    _current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
) -> PrekeyBundleResponse:
    """Fetch a prekey bundle for a target user (X3DH initiator side)."""
    target = await session.get(User, target_user_id)
    if target is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Target user not found.",
        )

    # Get an unused OPK if available
    opk = await session.scalar(
        select(OneTimePreKey)
        .where(OneTimePreKey.user_id == target_user_id, OneTimePreKey.used == False)  # noqa: E712
        .limit(1)
    )

    one_time_prekey = None
    one_time_prekey_id = None
    if opk is not None:
        one_time_prekey = opk.public_key
        one_time_prekey_id = opk.key_id
        # Mark as used
        await session.execute(
            update(OneTimePreKey)
            .where(OneTimePreKey.id == opk.id)
            .values(used=True)
        )
        await session.commit()

    return PrekeyBundleResponse(
        user_id=str(target.id),
        identity_key_pub=target.identity_key_pub,
        signed_prekey_pub=target.signed_prekey_pub,
        one_time_prekey=one_time_prekey,
        one_time_prekey_id=one_time_prekey_id,
    )


@router.post("/opks", status_code=status.HTTP_201_CREATED)
async def upload_opks(
    body: UploadOPKsRequest,
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
) -> dict:
    """Upload a batch of one-time prekeys."""
    for pk in body.prekeys:
        session.add(
            OneTimePreKey(
                user_id=current_user.id,
                key_id=pk["key_id"],
                public_key=pk["public_key"],
            )
        )
    await session.commit()
    return {"uploaded": len(body.prekeys)}


@router.put("/identity", status_code=status.HTTP_200_OK)
async def update_identity_keys(
    body: dict,
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
) -> dict:
    """Update identity and signed prekeys for the current user."""
    if "identity_key_pub" in body:
        current_user.identity_key_pub = body["identity_key_pub"]
    if "signed_prekey_pub" in body:
        current_user.signed_prekey_pub = body["signed_prekey_pub"]
    await session.commit()
    return {"status": "updated"}
