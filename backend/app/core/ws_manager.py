import asyncio
import json
import logging
from collections import defaultdict
from typing import Any
from uuid import uuid4

from fastapi import WebSocket
from redis.asyncio import Redis
from redis.exceptions import RedisError

from app.core.config import get_settings

logger = logging.getLogger(__name__)
settings = get_settings()


class ConnectionManager:
    def __init__(self) -> None:
        self.active_connections: dict[str, set[WebSocket]] = defaultdict(set)
        self.redis: Redis | None = None
        self.listener_task: asyncio.Task[None] | None = None
        self.instance_id = uuid4().hex

    async def startup(self) -> None:
        try:
            self.redis = Redis.from_url(settings.redis_url, decode_responses=True)
            await self.redis.ping()
        except RedisError:
            logger.exception(
                "Redis is unavailable. Continuing with single-process WebSocket delivery."
            )
            self.redis = None
            return

        self.listener_task = asyncio.create_task(self._listen_for_pubsub())

    async def shutdown(self) -> None:
        if self.listener_task is not None:
            self.listener_task.cancel()
            try:
                await self.listener_task
            except asyncio.CancelledError:
                pass
            self.listener_task = None

        if self.redis is not None:
            await self.redis.aclose()
            self.redis = None

    async def connect(self, websocket: WebSocket, user_id: str) -> bool:
        was_connected = bool(self.active_connections.get(user_id))
        await websocket.accept()
        self.active_connections[user_id].add(websocket)
        return not was_connected

    def disconnect(self, websocket: WebSocket, user_id: str) -> bool:
        sockets = self.active_connections.get(user_id)
        if sockets is None:
            return False

        sockets.discard(websocket)
        if not sockets:
            del self.active_connections[user_id]
            return True

        return False

    async def send_to_socket(self, websocket: WebSocket, message: Any) -> None:
        await websocket.send_text(json.dumps(message, default=str))

    async def send_personal_message(self, message: Any, user_id: str) -> None:
        sockets = list(self.active_connections.get(user_id, set()))
        if not sockets:
            return

        disconnected: list[WebSocket] = []
        for socket in sockets:
            try:
                await socket.send_text(json.dumps(message, default=str))
            except RuntimeError:
                disconnected.append(socket)

        for socket in disconnected:
            self.disconnect(socket, user_id)

    async def publish(self, event: dict[str, Any], recipients: set[str]) -> None:
        """
        Fan an event out to an explicit recipient set.

        Recipients are resolved by the caller, which has database access, and travel in
        the Redis envelope rather than inside the event. Previously routing was derived
        from a single ``target_id`` field, which made a group message physically
        undeliverable: only one member could ever receive it.
        """
        if not recipients:
            return

        if self.redis is None:
            await self.route_event(event, recipients)
            return

        await self.redis.publish(
            settings.websocket_channel,
            json.dumps(
                {
                    "instance_id": self.instance_id,
                    "recipients": sorted(recipients),
                    "event": event,
                },
                default=str,
            ),
        )

    async def route_event(self, event: dict[str, Any], recipients: set[str]) -> None:
        for user_id in recipients:
            await self.send_personal_message(event, user_id)

    async def _listen_for_pubsub(self) -> None:
        if self.redis is None:
            return

        pubsub = self.redis.pubsub()
        await pubsub.subscribe(settings.websocket_channel)

        try:
            async for message in pubsub.listen():
                if message.get("type") != "message":
                    continue

                try:
                    payload = json.loads(message["data"])
                except (KeyError, TypeError, json.JSONDecodeError):
                    logger.warning("Skipping malformed Redis message: %s", message)
                    continue

                event = payload.get("event")
                recipients = payload.get("recipients")
                if isinstance(event, dict) and isinstance(recipients, list):
                    await self.route_event(
                        event, {str(user_id) for user_id in recipients}
                    )
        except asyncio.CancelledError:
            raise
        finally:
            await pubsub.unsubscribe(settings.websocket_channel)
            await pubsub.aclose()


manager = ConnectionManager()
