import { useMemo } from 'react';
import clsx from 'clsx';
import { Hash, LogOut, Plus, Search, ShieldCheck, Users, X } from 'lucide-react';
import { Avatar } from './ui/Avatar';
import { Logo } from './ui/Logo';
import { IconButton } from './ui/Button';
import { ThemeToggle } from './ThemeToggle';
import { formatRelativeShort } from '../lib/format';
import type { BootstrapChat, BootstrapUser } from '../types/chat';

export type ConversationSummary = {
  chat: BootstrapChat;
  peerName: string;
  peerInitials: string;
  presence: 'online' | 'offline';
  preview: string;
  lastActivityAt: string | null;
  unreadCount: number;
};

interface SidebarProps {
  currentUser: BootstrapUser;
  currentUserRole?: string;
  conversations: ConversationSummary[];
  activeChatId: string | null;
  isSocketOpen: boolean;
  onSelectChat: (chatId: string) => void;
  onOpenSearch: () => void;
  onNewChat: () => void;
  onSignOut: () => void;
  onClose: () => void;
}

const SectionHeading = ({ label, count }: { label: string; count: number }) => (
  <p className="px-2 pt-2 pb-1.5 text-[11px] font-medium tracking-wide text-ink-subtle uppercase">
    {label}
    <span className="ml-1.5 text-ink-subtle/70">{count}</span>
  </p>
);

