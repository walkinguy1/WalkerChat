import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import clsx from 'clsx';
import { Hash, ImageIcon, Lock, Search, Users } from 'lucide-react';
import { Avatar } from './ui/Avatar';
import { formatRelativeShort } from '../lib/format';
import {
  indexedChatCount,
  searchLocalIndex,
  searchLocalPhotos,
  type SearchEntry,
} from '../lib/search';
import type { BootstrapChat, BootstrapUser } from '../types/chat';

type Scope = 'all' | 'messages' | 'people' | 'rooms' | 'photos';

const SCOPES: { id: Scope; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'messages', label: 'Messages' },
  { id: 'people', label: 'People' },
  { id: 'rooms', label: 'Rooms' },
  { id: 'photos', label: 'Photos' },
];

const SECTION_LABELS: Record<Result['kind'], string> = {
  message: 'Messages',
  photo: 'Photos',
  person: 'People',
  room: 'Rooms',
};

interface CommandPaletteProps {
  isOpen: boolean;
  chats: BootstrapChat[];
  users: BootstrapUser[];
  currentUser: BootstrapUser;
  onClose: () => void;
  onSelectChat: (chatId: string) => void;
}

type Result =
  | {
      kind: 'message';
      chatId: string;
      entry: SearchEntry;
      matchStart: number;
      matchEnd: number;
    }
  | { kind: 'photo'; chatId: string; entry: SearchEntry }
  | { kind: 'person'; chatId: string | null; user: BootstrapUser }
  | { kind: 'room'; chatId: string; chat: BootstrapChat };

/** Show the match in context rather than the head of a long message. */
const Highlighted = ({ body, start, end }: { body: string; start: number; end: number }) => (
  <>
    {start > 48 ? '…' : null}
    {body.slice(Math.max(0, start - 48), start)}
    <mark className="rounded-[2px] bg-accent-soft px-0.5 text-ink">{body.slice(start, end)}</mark>
    {body.slice(end, end + 96)}
  </>
);

