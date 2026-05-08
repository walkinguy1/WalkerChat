import { useEffect, useRef } from 'react';
import type { BootstrapChatMember, BootstrapUser, DisplayMessage } from '../types/chat';

interface ChatInterfaceProps {
  messages: DisplayMessage[];
  currentUser: BootstrapUser | null;
  peer: BootstrapChatMember | null;
  isTyping: boolean;
  connectionLabel: string;
}

export const ChatInterface = ({
  messages,
  currentUser,
  peer,
  isTyping,
  connectionLabel,
}: ChatInterfaceProps) => {
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  const formatTime = (timestamp: string) => {
    return new Date(timestamp).toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit'
    });
  };


  return (
    <div className="relative h-full overflow-y-auto">
      <div className="pointer-events-none sticky top-0 z-10 px-1 pb-2 pt-1">
        <div className="mx-auto w-fit rounded-full border border-white/15 bg-[#130f0bcc] px-4 py-1 text-[11px] font-semibold uppercase tracking-[0.2em] text-[#f3d6aa] backdrop-blur">
          {connectionLabel}
        </div>
      </div>

      <div className="space-y-4 px-2 pb-2">
        {messages.map((message, index) => {
          const isOwn = message.senderId === currentUser?.id;
          const showAvatar = index === 0 || messages[index - 1]?.senderId !== message.senderId;
          
          return (
            <div
              key={message.id}
              className={`flex ${isOwn ? 'justify-end' : 'justify-start'} ${showAvatar ? 'mt-6' : 'mt-1.5'}`}
            >
              <div className={`flex ${isOwn ? 'flex-row-reverse' : 'flex-row'} max-w-[78%] gap-3`}>
                {showAvatar && !isOwn && (
                  <div className="h-9 w-9 flex-shrink-0 rounded-full border border-white/10 bg-gradient-to-br from-[#ffbf6f] to-[#c2762b] text-center text-xs font-bold leading-9 text-[#2a1807] shadow">
                    {peer?.display_name?.[0]?.toUpperCase() || '?'}
                  </div>
                )}
                
                <div className={`flex flex-col ${isOwn ? 'items-end' : 'items-start'}`}>
                  {showAvatar ? (
                    <span className="mb-1 px-1 text-[11px] font-medium uppercase tracking-[0.14em] text-[#d6b17d]">
                      {isOwn ? 'You' : (peer?.display_name ?? 'Peer')}
                    </span>
                  ) : null}
                  <div
                    className={`px-4 py-2 rounded-2xl ${
                      isOwn
                        ? 'rounded-br-md border border-[#5abf9d66] bg-gradient-to-br from-[#3f8d74] to-[#255547] text-[#f2fff9] shadow-[0_8px_24px_-14px_rgba(61,167,131,0.9)]'
                        : 'rounded-bl-md border border-[#f3cf9a55] bg-gradient-to-br from-[#2c2117] to-[#19130d] text-[#ffe9cb] shadow-[0_10px_24px_-14px_rgba(255,193,112,0.4)]'
                    }`}
                  >
                    <p className="text-sm leading-relaxed break-words">{message.body}</p>
                  </div>
                  
                  <div className={`mt-1.5 flex items-center gap-1 px-1 text-[11px] text-[#9d8a72] ${isOwn ? 'flex-row-reverse' : 'flex-row'}`}>
                    <span>{formatTime(message.sentAt)}</span>
                    {message.state === 'sent' && (
                      <span className="text-[#7ed0b2]">Delivered</span>
                    )}
                  </div>
                </div>
                
                {showAvatar && isOwn && (
                  <div className="h-9 w-9 flex-shrink-0 rounded-full border border-white/10 bg-gradient-to-br from-[#86d9bd] to-[#44977c] text-center text-xs font-bold leading-9 text-[#10261c] shadow">
                    {currentUser?.display_name?.[0]?.toUpperCase() || '?'}
                  </div>
                )}
              </div>
            </div>
          );
        })}
        
        {isTyping && (
          <div className="flex justify-start">
            <div className="flex max-w-[78%] gap-3">
              <div className="h-9 w-9 flex-shrink-0 rounded-full border border-white/10 bg-gradient-to-br from-[#ffbf6f] to-[#c2762b] text-center text-xs font-bold leading-9 text-[#2a1807] shadow">
                {peer?.display_name?.[0]?.toUpperCase() || '?'}
              </div>
              <div className="rounded-2xl rounded-bl-md border border-[#f3cf9a55] bg-gradient-to-br from-[#2c2117] to-[#19130d] px-4 py-2.5 text-[#ffe9cb]">
                <div className="flex gap-1">
                  <div className="h-2 w-2 animate-bounce rounded-full bg-[#f6c07b]" style={{ animationDelay: '0ms' }} />
                  <div className="h-2 w-2 animate-bounce rounded-full bg-[#f6c07b]" style={{ animationDelay: '120ms' }} />
                  <div className="h-2 w-2 animate-bounce rounded-full bg-[#f6c07b]" style={{ animationDelay: '240ms' }} />
                </div>
              </div>
            </div>
          </div>
        )}
        
        <div ref={messagesEndRef} />
      </div>
    </div>
  );
};