export const Sidebar = ({
  currentUser,
  currentUserRole,
  conversations,
  activeChatId,
  isSocketOpen,
  onSelectChat,
  onOpenSearch,
  onNewChat,
  onSignOut,
  onClose,
}: SidebarProps) => {
  // Rooms and direct threads are listed apart so the roster reads at a glance.
  const { rooms, directs } = useMemo(
    () => ({
      rooms: conversations.filter((conversation) => conversation.chat.kind === 'room'),
      directs: conversations.filter((conversation) => conversation.chat.kind !== 'room'),
    }),
    [conversations],
  );

  const renderRow = (conversation: ConversationSummary) => {
    const isActive = conversation.chat.id === activeChatId;
    const isRoom = conversation.chat.kind === 'room';
    const isGroupRoom = isRoom && conversation.chat.type !== 'DIRECT';

    return (
      <li key={conversation.chat.id}>
        <button
          type="button"
          aria-current={isActive ? 'true' : undefined}
          onClick={() => onSelectChat(conversation.chat.id)}
          className={clsx(
            'group flex w-full items-center gap-3 rounded-field px-2 text-left transition-colors duration-150',
            isRoom ? 'py-2' : 'py-2.5',
            isActive
              ? 'bg-accent-soft shadow-[inset_2px_0_0_var(--wc-accent)]'
              : 'hover:bg-raised',
          )}
        >
          {isRoom ? (
            isGroupRoom ? (
              <Users
                className={clsx(
                  'h-4 w-4 flex-shrink-0',
                  isActive ? 'text-accent-hover' : 'text-ink-subtle',
                )}
                aria-hidden="true"
              />
            ) : (
              <Hash
                className={clsx(
                  'h-4 w-4 flex-shrink-0',
                  isActive ? 'text-accent-hover' : 'text-ink-subtle',
                )}
                aria-hidden="true"
              />
            )
          ) : (
            <Avatar
              name={conversation.peerName}
              initials={conversation.peerInitials}
              size="md"
              presence={conversation.presence}
            />
          )}

          <span className="min-w-0 flex-1">
            <span className="flex items-baseline gap-2">
              <span
                className={clsx(
                  'min-w-0 flex-1 truncate text-sm',
                  isActive ? 'font-semibold text-ink' : 'font-medium text-ink',
                )}
              >
                {conversation.chat.name}
              </span>
              {conversation.lastActivityAt ? (
                <span className="flex-shrink-0 text-[11px] text-ink-subtle tabular-nums">
                  {formatRelativeShort(conversation.lastActivityAt)}
                </span>
              ) : null}
            </span>

            {isRoom ? null : (
              <span className="mt-0.5 flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-[13px] text-ink-muted">
                  {conversation.preview}
                </span>
                {conversation.unreadCount > 0 ? (
                  <span className="flex h-[18px] min-w-[18px] flex-shrink-0 items-center justify-center rounded-full bg-accent px-1.5 text-[10px] font-semibold text-on-accent tabular-nums">
                    {conversation.unreadCount > 99 ? '99+' : conversation.unreadCount}
                  </span>
                ) : null}
              </span>
            )}
          </span>
        </button>
      </li>
    );
  };

  return (
    <div className="flex h-full flex-col bg-panel">
      {/* Brand row */}
      <div className="flex h-16 flex-shrink-0 items-center gap-2.5 border-b border-line px-4">
        <Logo className="h-8 w-8" />
        <span className="flex-1 text-[15px] font-semibold tracking-tight">WalkerChat</span>
        <ThemeToggle size="sm" />
        <IconButton size="sm" label="Close navigation" onClick={onClose} className="lg:hidden">
          <X className="h-4 w-4" aria-hidden="true" />
        </IconButton>
      </div>

      {/* Search opens the command palette — one search for threads, people and
          decrypted message text, rather than a second filter that only sees
          conversation names. */}
      <div className="flex flex-shrink-0 items-center gap-2 px-3 pt-3 pb-2">
        <button
          type="button"
          onClick={onOpenSearch}
          className="relative flex h-10 flex-1 items-center gap-2.5 rounded-field border border-line bg-sunken pr-2.5 pl-3 text-left text-sm text-ink-subtle transition-colors hover:border-line-strong"
        >
          <Search className="h-4 w-4 flex-shrink-0" aria-hidden="true" />
          <span className="flex-1 truncate">Search everything</span>
          <kbd className="hidden flex-shrink-0 rounded border border-line bg-raised px-1.5 py-0.5 font-mono text-[10px] lg:block">
            ⌘K
          </kbd>
        </button>

        <IconButton size="md" label="New conversation" variant="secondary" onClick={onNewChat}>
          <Plus className="h-4 w-4" aria-hidden="true" />
        </IconButton>
      </div>

      {/* Conversation list */}
      <nav
        aria-label="Conversations"
        className="min-h-0 flex-1 overflow-y-auto scroll-slim px-2 pb-2"
      >
        {rooms.length ? (
          <>
            <SectionHeading label="Rooms" count={rooms.length} />
            <ul className="space-y-0.5">{rooms.map(renderRow)}</ul>
          </>
        ) : null}

        <div className={clsx(rooms.length && 'mt-3.5')}>
          <SectionHeading label="Direct" count={directs.length} />
          {directs.length === 0 ? (
            <p className="px-2 py-6 text-center text-[13px] text-ink-subtle">
              No direct threads yet.
            </p>
          ) : (
            <ul className="space-y-0.5">{directs.map(renderRow)}</ul>
          )}
        </div>
      </nav>

      {/* Account footer */}
      <div className="flex-shrink-0 border-t border-line p-3">
        <div className="flex items-center gap-3 rounded-field p-1.5">
          <Avatar
            name={currentUser.display_name}
            initials={currentUser.initials}
            size="md"
            presence={isSocketOpen ? 'online' : 'offline'}
          />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium">{currentUser.display_name}</span>
            <span className="mt-0.5 flex items-center gap-1 text-[11px] text-ink-muted">
              <ShieldCheck className="h-3 w-3 flex-shrink-0 text-signal" aria-hidden="true" />
              <span className="truncate">
                {currentUserRole ? `${currentUserRole} · ` : null}@{currentUser.username}
              </span>
            </span>
          </span>
          <IconButton size="sm" label="Sign out" onClick={onSignOut}>
            <LogOut className="h-4 w-4" aria-hidden="true" />
          </IconButton>
        </div>
      </div>
    </div>
  );
};
