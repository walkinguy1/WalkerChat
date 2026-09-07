"""
X3DH key distribution, per device.

The server is a key *directory*, not a trust anchor. It stores and hands out public key
material, and it cannot be relied upon to be honest about it: the client verifies the
signed prekey signature against the identity key itself, and surfaces identity-key
changes to the user through safety numbers. Everything here is structural validation and
bookkeeping, not a security boundary.

That is why this module does not verify XEdDSA signatures server-side. It would catch
buggy clients but protect nothing against a malicious server, and the client must verify
regardless. What the server *can* usefully do is refuse to store material that is
structurally impossible, and make identity-key changes visible rather than silent.

Keys belong to devices. An account signed in on two browsers has two independent
identities and two sets of ratchets, so every operation here is scoped to one device.
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
from app.models.device import Device
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

    The original check accepted any non-blank string between 16 and 4096 characters,
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
    device_id: str = Field(min_length=8, max_length=128)
    display_name: str | None = Field(default=None, max_length=64)
    identity_key: str
    signed_prekey: SignedPreKeyPayload
    one_time_prekeys: list[OneTimePreKeyPayload] = Field(default_factory=list, max_length=100)

    @field_validator("identity_key")
    @classmethod
    def check_identity_key(cls, value: str) -> str:
        return _validate_base64(value, PUBLIC_KEY_BYTES, "Identity key")


class PublishKeysResponse(BaseModel):
    device_row_id: UUID
    identity_changed: bool
    one_time_prekeys_stored: int


class RotateSignedPreKeyRequest(SignedPreKeyPayload):
    device_id: str = Field(min_length=8, max_length=128)


class UploadOPKsRequest(BaseModel):
    device_id: str = Field(min_length=8, max_length=128)
    prekeys: list[OneTimePreKeyPayload] = Field(min_length=1, max_length=100)


class PreKeyCountResponse(BaseModel):
    remaining: int
    low_water: int
    should_replenish: bool


class DeviceBundle(BaseModel):
    device_row_id: UUID
    device_id: str
    identity_key: str
    identity_key_changed_at: datetime | None
    signed_prekey_id: str
    signed_prekey: str
    signed_prekey_signature: str
    one_time_prekey_id: str | None = None
    one_time_prekey: str | None = None


class DeviceBundlesResponse(BaseModel):
    user_id: str
    devices: list[DeviceBundle]


class DeviceSummary(BaseModel):
    device_row_id: UUID
    device_id: str
    display_name: str | None
    identity_key: str
    created_at: datetime | None
    last_seen_at: datetime | None


async def _device_for(session: AsyncSession, user: User, device_id: str) -> Device:
    device = await session.scalar(
        select(Device).where(Device.user_id == user.id, Device.device_id == device_id)
    )
    if device is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Unknown device. Publish keys for it first.",
        )
    return device


@router.post("/publish", response_model=PublishKeysResponse)
async def publish_keys(
    body: PublishKeysRequest,
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
) -> PublishKeysResponse:
    """
    Register a device, or update the keys of one already registered.

    Re-publishing a *different* identity key for the same device is a reinstall, not an
    error, and is accepted -- the server cannot tell a legitimate reinstall from an
    attacker with the account password. What it must not do is hide it: the change is
    timestamped and reported in every subsequent bundle, so peers can raise a
    safety-number warning.
    """
    device = await session.scalar(
        select(Device).where(
            Device.user_id == current_user.id, Device.device_id == body.device_id
        )
    )

    identity_changed = device is not None and device.identity_key_pub != body.identity_key

    if device is None:
        device = Device(
            user_id=current_user.id,
            device_id=body.device_id,
            display_name=body.display_name,
            identity_key_pub=body.identity_key,
            identity_key_changed_at=_naive_utc_now(),
            signed_prekey_id=body.signed_prekey.key_id,
            signed_prekey_pub=body.signed_prekey.public_key,
            signed_prekey_sig=body.signed_prekey.signature,
            signed_prekey_created_at=_naive_utc_now(),
        )
        session.add(device)
        await session.flush()
    else:
        if identity_changed:
            device.identity_key_changed_at = _naive_utc_now()
            # Prekeys published under the old identity are worthless: their private
            # halves belong to an installation that no longer holds this identity.
            await session.execute(
                delete(OneTimePreKey).where(OneTimePreKey.device_id == device.id)
            )

        device.identity_key_pub = body.identity_key
        device.display_name = body.display_name or device.display_name
        device.signed_prekey_id = body.signed_prekey.key_id
        device.signed_prekey_pub = body.signed_prekey.public_key
        device.signed_prekey_sig = body.signed_prekey.signature
        device.signed_prekey_created_at = _naive_utc_now()

    device.last_seen_at = _naive_utc_now()

    stored = await _store_one_time_prekeys(session, device, body.one_time_prekeys)
    await session.commit()

    return PublishKeysResponse(
        device_row_id=device.id,
        identity_changed=identity_changed,
        one_time_prekeys_stored=stored,
    )


@router.post("/signed-prekey", status_code=status.HTTP_200_OK)
async def rotate_signed_prekey(
    body: RotateSignedPreKeyRequest,
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
) -> dict:
    """Rotate one device's signed prekey. The identity key is untouched."""
    device = await _device_for(session, current_user, body.device_id)

    device.signed_prekey_id = body.key_id
    device.signed_prekey_pub = body.public_key
    device.signed_prekey_sig = body.signature
    device.signed_prekey_created_at = _naive_utc_now()
    await session.commit()

    return {"status": "rotated", "signed_prekey_id": body.key_id}


