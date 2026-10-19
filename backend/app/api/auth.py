from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.database import get_db
from app.core.rate_limit import enforce_auth_rate_limit
from app.core.security import (
    create_access_token,
    create_ws_ticket,
    get_current_user,
    hash_password,
    revoke_access_token,
    verify_password,
)
from app.core.supabase_auth import verify_supabase_access_token
from app.models.user import User

router = APIRouter(prefix="/api/auth", tags=["auth"])
bearer_scheme = HTTPBearer()
supabase_bearer_scheme = HTTPBearer()
settings = get_settings()


class RegisterRequest(BaseModel):
    username: str = Field(min_length=3, max_length=32)
    password: str = Field(min_length=8, max_length=128)


class LoginRequest(BaseModel):
    username: str = Field(min_length=3, max_length=32)
    password: str


class SupabaseOnboardingRequest(BaseModel):
    username: str = Field(min_length=3, max_length=32, pattern=r"^[A-Za-z0-9_.-]+$")
    display_name: str | None = Field(default=None, max_length=80)


class ExistingAccountLinkRequest(BaseModel):
    username: str = Field(min_length=3, max_length=32)
    password: str = Field(min_length=1, max_length=128)


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user_id: str
    username: str | None = None
    display_name: str | None = None


class WebSocketTicketResponse(BaseModel):
    ticket: str
    expires_in_seconds: int


@router.post("/register", response_model=TokenResponse, status_code=status.HTTP_201_CREATED)
async def register(
    body: RegisterRequest,
    request: Request,
    session: AsyncSession = Depends(get_db),
) -> TokenResponse:
    if settings.app_env != "development":
        raise HTTPException(status_code=404, detail="Not found.")
    await enforce_auth_rate_limit(request, body.username)
    existing = await session.scalar(
        select(User).where(User.username == body.username)
    )
    if existing is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Username already taken.",
        )

    # Key material is generated in the browser and published separately via
    # POST /api/keys/publish, so a new account genuinely has no keys yet.
    user = User(
        username=body.username,
        password_hash=hash_password(body.password),
    )
    session.add(user)
    await session.commit()
    await session.refresh(user)

    token = create_access_token(user.id)
    return TokenResponse(access_token=token, user_id=str(user.id), username=user.username)


@router.post("/login", response_model=TokenResponse)
async def login(
    body: LoginRequest,
    request: Request,
    session: AsyncSession = Depends(get_db),
) -> TokenResponse:
    if settings.app_env != "development":
        raise HTTPException(status_code=404, detail="Not found.")
    await enforce_auth_rate_limit(request, body.username)
    user = await session.scalar(
        select(User).where(User.username == body.username)
    )
    reserved_demo_user = (
        settings.app_env != "development"
        and user is not None
        and user.id in {settings.demo_alice_id, settings.demo_bob_id}
    )
    if (
        user is None
        or reserved_demo_user
        or not user.password_hash
        or not verify_password(body.password, user.password_hash)
    ):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid username or password.",
        )

    token = create_access_token(user.id)
    return TokenResponse(
        access_token=token,
        user_id=str(user.id),
        username=user.username,
        display_name=user.display_name,
    )


def _session_token(user: User, provider_subject: str) -> TokenResponse:
    return TokenResponse(
        access_token=create_access_token(user.id, provider_subject=provider_subject),
        user_id=str(user.id),
        username=user.username,
        display_name=user.display_name,
    )


@router.post("/supabase/exchange", response_model=TokenResponse)
async def exchange_supabase_session(
    credentials: HTTPAuthorizationCredentials = Depends(supabase_bearer_scheme),
    session: AsyncSession = Depends(get_db),
) -> TokenResponse:
    identity = await verify_supabase_access_token(credentials.credentials)
    user = await session.scalar(
        select(User).where(User.supabase_subject == identity.subject)
    )
    if user is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "identity_not_onboarded", "message": "Choose a WalkerChat username."},
        )
    return _session_token(user, identity.subject)


@router.post(
    "/supabase/onboard",
    response_model=TokenResponse,
    status_code=status.HTTP_201_CREATED,
)
async def onboard_supabase_identity(
    body: SupabaseOnboardingRequest,
    request: Request,
    credentials: HTTPAuthorizationCredentials = Depends(supabase_bearer_scheme),
    session: AsyncSession = Depends(get_db),
) -> TokenResponse:
    identity = await verify_supabase_access_token(credentials.credentials)
    await enforce_auth_rate_limit(request, body.username)
    if await session.scalar(select(User.id).where(User.username == body.username)):
        raise HTTPException(status_code=409, detail="Username already taken.")
    if await session.scalar(
        select(User.id).where(User.supabase_subject == identity.subject)
    ):
        raise HTTPException(status_code=409, detail="This identity is already linked.")

    user = User(
        username=body.username,
        display_name=(body.display_name or "").strip() or None,
        password_hash=None,
        supabase_subject=identity.subject,
    )
    session.add(user)
    try:
        await session.commit()
        await session.refresh(user)
    except IntegrityError as exc:
        await session.rollback()
        raise HTTPException(
            status_code=409,
            detail="Username already taken or identity already linked.",
        ) from exc
    return _session_token(user, identity.subject)


@router.post("/supabase/link-existing", response_model=TokenResponse)
async def link_existing_account(
    body: ExistingAccountLinkRequest,
    request: Request,
    credentials: HTTPAuthorizationCredentials = Depends(supabase_bearer_scheme),
    session: AsyncSession = Depends(get_db),
) -> TokenResponse:
    """Link only after proving both the existing password and Google session."""
    identity = await verify_supabase_access_token(credentials.credentials)
    await enforce_auth_rate_limit(request, body.username)
    user = await session.scalar(select(User).where(User.username == body.username))
    if user is None or not user.password_hash or not verify_password(body.password, user.password_hash):
        raise HTTPException(status_code=401, detail="Invalid existing account credentials.")
    existing_user_id = await session.scalar(
        select(User.id).where(User.supabase_subject == identity.subject)
    )
    if existing_user_id is not None and existing_user_id != user.id:
        raise HTTPException(status_code=409, detail="This identity is already linked.")
    if user.supabase_subject not in (None, identity.subject):
        raise HTTPException(status_code=409, detail="This account is already linked.")
    user.supabase_subject = identity.subject
    try:
        await session.commit()
        await session.refresh(user)
    except IntegrityError as exc:
        await session.rollback()
        raise HTTPException(
            status_code=409,
            detail="This identity or account is already linked.",
        ) from exc
    return _session_token(user, identity.subject)


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
async def logout(
    credentials: HTTPAuthorizationCredentials = Depends(bearer_scheme),
) -> None:
    await revoke_access_token(credentials.credentials)


@router.post("/ws-ticket", response_model=WebSocketTicketResponse)
async def issue_ws_ticket(
    current_user: User = Depends(get_current_user),
) -> WebSocketTicketResponse:
    ticket = await create_ws_ticket(current_user.id)
    return WebSocketTicketResponse(
        ticket=ticket, expires_in_seconds=settings.ws_ticket_expiry_seconds
    )
