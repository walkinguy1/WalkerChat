import clsx from 'clsx';
import { Hash, Lock, Menu, Phone, ShieldAlert, Video } from 'lucide-react';
import { Avatar } from './ui/Avatar';
import { IconButton } from './ui/Button';
import type { ConnectionState } from '../hooks/useWebSocket';
import type { BootstrapChat, BootstrapChatMember, CallMediaKind } from '../types/chat';

interface ChatHeaderProps {
  chat: BootstrapChat;
  peer: BootstrapChatMember | null;
  peerPresence: 'online' | 'offline';
  connectionState: ConnectionState;
  isSecure: boolean;
  isPeerTyping: boolean;
  canCall: boolean;
  onlineCount: number;
  onStartCall: (media: CallMediaKind) => void;
  onOpenSidebar: () => void;
}

const connectionCopy: Record<ConnectionState, string> = {
  open: 'Connected',
  connecting: 'Connecting…',
  closed: 'Reconnecting…',
  error: 'Connection failed',
};

/** Faces shown before the header collapses the rest into a "+n". */
const AVATAR_STACK_LIMIT = 3;

export const ChatHeader = ({
  chat,
  peer,
  peerPresence,
  connectionState,
  isSecure,
  isPeerTyping,
  canCall,
  onlineCount,
  onStartCall,
  onOpenSidebar,
}: ChatHeaderProps) => {
  const isRoom = chat.kind === 'room';
  const isOnline = peerPresence === 'online';

  const stacked = chat.members.slice(0, AVATAR_STACK_LIMIT);
  const overflowCount = Math.max(0, chat.members.length - stacked.length);

  // One line under the title, priority ordered: typing beats presence, and a
  // broken socket beats both because it explains why nothing is moving.
  const subtitle = isPeerTyping
    ? `${peer?.display_name ?? 'Someone'} is typing…`
    : connectionState !== 'open'
      ? connectionCopy[connectionState]
      : isRoom
        ? `${chat.member_count} members`
        : peer
          ? isOnline
            ? 'Online'
            : 'Offline'
          : chat.summary;

  return (
    <header className="flex h-16 flex-shrink-0 items-center gap-3 border-b border-line bg-panel px-3 sm:px-5">
      <IconButton size="sm" label="Open navigation" onClick={onOpenSidebar} className="lg:hidden">
        <Menu className="h-4 w-4" aria-hidden="true" />
      </IconButton>

      {isRoom ? null : (
        <Avatar
          name={peer?.display_name ?? chat.name}
          initials={peer?.initials}
          size="md"
          presence={peer ? peerPresence : null}
        />
      )}

      <div className="min-w-0 flex-1">
        <h1 className="flex items-center gap-1.5 text-[15px] leading-tight font-semibold tracking-tight">
          {isRoom ? (
            <Hash className="h-[15px] w-[15px] flex-shrink-0 text-ink-subtle" aria-hidden="true" />
          ) : null}
          <span className="truncate">{isRoom ? chat.name : (peer?.display_name ?? chat.name)}</span>

          {/* Encryption is the default, so it whispers: a padlock the tooltip
              explains. It only raises its voice when something is wrong. */}
          {isSecure ? (
            <span
              title="End-to-end encrypted with a shared AES-GCM key"
              aria-label="End-to-end encrypted"
              className="flex-shrink-0 text-ink-subtle"
            >
              <Lock className="h-3 w-3" aria-hidden="true" />
            </span>
          ) : (
            <span
              title="Waiting for the ECDH key exchange to finish"
              className="inline-flex flex-shrink-0 items-center gap-1 rounded-full border border-warn/30 bg-warn-soft px-2 py-0.5 text-[10px] font-medium text-warn"
            >
              <ShieldAlert className="h-3 w-3 animate-blink" aria-hidden="true" />
              Key exchange
            </span>
          )}
        </h1>

        <p
          className={clsx(
            'mt-0.5 truncate text-[12px] leading-tight',
            isPeerTyping
              ? 'text-accent'
              : connectionState === 'error'
                ? 'text-danger'
                : isOnline && connectionState === 'open' && !isRoom
                  ? 'text-signal'
                  : 'text-ink-muted',
          )}
        >
          {subtitle}
          {isRoom && connectionState === 'open' && !isPeerTyping ? (
            <>
              {' · '}
              <span className="text-signal">{onlineCount} online</span>
            </>
          ) : null}
        </p>
      </div>

      {isRoom ? (
        <div className="mr-1 hidden items-center sm:flex">
          {stacked.map((member, index) => (
            <Avatar
              key={member.user_id}
              name={member.display_name}
              initials={member.initials}
              size="xs"
              className={clsx('ring-2 ring-panel', index > 0 && '-ml-2')}
            />
          ))}
          {overflowCount > 0 ? (
            <span className="-ml-2 flex h-7 w-7 items-center justify-center rounded-full bg-raised text-[10px] font-semibold text-ink-muted ring-2 ring-panel">
              +{overflowCount}
            </span>
          ) : null}
        </div>
      ) : null}

      <div className="flex items-center gap-1">
        <IconButton
          label="Start a voice call"
          disabled={!canCall}
          onClick={() => onStartCall('audio')}
        >
          <Phone className="h-[18px] w-[18px]" aria-hidden="true" />
        </IconButton>
        <IconButton
          label="Start a video call"
          disabled={!canCall}
          onClick={() => onStartCall('video')}
        >
          <Video className="h-[18px] w-[18px]" aria-hidden="true" />
        </IconButton>
      </div>
    </header>
  );
};