@router.post("/opks", status_code=status.HTTP_201_CREATED)
async def upload_opks(
    body: UploadOPKsRequest,
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
) -> dict:
    """Top up one device's one-time prekey pool."""
    device = await _device_for(session, current_user, body.device_id)
    stored = await _store_one_time_prekeys(session, device, body.prekeys)
    await session.commit()
    return {"uploaded": stored}


@router.get("/opks/count", response_model=PreKeyCountResponse)
async def count_opks(
    device_id: str,
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
) -> PreKeyCountResponse:
    """Lets a device replenish before its pool runs dry."""
    device = await _device_for(session, current_user, device_id)

    remaining = await session.scalar(
        select(func.count())
        .select_from(OneTimePreKey)
        .where(OneTimePreKey.device_id == device.id)
    )
    remaining = int(remaining or 0)
    return PreKeyCountResponse(
        remaining=remaining,
        low_water=settings.one_time_prekey_low_water,
        should_replenish=remaining < settings.one_time_prekey_low_water,
    )


@router.get("/{target_user_id}/devices", response_model=list[DeviceSummary])
async def list_devices(
    target_user_id: UUID,
    _current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
) -> list[DeviceSummary]:
    """
    Every device belonging to a user.

    Senders need this to know how many copies of a message to produce, and safety
    numbers are computed over the whole set.
    """
    devices = (
        await session.scalars(
            select(Device)
            .where(Device.user_id == target_user_id)
            .order_by(Device.created_at.asc())
        )
    ).all()

    return [
        DeviceSummary(
            device_row_id=device.id,
            device_id=device.device_id,
            display_name=device.display_name,
            identity_key=device.identity_key_pub,
            created_at=device.created_at,
            last_seen_at=device.last_seen_at,
        )
        for device in devices
    ]


@router.post("/{target_user_id}/bundle", response_model=DeviceBundlesResponse)
async def claim_prekey_bundles(
    target_user_id: UUID,
    request: Request,
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
) -> DeviceBundlesResponse:
    """
    Claim a prekey bundle for every device a user has.

    This is a POST because it *consumes* one one-time prekey per device. It used to be a
    GET that mutated state, which meant any prefetch, retry or crawler silently burned
    prekeys. It is also rate limited per requester, since each call permanently removes
    prekeys from the target.
    """
    await enforce_key_claim_rate_limit(request, str(current_user.id))

    if await session.get(User, target_user_id) is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Target user not found."
        )

    devices = (
        await session.scalars(
            select(Device)
            .where(Device.user_id == target_user_id)
            .order_by(Device.created_at.asc())
        )
    ).all()

    if not devices:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Target user has no devices with published key material.",
        )

    bundles: list[DeviceBundle] = []
    for device in devices:
        one_time_prekey_id, one_time_prekey = await _claim_one_time_prekey(session, device.id)
        bundles.append(
            DeviceBundle(
                device_row_id=device.id,
                device_id=device.device_id,
                identity_key=device.identity_key_pub,
                identity_key_changed_at=device.identity_key_changed_at,
                signed_prekey_id=device.signed_prekey_id,
                signed_prekey=device.signed_prekey_pub,
                signed_prekey_signature=device.signed_prekey_sig,
                one_time_prekey_id=one_time_prekey_id,
                one_time_prekey=one_time_prekey,
            )
        )

    return DeviceBundlesResponse(user_id=str(target_user_id), devices=bundles)


async def _claim_one_time_prekey(
    session: AsyncSession, device_row_id: UUID
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
        .where(OneTimePreKey.device_id == device_row_id)
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
    session: AsyncSession, device: Device, prekeys: list[OneTimePreKeyPayload]
) -> int:
    """Insert prekeys, ignoring ids this device has already published."""
    if not prekeys:
        return 0

    existing = set(
        (
            await session.scalars(
                select(OneTimePreKey.key_id).where(OneTimePreKey.device_id == device.id)
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
                device_id=device.id,
                key_id=prekey.key_id,
                public_key=prekey.public_key,
            )
        )
        stored += 1

    return stored
