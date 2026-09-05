"""
X3DH key distribution.

The server is a key *directory*, not a trust anchor. It stores and hands out public key
material, and it cannot be relied upon to be honest about it: the client verifies the
signed prekey signature against the identity key itself, and surfaces identity-key
changes to the user through safety numbers. Everything here is structural validation and
bookkeeping, not a security boundary.

That is why this module does not verify XEdDSA signatures server-side. It would catch
buggy clients but protect nothing against a malicious server, and the client must verify
regardless. What the server *can* usefully do is refuse to store material that is
structurally impossible, and make identity-key changes visible rather than silent.
"""

import base64
import binascii
from datetime import UTC, datetime
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.database import get_db
from app.core.rate_limit import enforce_key_claim_rate_limit
from app.core.security import get_current_user
from app.models.prekey import OneTimePreKey
from app.models.user import User

router = APIRouter(prefix="/api/keys", tags=["keys"])
settings = get_settings()

# X25519 public keys are 32 bytes; XEdDSA signatures are 64.
PUBLIC_KEY_BYTES = 32
SIGNATURE_BYTES = 64


def _naive_utc_now() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)


def _validate_base64(value: str, expected_bytes: int, label: str) -> str:
    """
    Reject anything that is not base64 of exactly the right length.

    The previous check accepted any non-blank string between 16 and 4096 characters,
    which is how a literal "pending-client-upload" sentinel ended up living in a
    public-key column.
    """
    stripped = value.strip()
    try:
        decoded = base64.b64decode(stripped, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise ValueError(f"{label} must be valid base64.") from exc

    if len(decoded) != expected_bytes:
        raise ValueError(
            f"{label} must decode to exactly {expected_bytes} bytes, got {len(decoded)}."
        )
    return stripped


class SignedPreKeyPayload(BaseModel):
    key_id: str = Field(min_length=1, max_length=128)
    public_key: str
    signature: str

    @field_validator("public_key")
    @classmethod
    def check_public_key(cls, value: str) -> str:
        return _validate_base64(value, PUBLIC_KEY_BYTES, "Signed prekey")

    @field_validator("signature")
    @classmethod
    def check_signature(cls, value: str) -> str:
        return _validate_base64(value, SIGNATURE_BYTES, "Signed prekey signature")


class OneTimePreKeyPayload(BaseModel):
    key_id: str = Field(min_length=1, max_length=128)
    public_key: str

    @field_validator("public_key")
    @classmethod
    def check_public_key(cls, value: str) -> str:
        return _validate_base64(value, PUBLIC_KEY_BYTES, "One-time prekey")


class PublishKeysRequest(BaseModel):
    identity_key: str
    signed_prekey: SignedPreKeyPayload
    one_time_prekeys: list[OneTimePreKeyPayload] = Field(default_factory=list, max_length=100)

    @field_validator("identity_key")
    @classmethod
    def check_identity_key(cls, value: str) -> str:
        return _validate_base64(value, PUBLIC_KEY_BYTES, "Identity key")


class PublishKeysResponse(BaseModel):
    identity_changed: bool
    one_time_prekeys_stored: int


class UploadOPKsRequest(BaseModel):
    prekeys: list[OneTimePreKeyPayload] = Field(min_length=1, max_length=100)


class PreKeyCountResponse(BaseModel):
    remaining: int
    low_water: int
    should_replenish: bool


class PreKeyBundleResponse(BaseModel):
    user_id: str
    identity_key: str
    identity_key_changed_at: datetime | None
    signed_prekey_id: str
    signed_prekey: str
    signed_prekey_signature: str
    one_time_prekey_id: str | None = None
    one_time_prekey: str | None = None


@router.post("/publish", response_model=PublishKeysResponse)
async def publish_keys(
    body: PublishKeysRequest,
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
) -> PublishKeysResponse:
    """
    Publish identity key, signed prekey and an initial batch of one-time prekeys.

    Re-publishing a *different* identity key is a reinstall, not an error, and is
    accepted -- the server cannot tell a legitimate reinstall from an attacker with the
    account password. What it must not do is hide it: the change is timestamped and
    reported in every subsequent bundle, so peers can raise a safety-number warning.
    """
    identity_changed = (
        current_user.identity_key_pub is not None
        and current_user.identity_key_pub != body.identity_key
    )

    if identity_changed or current_user.identity_key_pub is None:
        current_user.identity_key_changed_at = _naive_utc_now()

    current_user.identity_key_pub = body.identity_key
    current_user.signed_prekey_id = body.signed_prekey.key_id
    current_user.signed_prekey_pub = body.signed_prekey.public_key
    current_user.signed_prekey_sig = body.signed_prekey.signature
    current_user.signed_prekey_created_at = _naive_utc_now()

    if identity_changed:
        # Prekeys published under the old identity are worthless: their private halves
        # belong to a device that no longer holds this identity.
        await session.execute(
            delete(OneTimePreKey).where(OneTimePreKey.user_id == current_user.id)
        )

    stored = await _store_one_time_prekeys(session, current_user, body.one_time_prekeys)
    await session.commit()

    return PublishKeysResponse(identity_changed=identity_changed, one_time_prekeys_stored=stored)


@router.post("/signed-prekey", status_code=status.HTTP_200_OK)
async def rotate_signed_prekey(
    body: SignedPreKeyPayload,
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
) -> dict:
    """Rotate the signed prekey. The identity key is untouched."""
    if current_user.identity_key_pub is None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Publish an identity key before rotating a signed prekey.",
        )

    current_user.signed_prekey_id = body.key_id
    current_user.signed_prekey_pub = body.public_key
    current_user.signed_prekey_sig = body.signature
    current_user.signed_prekey_created_at = _naive_utc_now()
    await session.commit()

    return {"status": "rotated", "signed_prekey_id": body.key_id}


