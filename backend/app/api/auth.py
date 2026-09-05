from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel, Field
from sqlalchemy import select
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
from app.models.user import User

router = APIRouter(prefix="/api/auth", tags=["auth"])
bearer_scheme = HTTPBearer()
settings = get_settings()


class RegisterRequest(BaseModel):
    username: str = Field(min_length=3, max_length=32)
    password: str = Field(min_length=8, max_length=128)


class LoginRequest(BaseModel):
    username: str = Field(min_length=3, max_length=32)
    password: str


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user_id: str


class WebSocketTicketResponse(BaseModel):
    ticket: str
    expires_in_seconds: int


@router.post("/register", response_model=TokenResponse, status_code=status.HTTP_201_CREATED)
async def register(
    body: RegisterRequest,
    request: Request,
    session: AsyncSession = Depends(get_db),
) -> TokenResponse:
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
    return TokenResponse(access_token=token, user_id=str(user.id))


@router.post("/login", response_model=TokenResponse)
async def login(
    body: LoginRequest,
    request: Request,
    session: AsyncSession = Depends(get_db),
) -> TokenResponse:
    await enforce_auth_rate_limit(request, body.username)
    user = await session.scalar(
        select(User).where(User.username == body.username)
    )
    if user is None or not verify_password(body.password, user.password_hash):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid username or password.",
        )

    token = create_access_token(user.id)
    return TokenResponse(access_token=token, user_id=str(user.id))


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
