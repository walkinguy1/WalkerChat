import time
from collections import defaultdict, deque
from typing import Dict

from redis.asyncio import Redis
from redis.exceptions import RedisError

from app.core.config import get_settings

settings = get_settings()


class RedisRateLimiter:
    """Redis-based rate limiter for WebSocket connections."""
    
    def __init__(self, redis: Redis):
        self.redis = redis
        self.window_size = settings.auth_rate_limit_window_seconds
        self.max_requests = settings.auth_rate_limit_attempts
    
    async def is_allowed(self, key: str) -> bool:
        """Check if the key is allowed to make a request."""
        try:
            current_time = int(time.time())
            window_start = current_time - self.window_size
            
            # Remove old entries
            await self.redis.zremrangebyscore(key, 0, window_start)
            
            # Count current requests
            request_count = await self.redis.zcard(key)
            
            if request_count >= self.max_requests:
                return False
            
            # Add current request
            await self.redis.zadd(key, {str(current_time): current_time})
            await self.redis.expire(key, self.window_size)
            
            return True
        except RedisError:
            # If Redis fails, allow the request (fail open)
            return True


class InMemoryRateLimiter:
    """In-memory rate limiter fallback for when Redis is unavailable."""
    
    def __init__(self):
        self.requests: Dict[str, deque] = defaultdict(deque)
        self.window_size = settings.auth_rate_limit_window_seconds
        self.max_requests = settings.auth_rate_limit_attempts
    
    async def is_allowed(self, key: str) -> bool:
        """Check if the key is allowed to make a request.

        Async to match RedisRateLimiter — WebSocketRateLimiter awaits whichever
        backend it selected.
        """
        current_time = time.time()
        window_start = current_time - self.window_size
        
        # Clean old requests
        while self.requests[key] and self.requests[key][0] < window_start:
            self.requests[key].popleft()
        
        # Check if under limit
        if len(self.requests[key]) >= self.max_requests:
            return False
        
        # Add current request
        self.requests[key].append(current_time)
        return True


class WebSocketRateLimiter:
    """Rate limiter specifically for WebSocket message events."""
    
    def __init__(self, redis: Redis | None):
        if redis:
            self.limiter = RedisRateLimiter(redis)
        else:
            self.limiter = InMemoryRateLimiter()
    
    async def can_send_message(self, user_id: str) -> bool:
        """Check if user can send a message (30 messages per minute)."""
        key = f"ws:messages:{user_id}"
        return await self.limiter.is_allowed(key)
    
    async def can_connect(self, ip_address: str) -> bool:
        """Check if IP can establish WebSocket connection (10 connections per minute)."""
        key = f"ws:connect:{ip_address}"
        return await self.limiter.is_allowed(key)
    
    async def can_send_typing(self, user_id: str) -> bool:
        """Check if user can send typing indicator (10 per minute)."""
        key = f"ws:typing:{user_id}"
        return await self.limiter.is_allowed(key)
