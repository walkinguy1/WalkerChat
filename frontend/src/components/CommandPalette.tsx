import { useEffect, useMemo, useRef, useState } from 'react';
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

interface CommandPaletteProps {
  isOpen: boolean;
  chats: BootstrapChat[];
  users: BootstrapUser[];
  currentUser: BootstrapUser;
  onClose: () => void;
  onSelectChat: (chatId: string) => void;
}

type Result =
  | { kind: 'message'; key: string; entry: SearchEntry; matchStart: number; matchEnd: number }
  | { kind: 'photo'; key: string; entry: SearchEntry }
  | { kind: 'person'; key: string; user: BootstrapUser; chatId: string | null }
  | { kind: 'room'; key: string; chat: BootstrapChat };

const Highlighted = ({
  body,
  start,
  end,
}: {
  body: string;
  start: number;
  end: number;
}) => (
  <>
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
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Each open starts clean rather than resuming somebody's last search.
  useEffect(() => {
    if (!isOpen) return;
    setQuery('');
    setScope('all');
    setActiveIndex(0);
    inputRef.current?.focus();
  }, [isOpen]);

  const chatNameById = useMemo(
    () => new Map(chats.map((chat) => [chat.id, chat])),
    [chats],
  );

  const userNameById = useMemo(
    () => new Map(users.map((user) => [user.id, user])),
    [users],
  );

  const { messages, photos, people, rooms } = useMemo(() => {
    if (!isOpen) {
      return { messages: [], photos: [], people: [], rooms: [] };
    }

    const needle = query.trim().toLowerCase();

    const matchedMessages =
      scope === 'all' || scope === 'messages' ? searchLocalIndex(query, 8) : [];

    const matchedPhotos =
      scope === 'photos' || (scope === 'all' && needle) ? searchLocalPhotos(query, 6) : [];

    const matchedPeople =
      scope === 'all' || scope === 'people'
        ? users.filter(
            (user) =>
              !needle ||
              user.display_name.toLowerCase().includes(needle) ||
              user.username.toLowerCase().includes(needle),
          )
        : [];

    const matchedRooms =
      scope === 'all' || scope === 'rooms'
        ? chats.filter((chat) => !needle || chat.name.toLowerCase().includes(needle))
        : [];

    return {
      messages: matchedMessages,
      photos: matchedPhotos,
      people: matchedPeople,
      rooms: matchedRooms,
    };
  }, [chats, isOpen, query, scope, users]);

  /** Which thread to open when a person is picked. */
  const chatIdForUser = (userId: string) =>
    chats.find((chat) => chat.members.some((member) => member.user_id === userId))?.id ?? null;

  const results = useMemo<Result[]>(
    () => [
      ...messages.map<Result>((hit) => ({
        kind: 'message',
        key: `message-${hit.messageId}`,
        entry: hit,
        matchStart: hit.matchStart,
        matchEnd: hit.matchEnd,
      })),
      ...photos.map<Result>((entry) => ({
        kind: 'photo',
        key: `photo-${entry.messageId}`,
        entry,
      })),
      ...people.map<Result>((user) => ({
        kind: 'person',
        key: `person-${user.id}`,
        user,
        chatId: chatIdForUser(user.id),
      })),
      ...rooms.map<Result>((chat) => ({ kind: 'room', key: `room-${chat.id}`, chat })),
    ],
    // chatIdForUser only reads `chats`, which is already a dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [chats, messages, people, photos, rooms],
  );

  useEffect(() => setActiveIndex(0), [query, scope]);

  // Keep the highlighted row in view as the arrows walk past the fold.
  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>('[data-active="true"]')
      ?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  if (!isOpen) return null;

  const openResult = (result: Result) => {
    const chatId =
      result.kind === 'room'
        ? result.chat.id
        : result.kind === 'person'
          ? result.chatId
          : result.entry.chatId;

    if (chatId) {
      onSelectChat(chatId);
    }
    onClose();
  };

  const handleKeyDown = (event: React.KeyboardEvent) => {
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

  let rowIndex = -1;
  const nextRowIndex = () => {
    rowIndex += 1;
    return rowIndex;
  };

  const rowClasses = (index: number) =>
    clsx(
      'flex w-full gap-3 rounded-field p-2.5 text-left transition-colors',
      index === activeIndex ? 'bg-raised' : 'hover:bg-raised/70',
    );

  const sectionHeading = (label: string, count?: number) => (
    <p className="px-2.5 pt-2.5 pb-1.5 text-[11px] font-medium tracking-wide text-ink-subtle uppercase">
      {label}
      {count === undefined ? null : <span className="ml-1.5 text-ink-subtle/70">{count}</span>}
    </p>
  );

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
            onChange={(event) => setQuery(event.target.value)}
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
              onClick={() => setScope(entry.id)}
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

          {messages.length ? sectionHeading('Messages', messages.length) : null}
          {messages.map((hit) => {
            const index = nextRowIndex();
            const chat = chatNameById.get(hit.chatId);
            const sender = userNameById.get(hit.senderId);
            const senderName =
              hit.senderId === currentUser.id ? 'You' : (sender?.display_name ?? 'Unknown');

            return (
              <button
                key={`message-${hit.messageId}`}
                type="button"
                data-active={index === activeIndex}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => openResult({ kind: 'message', key: '', entry: hit, matchStart: hit.matchStart, matchEnd: hit.matchEnd })}
                className={rowClasses(index)}
              >
                <Avatar
                  name={senderName}
                  initials={sender?.initials}
                  size="sm"
                  className="h-8 w-8"
                />
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
                      {formatRelativeShort(hit.sentAt)}
                    </span>
                  </span>
                  <span className="mt-0.5 block truncate text-[13px] leading-[1.5] text-ink-muted">
                    <Highlighted body={hit.body} start={hit.matchStart} end={hit.matchEnd} />
                  </span>
                </span>
              </button>
            );
          })}

          {photos.length ? sectionHeading('Photos', photos.length) : null}
          {photos.map((entry) => {
            const index = nextRowIndex();
            const chat = chatNameById.get(entry.chatId);

            return (
              <button
                key={`photo-${entry.messageId}`}
                type="button"
                data-active={index === activeIndex}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => openResult({ kind: 'photo', key: '', entry })}
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
          })}

          {people.length ? sectionHeading('People', people.length) : null}
          {people.map((user) => {
            const index = nextRowIndex();
            const chatId = chatIdForUser(user.id);

            return (
              <button
                key={`person-${user.id}`}
                type="button"
                data-active={index === activeIndex}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => openResult({ kind: 'person', key: '', user, chatId })}
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
          })}

          {rooms.length ? sectionHeading('Rooms', rooms.length) : null}
          {rooms.map((chat) => {
            const index = nextRowIndex();

            return (
              <button
                key={`room-${chat.id}`}
                type="button"
                data-active={index === activeIndex}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => openResult({ kind: 'room', key: '', chat })}
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
                <span className="flex-shrink-0 self-center font-mono text-[11px] text-ink-subtle">
                  ↵
                </span>
              </button>
            );
          })}
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
          <span className="ml-auto flex items-center gap-1.5">
            <Lock className="h-[11px] w-[11px] text-signal" aria-hidden="true" />
            Searched locally · 0 queries sent
          </span>
        </div>
      </div>
    </div>
  );
};
