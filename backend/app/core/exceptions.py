import logging
from typing import Any, Dict, Optional

from fastapi import HTTPException, Request, status
from fastapi.responses import JSONResponse
from pydantic import ValidationError

from app.core.logging_config import WalkerChatLogger

logger = WalkerChatLogger(__name__)


class WalkerChatException(Exception):
    """Base exception for WalkerChat application."""
    
    def __init__(
        self, 
        message: str, 
        error_code: Optional[str] = None,
        details: Optional[Dict[str, Any]] = None
    ):
        self.message = message
        self.error_code = error_code
        self.details = details or {}
        super().__init__(self.message)


class AuthenticationError(WalkerChatException):
    """Authentication related errors."""
    
    def __init__(self, message: str = "Authentication failed", **kwargs):
        super().__init__(message, error_code="AUTH_ERROR", **kwargs)


class AuthorizationError(WalkerChatException):
    """Authorization related errors."""
    
    def __init__(self, message: str = "Access denied", **kwargs):
        super().__init__(message, error_code="AUTHZ_ERROR", **kwargs)


class RateLimitError(WalkerChatException):
    """Rate limiting related errors."""
    
    def __init__(self, message: str = "Rate limit exceeded", **kwargs):
        super().__init__(message, error_code="RATE_LIMIT", **kwargs)


class WebSocketError(WalkerChatException):
    """WebSocket related errors."""
    
    def __init__(self, message: str = "WebSocket error", **kwargs):
        super().__init__(message, error_code="WS_ERROR", **kwargs)


class WebRTCError(WalkerChatException):
    """WebRTC related errors."""
    
    def __init__(self, message: str = "WebRTC error", **kwargs):
        super().__init__(message, error_code="WEBRTC_ERROR", **kwargs)


class DatabaseError(WalkerChatException):
    """Database related errors."""
    
    def __init__(self, message: str = "Database error", **kwargs):
        super().__init__(message, error_code="DB_ERROR", **kwargs)


async def walkerchat_exception_handler(
    request: Request, 
    exc: WalkerChatException
) -> JSONResponse:
    """Global exception handler for WalkerChat exceptions."""
    
    # Check if this is a WebSocket connection
    if request.url.path.startswith("/api/ws/") or request.url.path.startswith("/api/webrtc/"):
        # For WebSocket connections, we need to handle differently
        # Log the error but don't try to send JSON response
        logger.error(
            f"WebSocket exception: {exc.message}",
            error=exc,
            error_code=exc.error_code,
            details=exc.details,
            path=request.url.path
        )
        # Re-raise the exception to be handled by WebSocket protocol
        raise exc
    
    logger.error(
        f"Application exception: {exc.message}",
        error=exc,
        error_code=exc.error_code,
        details=exc.details,
        path=request.url.path
    )
    
    return JSONResponse(
        status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
        content={
            "error": {
                "code": exc.error_code or "INTERNAL_ERROR",
                "message": exc.message,
                "details": exc.details
            }
        }
    )


async def validation_exception_handler(
    request: Request, 
    exc: ValidationError
) -> JSONResponse:
    """Exception handler for Pydantic validation errors."""
    
    # Check if this is a WebSocket connection
    if request.url.path.startswith("/api/ws/") or request.url.path.startswith("/api/webrtc/"):
        # For WebSocket connections, log and re-raise
        logger.warning(
            f"WebSocket validation error for {request.url.path}",
            errors=exc.errors(),
            details={"validation_errors": exc.errors()}
        )
        raise exc
    
    logger.warning(
        f"Validation error for {request.url.path}",
        errors=exc.errors(),
        details={"validation_errors": exc.errors()}
    )
    
    return JSONResponse(
        status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
        content={
            "error": {
                "code": "VALIDATION_ERROR",
                "message": "Invalid request data",
                "details": {"validation_errors": exc.errors()}
            }
        }
    )


async def general_exception_handler(
    request: Request, 
    exc: Exception
) -> JSONResponse:
    """Global exception handler for unexpected errors."""
    
    # Check if this is a WebSocket connection
    if request.url.path.startswith("/api/ws/") or request.url.path.startswith("/api/webrtc/"):
        # For WebSocket connections, log and re-raise
        logger.error(
            f"WebSocket unexpected error in {request.url.path}",
            error=exc,
            exc_info=True
        )
        raise exc
    
    logger.error(
        f"Unexpected error in {request.url.path}",
        error=exc,
        exc_info=True
    )
    
    return JSONResponse(
        status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
        content={
            "error": {
                "code": "INTERNAL_ERROR",
                "message": "An unexpected error occurred",
                "details": {} if not logger.logger.isEnabledFor(logging.DEBUG) else {"error": str(exc)}
            }
        }
    )


def setup_exception_handlers(app) -> None:
    """Register all exception handlers with the FastAPI app."""
    app.add_exception_handler(WalkerChatException, walkerchat_exception_handler)
    app.add_exception_handler(ValidationError, validation_exception_handler)
    app.add_exception_handler(Exception, general_exception_handler)
