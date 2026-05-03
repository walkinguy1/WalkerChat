import { useEffect, useRef, useState } from 'react';

export type ConnectionState = 'connecting' | 'open' | 'closed' | 'error';

type UseWebSocketOptions<TMessage> = {
  onMessage?: (message: TMessage) => void;
  onClose?: (event: CloseEvent) => void;
};

const NON_RETRYABLE_CLOSE_CODES = new Set([4001, 4003]);

export const useWebSocket = <TMessage,>(
  url: string | null,
  options: UseWebSocketOptions<TMessage> = {},
) => {
  const socketRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const messageHandlerRef = useRef(options.onMessage);
  const closeHandlerRef = useRef(options.onClose);
  const [connectionState, setConnectionState] = useState<ConnectionState>(
    url ? 'connecting' : 'closed',
  );

  useEffect(() => {
    messageHandlerRef.current = options.onMessage;
    closeHandlerRef.current = options.onClose;
  }, [options.onClose, options.onMessage]);

  useEffect(() => {
    let isActive = true;

    if (!url) {
      return () => {
        isActive = false;
      };
    }

    const connect = () => {
      setConnectionState('connecting');
      const socket = new WebSocket(url);
      socketRef.current = socket;

      socket.onopen = () => {
        setConnectionState('open');
      };

      socket.onmessage = (event) => {
        try {
          const parsedMessage = JSON.parse(event.data) as TMessage;
          messageHandlerRef.current?.(parsedMessage);
        } catch (error) {
          console.error('Failed to parse incoming payload.', error);
        }
      };

      socket.onerror = () => {
        setConnectionState('error');
      };

      socket.onclose = (event) => {
        if (!isActive) {
          return;
        }

        closeHandlerRef.current?.(event);
        setConnectionState('closed');

        if (NON_RETRYABLE_CLOSE_CODES.has(event.code)) {
          return;
        }

        reconnectTimerRef.current = window.setTimeout(connect, 1500);
      };
    };

    connect();

    return () => {
      isActive = false;
      if (reconnectTimerRef.current !== null) {
        window.clearTimeout(reconnectTimerRef.current);
      }
      socketRef.current?.close();
    };
  }, [url]);

  const sendMessage = (message: TMessage) => {
    if (socketRef.current?.readyState !== WebSocket.OPEN) {
      return false;
    }

    socketRef.current.send(JSON.stringify(message));
    return true;
  };

  return { connectionState: url ? connectionState : 'closed', sendMessage };
};
