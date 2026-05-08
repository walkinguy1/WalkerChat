import logging
import sys
from pathlib import Path

from app.core.config import get_settings

settings = get_settings()


def setup_logging() -> None:
    """Configure structured logging for the application."""
    
    # Create logs directory if it doesn't exist
    log_dir = Path("logs")
    log_dir.mkdir(exist_ok=True)
    
    # Configure logging format
    formatter = logging.Formatter(
        fmt="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S"
    )
    
    # Configure root logger
    root_logger = logging.getLogger()
    root_logger.setLevel(logging.INFO if not settings.debug else logging.DEBUG)
    
    # Clear existing handlers
    root_logger.handlers.clear()
    
    # Console handler
    console_handler = logging.StreamHandler(sys.stdout)
    console_handler.setFormatter(formatter)
    root_logger.addHandler(console_handler)
    
    # File handler for general logs
    file_handler = logging.FileHandler(log_dir / "app.log")
    file_handler.setFormatter(formatter)
    root_logger.addHandler(file_handler)
    
    # Error file handler
    error_handler = logging.FileHandler(log_dir / "errors.log")
    error_handler.setLevel(logging.ERROR)
    error_handler.setFormatter(formatter)
    root_logger.addHandler(error_handler)
    
    # Suppress noisy third-party loggers
    logging.getLogger("uvicorn.access").setLevel(logging.WARNING)
    logging.getLogger("sqlalchemy.engine").setLevel(
        logging.INFO if not settings.debug else logging.DEBUG
    )


class WalkerChatLogger:
    """Structured logger for WalkerChat operations."""
    
    def __init__(self, name: str):
        self.logger = logging.getLogger(name)
    
    def info(self, message: str, **kwargs) -> None:
        """Log info message with optional structured data."""
        if kwargs:
            self.logger.info(f"{message} | {kwargs}")
        else:
            self.logger.info(message)
    
    def error(self, message: str, error: Exception | None = None, **kwargs) -> None:
        """Log error message with optional exception details."""
        if error:
            self.logger.error(f"{message} | Error: {str(error)} | {kwargs}", exc_info=True)
        else:
            self.logger.error(f"{message} | {kwargs}")
    
    def warning(self, message: str, **kwargs) -> None:
        """Log warning message with optional structured data."""
        if kwargs:
            self.logger.warning(f"{message} | {kwargs}")
        else:
            self.logger.warning(message)
    
    def debug(self, message: str, **kwargs) -> None:
        """Log debug message with optional structured data."""
        if kwargs:
            self.logger.debug(f"{message} | {kwargs}")
        else:
            self.logger.debug(message)
    
    def websocket_event(self, user_id: str, event_type: str, **kwargs) -> None:
        """Log WebSocket events."""
        self.info(f"WebSocket Event", user_id=user_id, event_type=event_type, **kwargs)
    
    def webrtc_event(self, user_id: str, event_type: str, **kwargs) -> None:
        """Log WebRTC events."""
        self.info(f"WebRTC Event", user_id=user_id, event_type=event_type, **kwargs)
    
    def security_event(self, event_type: str, user_id: str | None = None, **kwargs) -> None:
        """Log security-related events."""
        self.warning(f"Security Event", event_type=event_type, user_id=user_id, **kwargs)
    
    def performance_metric(self, metric_name: str, value: float, **kwargs) -> None:
        """Log performance metrics."""
        self.info(f"Performance", metric=metric_name, value=value, **kwargs)
