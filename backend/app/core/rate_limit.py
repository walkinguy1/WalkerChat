from fastapi import HTTPException, Request, status

from app.core.config import get_settings
from app.core.runtime_state import increment_with_ttl

settings = get_settings()


async def enforce_auth_rate_limit(request: Request, principal: str) -> None:
    client_host = request.client.host if request.client else "unknown"
    route = request.url.path
    key = f"auth-rate-limit:{route}:{client_host}:{principal.lower()}"
    attempts = await increment_with_ttl(
        key, settings.auth_rate_limit_window_seconds
    )
    if attempts > settings.auth_rate_limit_attempts:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Too many authentication attempts. Try again later.",
        )


async def enforce_key_claim_rate_limit(request: Request, principal: str) -> None:
    """
    Limit prekey bundle claims per requester.

    Each claim permanently consumes one of the target's one-time prekeys, so an
    unlimited rate lets any authenticated user drain another user's pool in a loop and
    force every later handshake to fall back to the weaker no-OPK path.
    """
    client_host = request.client.host if request.client else "unknown"
    key = f"key-claim-rate-limit:{client_host}:{principal}"
    attempts = await increment_with_ttl(
        key, settings.key_claim_rate_limit_window_seconds
    )
    if attempts > settings.key_claim_rate_limit_attempts:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Too many prekey bundle requests. Try again later.",
        )