export const CommandPalette = ({
  isOpen,
  chats,
  users,
  currentUser,
  onClose,
  onSelectChat,
}: CommandPaletteProps) => {
  const [query, setQuery] = useState('');
  const [scope, setScope] = useState<Scope>('all');
  const [activeIndex, setActiveIndex] = useState(0);
  const [wasOpen, setWasOpen] = useState(isOpen);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Each open starts clean rather than resuming somebody's last search. Reset
  // during render so a stale query never paints for a frame.
  if (isOpen !== wasOpen) {
    setWasOpen(isOpen);
    if (isOpen) {
      setQuery('');
      setScope('all');
      setActiveIndex(0);
    }
  }

  useEffect(() => {
    if (isOpen) {
      inputRef.current?.focus();
    }
  }, [isOpen]);

  // Keep the highlighted row in view as the arrows walk past the fold.
  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>('[data-active="true"]')
      ?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  const chatById = useMemo(() => new Map(chats.map((chat) => [chat.id, chat])), [chats]);
  const userById = useMemo(() => new Map(users.map((user) => [user.id, user])), [users]);

  const results = useMemo<Result[]>(() => {
    if (!isOpen) return [];

    const needle = query.trim().toLowerCase();

    /** The thread to open when a person is picked. */
    const chatIdForUser = (userId: string) =>
      chats.find((chat) => chat.members.some((member) => member.user_id === userId))?.id ?? null;

    const messages: Result[] =
      scope === 'all' || scope === 'messages'
        ? searchLocalIndex(query, 8).map((hit) => ({
            kind: 'message',
            chatId: hit.chatId,
            entry: hit,
            matchStart: hit.matchStart,
            matchEnd: hit.matchEnd,
          }))
        : [];

    const photos: Result[] =
      scope === 'photos' || (scope === 'all' && needle)
        ? searchLocalPhotos(query, 6).map((entry) => ({
            kind: 'photo',
            chatId: entry.chatId,
            entry,
          }))
        : [];

    const people: Result[] =
      scope === 'all' || scope === 'people'
        ? users
            .filter(
              (user) =>
                !needle ||
                user.display_name.toLowerCase().includes(needle) ||
                user.username.toLowerCase().includes(needle),
            )
            .map((user) => ({ kind: 'person', chatId: chatIdForUser(user.id), user }))
        : [];

    const rooms: Result[] =
      scope === 'all' || scope === 'rooms'
        ? chats
            .filter((chat) => !needle || chat.name.toLowerCase().includes(needle))
            .map((chat) => ({ kind: 'room', chatId: chat.id, chat }))
        : [];

    return [...messages, ...photos, ...people, ...rooms];
  }, [chats, isOpen, query, scope, users]);

  const sectionCounts = useMemo(() => {
    const counts = new Map<Result['kind'], number>();
    results.forEach((result) => counts.set(result.kind, (counts.get(result.kind) ?? 0) + 1));
    return counts;
  }, [results]);

  if (!isOpen) return null;

  const openResult = (result: Result) => {
    if (result.chatId) {
      onSelectChat(result.chatId);
    }
    onClose();
  };

  const handleKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
      return;
    }

    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!results.length) return;
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setActiveIndex((index) => (index + step + results.length) % results.length);
      return;
    }

    if (event.key === 'Enter') {
      event.preventDefault();
      const result = results[activeIndex];
      if (result) openResult(result);
    }
  };

  const rowClasses = (index: number) =>
    clsx(
      'flex w-full gap-3 rounded-field p-2.5 text-left transition-colors',
      index === activeIndex ? 'bg-raised' : 'hover:bg-raised/70',
    );

  const renderRow = (result: Result, index: number) => {
    const shared = {
      'data-active': index === activeIndex,
      onMouseEnter: () => setActiveIndex(index),
      onClick: () => openResult(result),
    };

    if (result.kind === 'message') {
      const { entry } = result;
      const chat = chatById.get(entry.chatId);
      const sender = userById.get(entry.senderId);
      const senderName =
        entry.senderId === currentUser.id ? 'You' : (sender?.display_name ?? 'Unknown');

      return (
        <button key={`message-${entry.messageId}`} type="button" {...shared} className={rowClasses(index)}>
          <Avatar name={senderName} initials={sender?.initials} size="sm" className="h-8 w-8" />
          <span className="min-w-0 flex-1">
            <span className="flex items-baseline gap-2">
              <span className="text-[13px] font-semibold">{senderName}</span>
              {chat ? (
                <span className="flex items-center gap-1 text-[11px] text-ink-subtle">
                  {chat.kind === 'room' ? (
                    <Hash className="h-[11px] w-[11px]" aria-hidden="true" />
                  ) : null}
                  {chat.name}
                </span>
              ) : null}
              <span className="ml-auto flex-shrink-0 text-[11px] text-ink-subtle tabular-nums">
                {formatRelativeShort(entry.sentAt)}
              </span>
            </span>
            <span className="mt-0.5 block truncate text-[13px] leading-[1.5] text-ink-muted">
              <Highlighted body={entry.body} start={result.matchStart} end={result.matchEnd} />
            </span>
          </span>
        </button>
      );
    }

    if (result.kind === 'photo') {
      const { entry } = result;
      const chat = chatById.get(entry.chatId);

      return (
        <button
          key={`photo-${entry.messageId}`}
          type="button"
          {...shared}
          className={clsx(rowClasses(index), 'items-center')}
        >
          <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-raised text-ink-subtle">
            <ImageIcon className="h-[15px] w-[15px]" aria-hidden="true" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13px] font-semibold">
              {entry.body || 'Encrypted photo'}
            </span>
            <span className="mt-0.5 block text-[12px] text-ink-subtle">
              {chat?.name ?? 'Unknown thread'} · {formatRelativeShort(entry.sentAt)}
            </span>
          </span>
        </button>
      );
    }

    if (result.kind === 'person') {
      const { user } = result;

      return (
        <button
          key={`person-${user.id}`}
          type="button"
          {...shared}
          className={clsx(rowClasses(index), 'items-center')}
        >
          <Avatar
            name={user.display_name}
            initials={user.initials}
            size="sm"
            className="h-8 w-8"
            presence={user.presence_state}
          />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13px] font-semibold">
              {user.display_name}
              {user.id === currentUser.id ? (
                <span className="ml-1.5 font-normal text-ink-subtle">you</span>
              ) : null}
            </span>
            <span className="mt-0.5 block text-[12px] text-ink-subtle">@{user.username}</span>
          </span>
        </button>
      );
    }

    const { chat } = result;

    return (
      <button
        key={`room-${chat.id}`}
        type="button"
        {...shared}
        className={clsx(rowClasses(index), 'items-center')}
      >
        <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-raised text-ink-subtle">
          {chat.kind === 'room' ? (
            <Hash className="h-[15px] w-[15px]" aria-hidden="true" />
          ) : (
            <Users className="h-[15px] w-[15px]" aria-hidden="true" />
          )}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-semibold">{chat.name}</span>
          <span className="mt-0.5 block truncate text-[12px] text-ink-subtle">
            {chat.member_count} member{chat.member_count === 1 ? '' : 's'} · {chat.summary}
          </span>
        </span>
        <span className="flex-shrink-0 self-center font-mono text-[11px] text-ink-subtle">↵</span>
      </button>
    );
  };

  return (
    <div
      className="fixed inset-0 z-50 flex animate-fade justify-center bg-black/55 px-4 pt-[10vh] backdrop-blur-[2px]"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Search"
        onKeyDown={handleKeyDown}
        className="flex max-h-[76vh] w-full max-w-[37.5rem] animate-pop flex-col overflow-hidden rounded-panel border border-line bg-panel shadow-pop"
      >
        <div className="flex flex-shrink-0 items-center gap-3 border-b border-line px-[18px] py-4">
          <Search className="h-[18px] w-[18px] flex-shrink-0 text-ink-subtle" aria-hidden="true" />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActiveIndex(0);
            }}
            placeholder="Search messages, people and rooms"
            aria-label="Search"
            className="min-w-0 flex-1 bg-transparent text-[15px] placeholder:text-ink-subtle focus:outline-none"
          />
          <kbd className="flex-shrink-0 rounded border border-line bg-raised px-[7px] py-[3px] font-mono text-[10px] text-ink-subtle">
            ESC
          </kbd>
        </div>

        <div className="flex flex-shrink-0 items-center gap-1.5 border-b border-line px-[18px] py-2.5">
          {SCOPES.map((entry) => (
            <button
              key={entry.id}
              type="button"
              onClick={() => {
                setScope(entry.id);
                setActiveIndex(0);
              }}
              className={clsx(
                'flex h-[26px] items-center rounded-full px-2.5 text-[12px] transition-colors',
                scope === entry.id
                  ? 'bg-accent-soft font-medium text-accent-hover'
                  : 'text-ink-muted hover:bg-raised',
              )}
            >
              {entry.label}
            </button>
          ))}
        </div>

        <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto scroll-slim p-2">
          {results.length === 0 ? (
            <p className="px-2.5 py-10 text-center text-[13px] leading-6 text-ink-muted">
              {query.trim()
                ? `Nothing matches “${query.trim()}”.`
                : 'Type to search. Message text is searched in this browser only.'}
              <span className="mt-1.5 block text-[12px] text-ink-subtle">
                {indexedChatCount() === 0
                  ? 'No decrypted history is loaded yet — open a thread first.'
                  : `Covering decrypted history from ${indexedChatCount()} thread${
                      indexedChatCount() === 1 ? '' : 's'
                    } this device has opened.`}
              </span>
            </p>
          ) : null}

          {results.map((result, index) => (
            <div key={`${result.kind}-${index}`}>
              {results[index - 1]?.kind === result.kind ? null : (
                <p className="px-2.5 pt-2.5 pb-1.5 text-[11px] font-medium tracking-wide text-ink-subtle uppercase">
                  {SECTION_LABELS[result.kind]}
                  <span className="ml-1.5 text-ink-subtle/70">
                    {sectionCounts.get(result.kind)}
                  </span>
                </p>
              )}
              {renderRow(result, index)}
            </div>
          ))}
        </div>

        <div className="flex flex-shrink-0 items-center gap-3.5 border-t border-line bg-sunken px-[18px] py-2.5 text-[11px] text-ink-subtle">
          <span className="flex items-center gap-1.5">
            <span className="rounded border border-line bg-raised px-1.5 py-px font-mono">↑↓</span>
            navigate
          </span>
          <span className="flex items-center gap-1.5">
            <span className="rounded border border-line bg-raised px-1.5 py-px font-mono">↵</span>
            open
          </span>
          {/* The backend holds ciphertext, so there is no server-side search to
              send a query to. Saying so beats leaving the user to assume. */}
          <span className="ml-auto flex items-center gap-1.5">
            <Lock className="h-[11px] w-[11px] text-signal" aria-hidden="true" />
            Searched locally · 0 queries sent
          </span>
        </div>
      </div>
    </div>
  );
};
