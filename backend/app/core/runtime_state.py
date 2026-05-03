import asyncio
from typing import Any

from redis.asyncio import Redis
from redis.exceptions import RedisError

from app.core.config import get_settings

settings = get_settings()

_redis_client: Redis | None = None
_redis_lock = asyncio.Lock()
_memory_expirations: dict[str, float] = {}
_memory_values: dict[str, Any] = {}
_memory_counters: dict[str, int] = {}
_memory_lock = asyncio.Lock()


async def get_runtime_redis() -> Redis | None:
    global _redis_client

    if _redis_client is not None:
        return _redis_client

    async with _redis_lock:
        if _redis_client is not None:
            return _redis_client

        try:
            client = Redis.from_url(settings.redis_url, decode_responses=True)
            await client.ping()
        except RedisError:
            return None

        _redis_client = client
        return _redis_client


async def close_runtime_redis() -> None:
    global _redis_client

    if _redis_client is None:
        return

    async with _redis_lock:
        if _redis_client is not None:
            await _redis_client.aclose()
            _redis_client = None


async def set_ephemeral_value(key: str, value: str, ttl_seconds: int) -> None:
    redis_client = await get_runtime_redis()
    if redis_client is not None:
        await redis_client.set(key, value, ex=ttl_seconds)
        return

    loop = asyncio.get_running_loop()
    async with _memory_lock:
        _memory_expirations[key] = loop.time() + ttl_seconds
        _memory_values[key] = value


async def set_runtime_value(key: str, value: str) -> None:
    redis_client = await get_runtime_redis()
    if redis_client is not None:
        await redis_client.set(key, value)
        return

    async with _memory_lock:
        _memory_values[key] = value
        _memory_expirations.pop(key, None)


async def get_runtime_value(key: str) -> str | None:
    redis_client = await get_runtime_redis()
    if redis_client is not None:
        return await redis_client.get(key)

    async with _memory_lock:
        stored = _memory_values.get(key)
        return stored if isinstance(stored, str) else None


async def get_ephemeral_value(key: str) -> str | None:
    redis_client = await get_runtime_redis()
    if redis_client is not None:
        return await redis_client.get(key)

    loop = asyncio.get_running_loop()
    async with _memory_lock:
        expiry = _memory_expirations.get(key)
        if expiry is None or expiry < loop.time():
            _memory_expirations.pop(key, None)
            _memory_values.pop(key, None)
            return None
        stored = _memory_values.get(key)
        return stored if isinstance(stored, str) else None


async def delete_ephemeral_value(key: str) -> None:
    redis_client = await get_runtime_redis()
    if redis_client is not None:
        await redis_client.delete(key)
        return

    async with _memory_lock:
        _memory_expirations.pop(key, None)
        _memory_values.pop(key, None)
        _memory_counters.pop(key, None)


async def increment_with_ttl(key: str, ttl_seconds: int) -> int:
    redis_client = await get_runtime_redis()
    if redis_client is not None:
        value = await redis_client.incr(key)
        if value == 1:
            await redis_client.expire(key, ttl_seconds)
        return int(value)

    loop = asyncio.get_running_loop()
    async with _memory_lock:
        expiry = _memory_expirations.get(key)
        now = loop.time()
        if expiry is None or expiry < now:
            _memory_expirations[key] = now + ttl_seconds
            _memory_counters[key] = 1
            return 1
        _memory_counters[key] = _memory_counters.get(key, 0) + 1
        return _memory_counters[key]
