import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
} from 'react';
import clsx from 'clsx';
import { ImagePlus, Loader2, Lock, SendHorizontal, SmilePlus, X } from 'lucide-react';
import { EmojiPicker } from './ui/EmojiPicker';
import { formatBytes } from '../lib/format';
import { ACCEPTED_IMAGE_TYPES } from '../lib/media';
import type { DisplayMessage } from '../types/chat';

interface ComposerProps {
  draft: string;
  onDraftChange: (value: string) => void;
  onSend: () => void;
  onSendPhoto: (file: File) => void;
  isSecure: boolean;
  isUploading: boolean;
  isSocketOpen: boolean;
  peerName: string;
  replyTo: DisplayMessage | null;
  replyAuthorName: string;
  onCancelReply: () => void;
}

const MAX_TEXTAREA_HEIGHT_PX = 168;

export const Composer = ({
  draft,
  onDraftChange,
  onSend,
  onSendPhoto,
  isSecure,
  isUploading,
  isSocketOpen,
  peerName,
  replyTo,
  replyAuthorName,
  onCancelReply,
}: ComposerProps) => {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // File and its preview URL travel together so the URL can be revoked in one
  // place when the attachment is replaced, sent, or the composer unmounts.
  const [pending, setPending] = useState<{ file: File; url: string } | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [isEmojiOpen, setIsEmojiOpen] = useState(false);
  // Nested dragenter/dragleave pairs fire for every child element, so the
  // overlay is driven by a depth counter rather than a boolean.
  const dragDepthRef = useRef(0);

  const canType = isSecure && isSocketOpen;
  const canSend = canType && !isUploading && (Boolean(draft.trim()) || Boolean(pending));

  // Grow with the content up to a cap, then scroll internally.
  useLayoutEffect(() => {
    const element = textareaRef.current;
    if (!element) return;

    element.style.height = 'auto';
    element.style.height = `${Math.min(element.scrollHeight, MAX_TEXTAREA_HEIGHT_PX)}px`;
  }, [draft]);

  // Revokes the previous URL whenever `pending` changes, and on unmount.
  useEffect(() => {
    if (!pending) return;
    const { url } = pending;
    return () => URL.revokeObjectURL(url);
  }, [pending]);

  // Picking reply moves focus to the box, so the next keystroke goes where the
  // user is already looking.
  useEffect(() => {
    if (replyTo) {
      textareaRef.current?.focus();
    }
  }, [replyTo]);

  const acceptFile = useCallback((file: File | null | undefined) => {
    if (!file || !ACCEPTED_IMAGE_TYPES.includes(file.type)) {
      return;
    }
    setPending({ file, url: URL.createObjectURL(file) });
    textareaRef.current?.focus();
  }, []);

  const submit = () => {
    if (!canSend) return;

    if (pending) {
      // The caption in the draft rides along with the photo, so it is cleared
      // by the send handler rather than here.
      onSendPhoto(pending.file);
      setPending(null);
      return;
    }

    onSend();
  };

  const handlePaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const file = Array.from(event.clipboardData.files).find((item) =>
      ACCEPTED_IMAGE_TYPES.includes(item.type),
    );
    if (file) {
      event.preventDefault();
      acceptFile(file);
    }
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    dragDepthRef.current = 0;
    setIsDragging(false);
    if (canType) {
      acceptFile(event.dataTransfer.files[0]);
    }
  };

  return (
    <div
      onDragEnter={(event) => {
        event.preventDefault();
        dragDepthRef.current += 1;
        if (event.dataTransfer.types.includes('Files')) {
          setIsDragging(true);
        }
      }}
      onDragOver={(event) => event.preventDefault()}
      onDragLeave={() => {
        dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
        if (dragDepthRef.current === 0) {
          setIsDragging(false);
        }
      }}
      onDrop={handleDrop}
      className="relative flex-shrink-0 border-t border-line bg-panel px-3 pt-3 pb-3 sm:px-6 sm:pb-4"
    >
      {isDragging ? (
        <div className="pointer-events-none absolute inset-2 z-10 flex animate-fade items-center justify-center rounded-card border-2 border-dashed border-accent bg-accent-soft backdrop-blur-sm">
          <span className="flex items-center gap-2 text-[13px] font-medium text-accent">
            <ImagePlus className="h-4 w-4" aria-hidden="true" />
            Drop a photo to encrypt and send
          </span>
        </div>
      ) : null}

      <div className="mx-auto w-full max-w-3xl">
        {replyTo ? (
          <div className="mb-2 flex animate-pop items-center justify-between gap-2 rounded-r-lg border-l-2 border-accent bg-raised px-2.5 py-2">
            <span className="min-w-0">
              <span className="block text-[11px] font-semibold text-accent">
                Replying to {replyAuthorName}
              </span>
              <span className="mt-px block truncate text-[12.5px] text-ink-muted">
                {replyTo.body || (replyTo.attachment ? 'Photo' : '')}
              </span>
            </span>
            <button
              type="button"
              onClick={onCancelReply}
              aria-label="Cancel reply"
              className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full text-ink-subtle transition-colors hover:bg-sunken hover:text-ink"
            >
              <X className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          </div>
        ) : null}

        {pending ? (
          <div className="mb-2.5 flex animate-pop items-center gap-3 rounded-field border border-line bg-sunken p-2">
            <img
              src={pending.url}
              alt=""
              className="h-12 w-12 flex-shrink-0 rounded-lg object-cover"
            />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] font-medium">{pending.file.name}</span>
              <span className="mt-0.5 flex items-center gap-1 text-[11px] text-ink-muted">
                <Lock className="h-3 w-3 text-signal" aria-hidden="true" />
                {formatBytes(pending.file.size)} · encrypted before upload
              </span>
            </span>
            <button
              type="button"
              onClick={() => setPending(null)}
              aria-label="Remove attachment"
              className="rounded-md p-1.5 text-ink-subtle transition-colors hover:bg-raised hover:text-ink"
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>
        ) : null}

        <div
          className={clsx(
            'relative flex items-end gap-2 rounded-panel border bg-sunken p-2 transition-colors',
            canType ? 'border-line focus-within:border-accent/60' : 'border-line opacity-60',
          )}
        >
          <input
            ref={fileInputRef}
            type="file"
            accept={ACCEPTED_IMAGE_TYPES.join(',')}
            className="sr-only"
            onChange={(event) => {
              const file = event.target.files?.[0];
              // Reset so picking the same file twice still fires a change.
              event.target.value = '';
              acceptFile(file);
            }}
          />

          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={!canType || isUploading}
            aria-label="Attach an encrypted photo"
            title="Attach an encrypted photo"
            className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full text-ink-muted transition-colors hover:bg-raised hover:text-ink disabled:pointer-events-none disabled:opacity-40"
          >
            {isUploading ? (
              <Loader2 className="h-[18px] w-[18px] animate-spin" aria-hidden="true" />
            ) : (
              <ImagePlus className="h-[18px] w-[18px]" aria-hidden="true" />
            )}
          </button>

          <textarea
            ref={textareaRef}
            value={draft}
            onChange={(event) => onDraftChange(event.target.value)}
            onPaste={handlePaste}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                submit();
                return;
              }
              if (event.key === 'Escape' && replyTo) {
                event.stopPropagation();
                onCancelReply();
              }
            }}
            rows={1}
            disabled={!canType}
            aria-label={`Message ${peerName}`}
            placeholder={
              !isSocketOpen
                ? 'Reconnecting to the secure socket…'
                : !isSecure
                  ? 'Waiting for the key exchange to finish…'
                  : pending
                    ? 'Add a caption (optional)'
                    : `Message ${peerName}`
            }
            className="max-h-[168px] min-h-[36px] flex-1 resize-none bg-transparent py-2 text-[14px] leading-[1.5] placeholder:text-ink-subtle focus:outline-none disabled:cursor-not-allowed"
          />

          <button
            type="button"
            onClick={() => setIsEmojiOpen((isOpen) => !isOpen)}
            disabled={!canType}
            aria-label="Insert an emoji"
            aria-expanded={isEmojiOpen}
            title="Emoji"
            className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full text-ink-muted transition-colors hover:bg-raised hover:text-ink disabled:pointer-events-none disabled:opacity-40"
          >
            <SmilePlus className="h-[18px] w-[18px]" aria-hidden="true" />
          </button>

          {isEmojiOpen ? (
            <EmojiPicker
              onSelect={(emoji) => {
                onDraftChange(draft + emoji);
                setIsEmojiOpen(false);
                textareaRef.current?.focus();
              }}
              onDismiss={() => setIsEmojiOpen(false)}
              className="absolute right-11 bottom-12"
            />
          ) : null}

          <button
            type="button"
            onClick={submit}
            disabled={!canSend}
            aria-label="Send encrypted message"
            title="Send (Enter)"
            className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-accent text-on-accent shadow-glow transition-all hover:bg-accent-hover active:scale-95 disabled:pointer-events-none disabled:bg-raised disabled:text-ink-subtle disabled:shadow-none"
          >
            <SendHorizontal className="h-[17px] w-[17px]" aria-hidden="true" />
          </button>
        </div>
      </div>
    </div>
  );
};
