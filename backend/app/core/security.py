from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

import jwt
from fastapi import Depends, HTTPException, Query, WebSocket, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from passlib.context import CryptContext
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.database import get_db
from app.core.runtime_state import (
    delete_ephemeral_value,
    get_ephemeral_value,
    set_ephemeral_value,
)
from app.models.user import User

settings = get_settings()

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")
_bearer_scheme = HTTPBearer()


def hash_password(plain: str) -> str:
    return pwd_context.hash(plain)


def verify_password(plain: str, hashed: str) -> bool:
    return pwd_context.verify(plain, hashed)


def create_access_token(user_id: UUID) -> str:
    jti = uuid4().hex
    payload = {
        "sub": str(user_id),
        "jti": jti,
        "exp": datetime.now(UTC) + timedelta(minutes=settings.jwt_expiry_minutes),
        "iat": datetime.now(UTC),
    }
    return jwt.encode(payload, settings.jwt_secret, algorithm=settings.jwt_algorithm)


def _decode_token_payload(token: str) -> dict:
    try:
        return jwt.decode(
            token, settings.jwt_secret, algorithms=[settings.jwt_algorithm]
        )
    except (jwt.InvalidTokenError, KeyError, ValueError) as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired token.",
        ) from exc


async def _assert_token_not_revoked(payload: dict) -> None:
    revoked_marker = await get_ephemeral_value(f"revoked-token:{payload['jti']}")
    if revoked_marker is not None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Token has been revoked.",
        )


async def _decode_access_token(token: str) -> UUID:
    payload = _decode_token_payload(token)
    await _assert_token_not_revoked(payload)
    try:
        return UUID(payload["sub"])
    except (KeyError, ValueError) as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired token.",
        ) from exc


async def revoke_access_token(token: str) -> None:
    payload = _decode_token_payload(token)
    expires_at = datetime.fromtimestamp(payload["exp"], tz=UTC)
    ttl_seconds = max(1, int((expires_at - datetime.now(UTC)).total_seconds()))
    await set_ephemeral_value(f"revoked-token:{payload['jti']}", "1", ttl_seconds)


async def create_ws_ticket(user_id: UUID) -> str:
    from app.core.logging_config import WalkerChatLogger
    logger = WalkerChatLogger(__name__)
    
    ticket = uuid4().hex
    logger.debug(f"Creating WebSocket ticket for user {user_id}: {ticket[:8]}...")
    
    await set_ephemeral_value(
        f"ws-ticket:{ticket}",
        str(user_id),
        settings.ws_ticket_expiry_seconds,
    )
    
    logger.debug(f"WebSocket ticket created and stored: {ticket[:8]}...")
    return ticket


async def consume_ws_ticket(ticket: str) -> UUID:
    from app.core.logging_config import WalkerChatLogger
    logger = WalkerChatLogger(__name__)
    
    logger.debug(f"Attempting to consume WebSocket ticket: {ticket[:8]}...")
    
    stored_user_id = await get_ephemeral_value(f"ws-ticket:{ticket}")
    
    if stored_user_id is None:
        logger.warning(f"WebSocket ticket not found: {ticket[:8]}...")
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired WebSocket ticket.",
        )

    logger.debug(f"Found user_id for ticket: {stored_user_id}")
    await delete_ephemeral_value(f"ws-ticket:{ticket}")
    
    try:
        user_uuid = UUID(stored_user_id)
        logger.debug(f"Successfully parsed UUID: {user_uuid}")
        return user_uuid
    except ValueError as exc:
        logger.error(f"Failed to parse UUID from stored_user_id: {stored_user_id}")
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired WebSocket ticket.",
        ) from exc


async def get_current_user(
    credentials: HTTPAuthorizationCredentials = Depends(_bearer_scheme),
    session: AsyncSession = Depends(get_db),
) -> User:
    user_id = await _decode_access_token(credentials.credentials)
    user = await session.get(User, user_id)
    if user is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="User not found.",
        )
    return user


async def get_ws_user(
    websocket: WebSocket,
    ticket: str = Query(...),
) -> UUID:
    """Validate a one-time WebSocket ticket and return the user id."""
    try:
        return await consume_ws_ticket(ticket)
    except HTTPException as exc:
        await websocket.close(code=4001, reason="Invalid or expired token.")
        # Don't re-raise HTTPException in WebSocket context
        from fastapi import WebSocketException
        raise WebSocketException(code=4001, reason="Invalid or expired token.") from exc
