import { useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import {
  Check,
  CheckCheck,
  Clock,
  Copy,
  CornerUpLeft,
  Ellipsis,
  Plus,
  ShieldOff,
  SmilePlus,
} from 'lucide-react';
import { EncryptedImage } from './EncryptedImage';
import { Avatar } from './ui/Avatar';
import { EmojiPicker } from './ui/EmojiPicker';
import { formatClock, formatFullTimestamp } from '../lib/format';
import type { DisplayMessage, ReactionTally } from '../types/chat';

interface MessageBubbleProps {
  message: DisplayMessage;
  isOwn: boolean;
  authorName: string;
  authorInitials?: string;
  /** Display name for whoever wrote the quoted message, when there is one. */
  replyAuthorName?: string;
  reactions: ReactionTally[];
  currentUserId: string;
  /** First message of a run by this author — gets the avatar and name. */
  startsGroup: boolean;
  /** Last message of a run — gets the tail corner and the timestamp row. */
  endsGroup: boolean;
  apiUrl: string;
  authToken: string | null;
  sessionAesKey: CryptoKey | null;
  onOpenImage: (objectUrl: string, name: string) => void;
  onReply: (message: DisplayMessage) => void;
  onToggleReaction: (message: DisplayMessage, emoji: string) => void;
}

/** Bodies the crypto layer substitutes when it cannot produce plaintext. */
const UNDECRYPTABLE = new Set([
  '[Unable to decrypt]',
  '[Secure session required]',
  '[Encrypted payload]',
]);

export const MessageBubble = ({
  message,
  isOwn,
  authorName,
  authorInitials,
  replyAuthorName,
  reactions,
  currentUserId,
  startsGroup,
  endsGroup,
  apiUrl,
  authToken,
  sessionAesKey,
  onOpenImage,
  onReply,
  onToggleReaction,
}: MessageBubbleProps) => {
  const [didCopy, setDidCopy] = useState(false);
  const [openPanel, setOpenPanel] = useState<'emoji' | 'more' | null>(null);
  const moreRef = useRef<HTMLDivElement>(null);

  const isLocked = !message.attachment && UNDECRYPTABLE.has(message.body);
  const hasText = Boolean(message.body) && !isLocked;
  // A message the server has not acknowledged yet has no stable id to hang a
  // reaction off, so reacting waits for the echo — a fraction of a second.
  const canReact = message.state === 'sent' && !isLocked;
  const myEmoji = reactions
    .filter((tally) => tally.userIds.includes(currentUserId))
    .map((tally) => tally.emoji);

  const copyBody = async () => {
    try {
      await navigator.clipboard.writeText(message.body);
      setDidCopy(true);
      window.setTimeout(() => setDidCopy(false), 1400);
    } catch {
      // Clipboard access can be denied; the failure is self-evident in the UI.
    }
  };

  useEffect(() => {
    if (openPanel !== 'more') return;

    const handlePointerDown = (event: MouseEvent) => {
      if (!moreRef.current?.contains(event.target as Node)) {
        setOpenPanel(null);
      }
    };
    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
  }, [openPanel]);

  return (
    <div
      className={clsx(
        'group/message relative flex items-end gap-2.5',
        isOwn ? 'flex-row-reverse' : 'flex-row',
        startsGroup ? 'mt-4' : 'mt-0.5',
      )}
    >
      {/* Avatar slot is always reserved so bubbles in a run stay aligned. */}
      <span className="w-8 flex-shrink-0">
        {endsGroup && !isOwn ? (
          <Avatar name={authorName} initials={authorInitials} size="sm" className="h-8 w-8" />
        ) : null}
      </span>

      <div
        className={clsx(
          'flex min-w-0 max-w-[min(78%,34rem)] flex-col',
          isOwn ? 'items-end' : 'items-start',
        )}
      >
        {startsGroup && !isOwn ? (
          <span className="mb-1 px-1 text-[11px] font-medium text-ink-muted">{authorName}</span>
        ) : null}

        {message.replyTo ? (
          <div
            className={clsx(
              'mb-1 flex items-center gap-1.5 px-1.5 text-[11px] text-ink-subtle',
              isOwn && 'flex-row-reverse',
            )}
          >
            <CornerUpLeft className="h-3 w-3 flex-shrink-0" aria-hidden="true" />
            <span className="truncate">
              Replying to <span className="text-ink-muted">{replyAuthorName ?? 'a message'}</span>
            </span>
          </div>
        ) : null}

        <div
          className={clsx(
            'relative shadow-card transition-shadow',
            message.attachment ? 'overflow-hidden p-1' : 'px-3.5 py-2',
            // Square off the corner facing the avatar on the last bubble of a
            // run, so a group reads as one block with a single tail.
            isOwn
              ? ['rounded-2xl', endsGroup && 'rounded-br-md']
              : ['rounded-2xl', endsGroup && 'rounded-bl-md'],
            isOwn
              ? 'bg-accent text-on-accent'
              : isLocked
                ? 'border border-dashed border-line-strong bg-transparent text-ink-subtle'
                : 'bubble-peer text-ink',
          )}
        >
          {/* The quote is a copy carried inside the ciphertext, so it renders
              even when the original sits outside loaded history. */}
          {message.replyTo ? (
            <blockquote
              className={clsx(
                'mb-1.5 rounded-md border-l-2 px-2.5 py-1.5',
                message.attachment ? 'mx-1.5 mt-1.5' : '-mx-1.5 -mt-0.5',
                isOwn
                  ? 'border-white/50 bg-white/12'
                  : 'border-accent/60 bg-accent-soft',
              )}
            >
              <span
                className={clsx(
                  'block text-[11px] font-semibold',
                  isOwn ? 'opacity-85' : 'text-accent',
                )}
              >
                {replyAuthorName ?? 'Quoted message'}
              </span>
              <span
                className={clsx(
                  'mt-px block truncate text-[12.5px] leading-[1.4]',
                  isOwn ? 'opacity-80' : 'text-ink-muted',
                )}
              >
                {message.replyTo.preview || 'Photo'}
              </span>
            </blockquote>
          ) : null}

          {message.attachment ? (
            <EncryptedImage
              attachment={message.attachment}
              apiUrl={apiUrl}
              authToken={authToken}
              sessionAesKey={sessionAesKey}
              onOpen={onOpenImage}
            />
          ) : null}

          {isLocked ? (
            <span className="flex items-center gap-2 text-[13px] italic">
              <ShieldOff className="h-3.5 w-3.5 flex-shrink-0" aria-hidden="true" />
              {message.body === '[Unable to decrypt]'
                ? 'This message could not be decrypted'
                : 'Waiting for the session key'}
            </span>
          ) : null}

          {hasText ? (
            <p
              className={clsx(
                'text-[14px] leading-[1.55] break-words whitespace-pre-wrap',
                message.attachment && 'px-2.5 pt-2 pb-1',
              )}
            >
              {message.body}
            </p>
          ) : null}
        </div>

        {reactions.length ? (
          <div className={clsx('mt-1.5 flex flex-wrap items-center gap-1.5 px-0.5', isOwn && 'flex-row-reverse')}>
            {reactions.map((tally) => {
              const isMine = tally.userIds.includes(currentUserId);
              return (
                <button
                  key={tally.emoji}
                  type="button"
                  disabled={!canReact}
                  onClick={() => onToggleReaction(message, tally.emoji)}
                  aria-pressed={isMine}
                  aria-label={`${tally.emoji} reaction, ${tally.userIds.length}`}
                  className={clsx(
                    'flex h-6 items-center gap-1.5 rounded-full border px-2 text-[12px] transition-colors',
                    'disabled:pointer-events-none',
                    isMine
                      ? 'border-accent bg-accent-soft text-ink'
                      : 'border-line bg-raised text-ink-muted hover:border-line-strong',
                  )}
                >
                  {tally.emoji}
                  <span className="text-[11px] font-medium tabular-nums">
                    {tally.userIds.length}
                  </span>
                </button>
              );
            })}

            {canReact ? (
              <span className="relative">
                <button
                  type="button"
                  onClick={() => setOpenPanel(openPanel === 'emoji' ? null : 'emoji')}
                  aria-label="Add a reaction"
                  className="flex h-6 w-6 items-center justify-center rounded-full border border-dashed border-line-strong text-ink-subtle transition-colors hover:text-ink"
                >
                  <Plus className="h-3 w-3" aria-hidden="true" />
                </button>
                {openPanel === 'emoji' ? (
                  <EmojiPicker
                    selected={myEmoji}
                    onSelect={(emoji) => {
                      onToggleReaction(message, emoji);
                      setOpenPanel(null);
                    }}
                    onDismiss={() => setOpenPanel(null)}
                    className={clsx('absolute bottom-8', isOwn ? 'right-0' : 'left-0')}
                  />
                ) : null}
              </span>
            ) : null}
          </div>
        ) : null}

        {endsGroup ? (
          <div
            className={clsx(
              'mt-1 flex items-center gap-1.5 px-1 text-[11px] text-ink-subtle',
              isOwn ? 'flex-row-reverse' : 'flex-row',
            )}
          >
            <time
              dateTime={message.sentAt}
              title={formatFullTimestamp(message.sentAt)}
              className="tabular-nums"
            >
              {formatClock(message.sentAt)}
            </time>

            {isOwn ? (
              message.state === 'sending' ? (
                <Clock className="h-3 w-3" aria-label="Sending" />
              ) : (
                <CheckCheck className="h-3.5 w-3.5 text-signal" aria-label="Delivered" />
              )
            ) : null}
          </div>
        ) : null}
      </div>

      {/* Hover toolbar: react, reply, more. Kept out of the flow so it never
          shifts the bubble when it appears. */}
      {canReact ? (
        <div
          className={clsx(
            'mb-1.5 flex flex-shrink-0 items-center gap-0.5 rounded-full border border-line bg-raised p-0.5',
            'shadow-card transition-opacity duration-150',
            openPanel
              ? 'opacity-100'
              : 'opacity-0 group-hover/message:opacity-100 focus-within:opacity-100',
          )}
        >
          <span className="relative">
            <button
              type="button"
              onClick={() => setOpenPanel(openPanel === 'emoji' ? null : 'emoji')}
              aria-label="React to this message"
              title="React"
              className="flex h-[26px] w-[26px] items-center justify-center rounded-full text-ink-muted transition-colors hover:bg-sunken hover:text-ink"
            >
              <SmilePlus className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
            {openPanel === 'emoji' && !reactions.length ? (
              <EmojiPicker
                selected={myEmoji}
                onSelect={(emoji) => {
                  onToggleReaction(message, emoji);
                  setOpenPanel(null);
                }}
                onDismiss={() => setOpenPanel(null)}
                className={clsx('absolute bottom-9', isOwn ? 'right-0' : 'left-0')}
              />
            ) : null}
          </span>

          <button
            type="button"
            onClick={() => onReply(message)}
            aria-label="Reply to this message"
            title="Reply"
            className="flex h-[26px] w-[26px] items-center justify-center rounded-full text-ink-muted transition-colors hover:bg-sunken hover:text-ink"
          >
            <CornerUpLeft className="h-3.5 w-3.5" aria-hidden="true" />
          </button>

          <div ref={moreRef} className="relative">
            <button
              type="button"
              onClick={() => setOpenPanel(openPanel === 'more' ? null : 'more')}
              aria-label="More message actions"
              aria-expanded={openPanel === 'more'}
              title="More"
              className="flex h-[26px] w-[26px] items-center justify-center rounded-full text-ink-muted transition-colors hover:bg-sunken hover:text-ink"
            >
              <Ellipsis className="h-3.5 w-3.5" aria-hidden="true" />
            </button>

            {openPanel === 'more' ? (
              <div
                role="menu"
                className={clsx(
                  'absolute bottom-9 z-30 w-40 animate-pop rounded-card border border-line bg-panel p-1 shadow-pop',
                  isOwn ? 'right-0' : 'left-0',
                )}
              >
                <button
                  type="button"
                  role="menuitem"
                  disabled={!hasText}
                  onClick={() => {
                    void copyBody();
                    setOpenPanel(null);
                  }}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] transition-colors hover:bg-raised disabled:opacity-40"
                >
                  {didCopy ? (
                    <Check className="h-3.5 w-3.5 text-signal" aria-hidden="true" />
                  ) : (
                    <Copy className="h-3.5 w-3.5 text-ink-muted" aria-hidden="true" />
                  )}
                  Copy text
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    onReply(message);
                    setOpenPanel(null);
                  }}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] transition-colors hover:bg-raised"
                >
                  <CornerUpLeft className="h-3.5 w-3.5 text-ink-muted" aria-hidden="true" />
                  Reply
                </button>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
};
