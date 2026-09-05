import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import { ArrowDown, Lock } from 'lucide-react';
import { MessageBubble } from './MessageBubble';
import { Avatar } from './ui/Avatar';
import { formatDayDivider, isSameCalendarDay } from '../lib/format';
import type {
  BootstrapChatMember,
  BootstrapUser,
  DisplayMessage,
  ReactionTally,
} from '../types/chat';

export type HistoryState = 'idle' | 'loading' | 'ready' | 'error';

interface MessageListProps {
  messages: DisplayMessage[];
  currentUser: BootstrapUser;
  peer: BootstrapChatMember | null;
  isPeerTyping: boolean;
  historyState: HistoryState;
  reactionsByMessageId: Map<string, ReactionTally[]>;
  apiUrl: string;
  authToken: string | null;
  onOpenImage: (objectUrl: string, name: string) => void;
  onReply: (message: DisplayMessage) => void;
  onToggleReaction: (message: DisplayMessage, emoji: string) => void;
}

const NO_REACTIONS: ReactionTally[] = [];

/** Distance from the bottom that still counts as "following the thread". */
const STICK_THRESHOLD_PX = 120;

type Row =
  | { kind: 'divider'; key: string; label: string }
  | {
      kind: 'message';
      key: string;
      message: DisplayMessage;
      startsGroup: boolean;
      endsGroup: boolean;
    };

/**
 * Flatten messages into render rows, inserting day dividers and marking the
 * first/last message of each same-author run.
 */
const buildRows = (messages: DisplayMessage[]): Row[] => {
  const rows: Row[] = [];

  messages.forEach((message, index) => {
    const previous = messages[index - 1];
    const next = messages[index + 1];

    const isNewDay = !previous || !isSameCalendarDay(previous.sentAt, message.sentAt);
    if (isNewDay) {
      rows.push({
        kind: 'divider',
        key: `divider-${message.id}`,
        label: formatDayDivider(message.sentAt),
      });
    }

    const startsGroup = isNewDay || previous?.senderId !== message.senderId;
    const endsGroup =
      !next ||
      next.senderId !== message.senderId ||
      !isSameCalendarDay(message.sentAt, next.sentAt);

    rows.push({ kind: 'message', key: message.id, message, startsGroup, endsGroup });
  });

  return rows;
};

const HistorySkeleton = () => (
  <div className="space-y-6 px-1 py-4" aria-hidden="true">
    {[0, 1, 2, 3].map((row) => {
      const isOwn = row % 2 === 1;
      return (
        <div key={row} className={clsx('flex gap-2.5', isOwn && 'flex-row-reverse')}>
          <span className="h-8 w-8 flex-shrink-0 animate-sheen rounded-full bg-raised" />
          <span
            className="h-12 animate-sheen rounded-2xl bg-raised"
            style={{ width: `${38 + row * 9}%` }}
          />
        </div>
      );
    })}
  </div>
);

const EmptyThread = ({ peerName }: { peerName: string }) => (
  <div className="flex h-full flex-col items-center justify-center px-6 py-16 text-center">
    <span className="mb-5 flex h-14 w-14 items-center justify-center rounded-2xl border border-line bg-raised">
      <Lock className="h-6 w-6 text-accent" aria-hidden="true" />
    </span>
    <h2 className="text-[15px] font-semibold">This thread is empty</h2>
    <p className="mt-2 max-w-sm text-[13px] leading-6 text-ink-muted">
      Messages you send to {peerName} are encrypted in this browser before they are
      uploaded. Say something to start the thread.
    </p>
  </div>
);