@router.post("/opks", status_code=status.HTTP_201_CREATED)
async def upload_opks(
    body: UploadOPKsRequest,
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
) -> dict:
    """Top up the one-time prekey pool."""
    stored = await _store_one_time_prekeys(session, current_user, body.prekeys)
    await session.commit()
    return {"uploaded": stored}


@router.get("/opks/count", response_model=PreKeyCountResponse)
async def count_opks(
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
) -> PreKeyCountResponse:
    """Lets the client replenish before the pool runs dry."""
    remaining = await session.scalar(
        select(func.count())
        .select_from(OneTimePreKey)
        .where(OneTimePreKey.user_id == current_user.id)
    )
    remaining = int(remaining or 0)
    return PreKeyCountResponse(
        remaining=remaining,
        low_water=settings.one_time_prekey_low_water,
        should_replenish=remaining < settings.one_time_prekey_low_water,
    )


@router.post("/{target_user_id}/bundle", response_model=PreKeyBundleResponse)
async def claim_prekey_bundle(
    target_user_id: UUID,
    request: Request,
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
) -> PreKeyBundleResponse:
    """
    Claim a prekey bundle for a target user (X3DH initiator side).

    This is a POST because it *consumes* a one-time prekey. It used to be a GET that
    mutated state, which meant any prefetch, retry or crawler silently burned prekeys.
    It is also rate limited per requester, since each call permanently removes one of
    the target's prekeys.
    """
    await enforce_key_claim_rate_limit(request, str(current_user.id))

    target = await session.get(User, target_user_id)
    if target is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Target user not found.",
        )

    if not target.has_published_keys:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Target user has not published key material yet.",
        )

    one_time_prekey_id, one_time_prekey = await _claim_one_time_prekey(session, target_user_id)

    return PreKeyBundleResponse(
        user_id=str(target.id),
        identity_key=target.identity_key_pub,
        identity_key_changed_at=target.identity_key_changed_at,
        signed_prekey_id=target.signed_prekey_id,
        signed_prekey=target.signed_prekey_pub,
        signed_prekey_signature=target.signed_prekey_sig,
        one_time_prekey_id=one_time_prekey_id,
        one_time_prekey=one_time_prekey,
    )


async def _claim_one_time_prekey(
    session: AsyncSession, target_user_id: UUID
) -> tuple[str | None, str | None]:
    """
    Atomically remove one unused prekey and return it.

    A single DELETE ... RETURNING over a locked subquery. The previous select-then-update
    was a race: two concurrent initiators could read the same row and both be handed the
    same "one-time" prekey, which destroys the forward secrecy it exists to provide.
    SKIP LOCKED makes concurrent claimers take different rows instead of serialising.
    """
    doomed = (
        select(OneTimePreKey.id)
        .where(OneTimePreKey.user_id == target_user_id)
        .order_by(OneTimePreKey.created_at)
        .limit(1)
        .with_for_update(skip_locked=True)
        .scalar_subquery()
    )

    claimed = await session.execute(
        delete(OneTimePreKey)
        .where(OneTimePreKey.id == doomed)
        .returning(OneTimePreKey.key_id, OneTimePreKey.public_key)
    )
    row = claimed.first()
    await session.commit()

    if row is None:
        # Running dry is expected and must not block the handshake: X3DH simply omits
        # the DH4 term. Forward secrecy for the first message is weaker until the
        # ratchet turns, which is why clients replenish well before this point.
        return None, None
    return row[0], row[1]


async def _store_one_time_prekeys(
    session: AsyncSession, user: User, prekeys: list[OneTimePreKeyPayload]
) -> int:
    """Insert prekeys, ignoring ids the user has already published."""
    if not prekeys:
        return 0

    existing = set(
        (
            await session.scalars(
                select(OneTimePreKey.key_id).where(OneTimePreKey.user_id == user.id)
            )
        ).all()
    )

    current_count = len(existing)
    stored = 0
    for prekey in prekeys:
        if prekey.key_id in existing:
            continue
        if current_count + stored >= settings.one_time_prekey_max_stored:
            break
        session.add(
            OneTimePreKey(
                user_id=user.id,
                key_id=prekey.key_id,
                public_key=prekey.public_key,
            )
        )
        stored += 1

    return stored
