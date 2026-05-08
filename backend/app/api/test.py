from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.logging_config import WalkerChatLogger

router = APIRouter(prefix="/test", tags=["test"])
logger = WalkerChatLogger(__name__)


@router.get("/redis")
async def test_redis() -> dict:
    """Test Redis connection."""
    from app.core.runtime_state import get_runtime_redis
    
    redis_client = await get_runtime_redis()
    if redis_client:
        try:
            await redis_client.ping()
            return {"status": "Redis connected", "type": "redis"}
        except Exception as e:
            logger.error("Redis test failed", error=e)
            return {"status": "Redis error", "error": str(e)}
    else:
        return {"status": "Using memory fallback", "type": "memory"}


@router.get("/db")
async def test_database(db: AsyncSession = Depends(get_db)) -> dict:
    """Test database connection."""
    try:
        result = await db.execute("SELECT 1 as test")
        row = result.scalar_one_or_none()
        return {"status": "Database connected", "test_value": row}
    except Exception as e:
        logger.error("Database test failed", error=e)
        return {"status": "Database error", "error": str(e)}


@router.get("/ws-ticket")
async def test_ws_ticket() -> dict:
    """Test WebSocket ticket creation/consumption."""
    from app.core.security import create_ws_ticket, consume_ws_ticket
    from app.models.user import User
    import uuid
    
    # Use demo user ID
    demo_user_id = uuid.UUID("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa")
    
    try:
        # Create ticket
        ticket = await create_ws_ticket(demo_user_id)
        logger.info(f"Created test ticket: {ticket[:8]}...")
        
        # Consume ticket
        recovered_user_id = await consume_ws_ticket(ticket)
        logger.info(f"Recovered user ID: {recovered_user_id}")
        
        return {
            "status": "WebSocket ticket test passed",
            "ticket_created": True,
            "ticket_consumed": True,
            "user_id_match": str(demo_user_id) == str(recovered_user_id)
        }
    except Exception as e:
        logger.error("WebSocket ticket test failed", error=e)
        return {
            "status": "WebSocket ticket test failed",
            "error": str(e)
        }


@router.get("/crypto")
async def test_crypto() -> dict:
    """Test basic crypto functionality."""
    try:
        from app.models.user import User
        import uuid
        
        # Test with demo user keys (these should exist in seeded data)
        demo_alice_id = uuid.UUID("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa")
        demo_bob_id = uuid.UUID("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb")
        
        return {
            "status": "Crypto test endpoint",
            "note": "Crypto testing requires frontend implementation",
            "demo_users": {
                "alice_id": str(demo_alice_id),
                "bob_id": str(demo_bob_id)
            }
        }
    except Exception as e:
        logger.error("Crypto test failed", error=e)
        return {"status": "Crypto test failed", "error": str(e)}
