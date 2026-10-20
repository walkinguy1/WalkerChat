"""Verify Supabase Auth sessions before mapping them to WalkerChat accounts."""

import asyncio
import time
from dataclasses import dataclass
from typing import Any

import httpx
import jwt
from fastapi import HTTPException, status

from app.core.config import get_settings

_ASYMMETRIC_ALGORITHMS = {"ES256", "RS256"}
_JWKS_CACHE_SECONDS = 300
_jwks_cache: dict[str, Any] = {}
_jwks_expires_at = 0.0
_jwks_lock = asyncio.Lock()


@dataclass(frozen=True)
class SupabaseIdentity:
    subject: str


def _auth_base_url() -> str:
    settings = get_settings()
    if not settings.supabase_url or not settings.supabase_publishable_key:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Supabase authentication is not configured.",
        )
    return settings.supabase_url.rstrip("/") + "/auth/v1"


async def _load_jwks(*, refresh: bool = False) -> dict[str, Any]:
    global _jwks_cache, _jwks_expires_at
    base_url = _auth_base_url()
    async with _jwks_lock:
        if not refresh and _jwks_cache and time.monotonic() < _jwks_expires_at:
            return _jwks_cache
        settings = get_settings()
        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                response = await client.get(
                    f"{base_url}/.well-known/jwks.json",
                    headers={"apikey": settings.supabase_publishable_key or ""},
                )
                response.raise_for_status()
                jwks = response.json()
        except (httpx.HTTPError, ValueError) as exc:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="Unable to validate Supabase signing keys.",
            ) from exc
        keys = jwks.get("keys") if isinstance(jwks, dict) else None
        if not isinstance(keys, list):
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="Supabase signing keys are unavailable.",
            )
        _jwks_cache = {key["kid"]: key for key in keys if isinstance(key, dict) and key.get("kid")}
        _jwks_expires_at = time.monotonic() + _JWKS_CACHE_SECONDS
        return _jwks_cache


async def _get_auth_user(access_token: str) -> dict[str, Any]:
    settings = get_settings()
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            response = await client.get(
                f"{_auth_base_url()}/user",
                headers={
                    "apikey": settings.supabase_publishable_key or "",
                    "Authorization": f"Bearer {access_token}",
                },
            )
    except httpx.HTTPError as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Unable to validate Supabase session.",
        ) from exc
    if response.status_code != 200:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired Supabase session.",
        )
    try:
        user = response.json()
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid Supabase session response.",
        ) from exc
    if not isinstance(user, dict) or not isinstance(user.get("id"), str):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid Supabase session response.",
        )
    return user


def _require_google_provider(user: dict[str, Any]) -> None:
    metadata = user.get("app_metadata")
    providers = metadata.get("providers", []) if isinstance(metadata, dict) else []
    provider = metadata.get("provider") if isinstance(metadata, dict) else None
    if provider != "google" and (not isinstance(providers, list) or "google" not in providers):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="A Google-authenticated Supabase session is required.",
        )


def _validate_claims(token: str, *, algorithm: str) -> dict[str, Any]:
    settings = get_settings()
    issuer = settings.supabase_url.rstrip("/") + "/auth/v1"  # type: ignore[union-attr]
    try:
        if algorithm != "HS256":
            raise AssertionError("only the Auth-server-verified HS256 path uses this helper")
        # HS256 was already verified by the configured Supabase Auth /user endpoint.
        # This decode then applies the same issuer/audience/time policy locally.
        claims = jwt.decode(
            token,
            options={
                "verify_signature": False,
                "verify_exp": True,
                "verify_iat": True,
                "verify_iss": True,
                "verify_aud": True,
                "require": ["sub", "exp", "iat", "iss", "aud"],
            },
            issuer=issuer,
            audience="authenticated",
        )
    except jwt.InvalidTokenError as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired Supabase session.",
        ) from exc
    if not isinstance(claims.get("sub"), str):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid Supabase subject.",
        )
    return claims


async def verify_supabase_access_token(access_token: str) -> SupabaseIdentity:
    """Verify a project access token and confirm its Google Auth user is still valid."""
    try:
        header = jwt.get_unverified_header(access_token)
    except jwt.InvalidTokenError as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid Supabase access token.",
        ) from exc
    algorithm = header.get("alg")
    if algorithm == "HS256":
        # Supabase's legacy shared secret is intentionally never copied into WalkerChat.
        user = await _get_auth_user(access_token)
        claims = _validate_claims(access_token, algorithm="HS256")
    elif algorithm in _ASYMMETRIC_ALGORITHMS:
        kid = header.get("kid")
        if not isinstance(kid, str):
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Invalid Supabase signing key identifier.",
            )
        keys = await _load_jwks()
        jwk = keys.get(kid)
        if jwk is None:
            keys = await _load_jwks(refresh=True)
            jwk = keys.get(kid)
        if jwk is None or (jwk.get("alg") and jwk["alg"] != algorithm):
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Untrusted Supabase signing key.",
            )
        settings = get_settings()
        issuer = settings.supabase_url.rstrip("/") + "/auth/v1"  # type: ignore[union-attr]
        try:
            claims = jwt.decode(
                access_token,
                jwt.PyJWK.from_dict(jwk).key,
                algorithms=[algorithm],
                issuer=issuer,
                audience="authenticated",
                options={"require": ["sub", "exp", "iat", "iss", "aud"]},
            )
        except (jwt.InvalidTokenError, ValueError, TypeError) as exc:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Invalid or expired Supabase access token.",
            ) from exc
        user = await _get_auth_user(access_token)
    else:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Unsupported Supabase signing algorithm.",
        )

    _require_google_provider(user)
    if claims["sub"] != user["id"]:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Supabase subject does not match the verified user.",
        )
    return SupabaseIdentity(subject=claims["sub"])
