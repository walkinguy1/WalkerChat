from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.security import get_current_user
from app.models.user import User
from app.schemas.chat import BootstrapResponse
from app.services.chat import get_bootstrap_data

router = APIRouter(prefix="/api", tags=["bootstrap"])


@router.get("/bootstrap", response_model=BootstrapResponse)
async def fetch_bootstrap(
    _current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
) -> BootstrapResponse:
    return await get_bootstrap_data(session)
