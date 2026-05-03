import { useEffect, useEffectEvent, useRef, useState } from 'react';

export type ConnectionState = 'connecting' | 'open' | 'closed' | 'error';

type UseWebSocketOptions<TMessage> = {
  onMessage?: (message: TMessage) => void;
};

export const useWebSocket = <TMessage,>(
  url: string | null,
  options: UseWebSocketOptions<TMessage> = {},
) => {
  const socketRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const [connectionState, setConnectionState] = useState<ConnectionState>(
    url ? 'connecting' : 'closed',
  );

  const handleMessage = useEffectEvent((message: TMessage) => {
    options.onMessage?.(message);
  });

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
          handleMessage(parsedMessage);
        } catch (error) {
          console.error('Failed to parse incoming payload.', error);
        }
      };

      socket.onerror = () => {
        setConnectionState('error');
      };

      socket.onclose = () => {
        if (!isActive) {
          return;
        }

        setConnectionState('closed');
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
