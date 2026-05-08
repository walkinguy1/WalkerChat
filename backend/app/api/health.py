import asyncio
from datetime import UTC, datetime
from typing import Any, Dict

from fastapi import APIRouter, Depends
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.database import get_db, SessionLocal
from app.core.ws_manager import manager

router = APIRouter(prefix="/health", tags=["health"])


class HealthStatus:
    def __init__(self):
        self.status = "healthy"
        self.timestamp = datetime.now(UTC).isoformat()
        self.services: Dict[str, Any] = {}
        self.errors: list[str] = []

    def add_service_check(self, service_name: str, is_healthy: bool, details: Any = None):
        self.services[service_name] = {
            "status": "healthy" if is_healthy else "unhealthy",
            "details": details,
            "timestamp": datetime.now(UTC).isoformat()
        }
        if not is_healthy:
            self.status = "unhealthy"
            self.errors.append(f"{service_name} is unhealthy")

    def to_dict(self) -> Dict[str, Any]:
        return {
            "status": self.status,
            "timestamp": self.timestamp,
            "services": self.services,
            "errors": self.errors
        }


@router.get("/")
async def health_check() -> Dict[str, Any]:
    """Basic health check endpoint."""
    return {
        "status": "healthy",
        "timestamp": datetime.now(UTC).isoformat(),
        "service": "walkerchat-api"
    }


@router.get("/detailed")
async def detailed_health_check(db: AsyncSession = Depends(get_db)) -> Dict[str, Any]:
    """Detailed health check including all services."""
    health = HealthStatus()
    
    # Check database connection
    try:
        await db.execute(text("SELECT 1"))
        health.add_service_check("database", True, "PostgreSQL connection successful")
    except Exception as e:
        health.add_service_check("database", False, str(e))
    
    # Check Redis connection
    try:
        if manager.redis:
            await manager.redis.ping()
            health.add_service_check("redis", True, "Redis connection successful")
        else:
            health.add_service_check("redis", False, "Redis not available")
    except Exception as e:
        health.add_service_check("redis", False, str(e))
    
    # Check WebSocket manager
    try:
        connection_count = len(manager.active_connections)
        health.add_service_check("websocket_manager", True, {
            "active_connections": connection_count,
            "instance_id": manager.instance_id
        })
    except Exception as e:
        health.add_service_check("websocket_manager", False, str(e))
    
    # Check memory usage (basic check)
    try:
        import psutil
        process = psutil.Process()
        memory_info = process.memory_info()
        health.add_service_check("memory", True, {
            "rss_mb": round(memory_info.rss / 1024 / 1024, 2),
            "vms_mb": round(memory_info.vms / 1024 / 1024, 2)
        })
    except ImportError:
        health.add_service_check("memory", True, "psutil not available for monitoring")
    except Exception as e:
        health.add_service_check("memory", False, str(e))
    
    return health.to_dict()


@router.get("/readiness")
async def readiness_check() -> Dict[str, Any]:
    """Readiness probe for Kubernetes/container orchestration."""
    try:
        # Check if database is ready
        async with SessionLocal() as session:
            await session.execute(text("SELECT 1"))
        
        # Check if Redis is ready (if available)
        if manager.redis:
            await manager.redis.ping()
        
        return {
            "status": "ready",
            "timestamp": datetime.now(UTC).isoformat()
        }
    except Exception as e:
        return {
            "status": "not_ready",
            "timestamp": datetime.now(UTC).isoformat(),
            "error": str(e)
        }


@router.get("/liveness")
async def liveness_check() -> Dict[str, Any]:
    """Liveness probe for Kubernetes/container orchestration."""
    return {
        "status": "alive",
        "timestamp": datetime.now(UTC).isoformat(),
        "uptime_seconds": asyncio.get_event_loop().time()
    }


@router.get("/metrics")
async def metrics_check() -> Dict[str, Any]:
    """Basic metrics endpoint."""
    try:
        connection_count = len(manager.active_connections)
        
        metrics = {
            "websocket_connections": {
                "active_count": connection_count,
                "total_users": len(manager.active_connections.keys())
            },
            "timestamp": datetime.now(UTC).isoformat()
        }
        
        # Add Redis metrics if available
        if manager.redis:
            try:
                info = await manager.redis.info()
                metrics["redis"] = {
                    "connected_clients": info.get("connected_clients", 0),
                    "used_memory": info.get("used_memory_human", "unknown")
                }
            except Exception:
                metrics["redis"] = {"status": "unavailable"}
        
        return metrics
    except Exception as e:
        return {
            "error": str(e),
            "timestamp": datetime.now(UTC).isoformat()
        }