export const MessageList = ({
  messages,
  currentUser,
  peer,
  isPeerTyping,
  historyState,
  reactionsByMessageId,
  apiUrl,
  authToken,
  onOpenImage,
  onReply,
  onToggleReaction,
}: MessageListProps) => {
  const scrollRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const isPinnedRef = useRef(true);
  const [showJumpButton, setShowJumpButton] = useState(false);
  const [missedCount, setMissedCount] = useState(0);

  const rows = useMemo(() => buildRows(messages), [messages]);
  const peerName = peer?.display_name ?? 'your peer';

  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'smooth') => {
    bottomRef.current?.scrollIntoView({ behavior, block: 'end' });
    isPinnedRef.current = true;
    setShowJumpButton(false);
    setMissedCount(0);
  }, []);

  const handleScroll = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;

    const distanceFromBottom =
      element.scrollHeight - element.scrollTop - element.clientHeight;
    const isPinned = distanceFromBottom < STICK_THRESHOLD_PX;

    isPinnedRef.current = isPinned;
    setShowJumpButton(!isPinned);
    if (isPinned) {
      setMissedCount(0);
    }
  }, []);

  // Count what a reader who has scrolled up has missed. Done during render
  // rather than in an effect so it never causes a second render pass.
  // `showJumpButton` is the rendered mirror of isPinnedRef, so it is the value
  // to consult here — refs must not be read during render.
  const [seenMessages, setSeenMessages] = useState(messages);
  if (messages !== seenMessages) {
    const isAddition = messages.length > seenMessages.length;
    const latest = messages[messages.length - 1];
    setSeenMessages(messages);

    if (showJumpButton && isAddition && latest && latest.senderId !== currentUser.id) {
      setMissedCount((count) => count + 1);
    }
  }

  // Only auto-scroll a reader who is already at the bottom; otherwise the jump
  // button offers the move instead of yanking the viewport out from under them.
  useLayoutEffect(() => {
    if (messages.length && isPinnedRef.current) {
      bottomRef.current?.scrollIntoView({ block: 'end' });
    }
  }, [messages]);

  // A fresh thread always opens at the newest message.
  useEffect(() => {
    if (historyState === 'ready') {
      isPinnedRef.current = true;
      bottomRef.current?.scrollIntoView({ block: 'end' });
    }
  }, [historyState]);

  const isEmpty = historyState === 'ready' && messages.length === 0;

  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="h-full overflow-y-auto scroll-slim px-3 sm:px-6"
      >
        <div className="mx-auto flex min-h-full w-full max-w-3xl flex-col justify-end pb-4">
          {historyState === 'loading' ? <HistorySkeleton /> : null}

          {historyState === 'error' ? (
            <div className="my-6 rounded-card border border-danger/30 bg-danger-soft p-4 text-center text-[13px] text-danger">
              Encrypted history could not be loaded for this thread.
            </div>
          ) : null}

          {isEmpty ? <EmptyThread peerName={peerName} /> : null}

          {/* aria-live keeps screen readers informed of incoming messages
              without them having to re-read the whole thread. */}
          <div aria-live="polite" aria-relevant="additions">
            {rows.map((row) =>
              row.kind === 'divider' ? (
                <div key={row.key} className="my-5 flex items-center gap-3">
                  <span className="h-px flex-1 bg-line" />
                  <span className="text-[11px] font-medium text-ink-subtle">{row.label}</span>
                  <span className="h-px flex-1 bg-line" />
                </div>
              ) : (
                <MessageBubble
                  key={row.key}
                  message={row.message}
                  isOwn={row.message.senderId === currentUser.id}
                  authorName={
                    row.message.senderId === currentUser.id
                      ? currentUser.display_name
                      : peerName
                  }
                  authorInitials={
                    row.message.senderId === currentUser.id
                      ? currentUser.initials
                      : peer?.initials
                  }
                  replyAuthorName={
                    row.message.replyTo
                      ? row.message.replyTo.sender_id === currentUser.id
                        ? currentUser.display_name
                        : peerName
                      : undefined
                  }
                  reactions={reactionsByMessageId.get(row.message.id) ?? NO_REACTIONS}
                  currentUserId={currentUser.id}
                  startsGroup={row.startsGroup}
                  endsGroup={row.endsGroup}
                  apiUrl={apiUrl}
                  authToken={authToken}
                  onOpenImage={onOpenImage}
                  onReply={onReply}
                  onToggleReaction={onToggleReaction}
                />
              ),
            )}
          </div>

          {isPeerTyping ? (
            <div className="mt-4 flex items-center gap-2.5">
              <Avatar
                name={peerName}
                initials={peer?.initials}
                size="sm"
                className="h-8 w-8"
              />
              <div className="bubble-peer flex animate-pop items-center gap-1 rounded-2xl rounded-bl-md px-3.5 py-3 shadow-card">
                {[0, 1, 2].map((dot) => (
                  <span
                    key={dot}
                    className="h-1.5 w-1.5 animate-bounce rounded-full bg-ink-subtle"
                    style={{ animationDelay: `${dot * 130}ms`, animationDuration: '1s' }}
                  />
                ))}
              </div>
              <span className="text-[11.5px] text-ink-subtle">{peerName} is typing</span>
            </div>
          ) : null}

          <div ref={bottomRef} className="h-px" />
        </div>
      </div>

      {showJumpButton ? (
        <button
          type="button"
          onClick={() => scrollToBottom()}
          className="absolute bottom-4 left-1/2 flex -translate-x-1/2 animate-pop items-center gap-2 rounded-full border border-line bg-panel py-2 pr-3 pl-3.5 text-[12px] font-medium shadow-pop transition-colors hover:border-line-strong"
        >
          <ArrowDown className="h-3.5 w-3.5" aria-hidden="true" />
          {missedCount > 0
            ? `${missedCount} new message${missedCount === 1 ? '' : 's'}`
            : 'Jump to latest'}
        </button>
      ) : null}
    </div>
  );
};
