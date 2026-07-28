import { useEffect, useRef } from 'react';
import clsx from 'clsx';

interface EmojiPickerProps {
  /** Emoji already chosen by the current user, drawn as selected. */
  selected?: string[];
  onSelect: (emoji: string) => void;
  onDismiss: () => void;
  className?: string;
}

/**
 * The first row is the quick set the reaction toolbar leads with; the rest
 * covers the long tail without pulling in an emoji-database dependency.
 */
const EMOJI = [
  '👍',
  '✅',
  '🙌',
  '👀',
  '🔥',
  '❤️',
  '😄',
  '🎉',
  '🤔',
  '👏',
  '🚀',
  '😅',
  '🙏',
  '💯',
  '⚠️',
  '😬',
  '🧠',
  '☕',
];

export const EmojiPicker = ({
  selected = [],
  onSelect,
  onDismiss,
  className,
}: EmojiPickerProps) => {
  const containerRef = useRef<HTMLDivElement>(null);

  // Dismiss on outside click or Escape, so the popover never strands the user.
  useEffect(() => {
    const handlePointerDown = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) {
        onDismiss();
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onDismiss();
      }
    };

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [onDismiss]);

  return (
    <div
      ref={containerRef}
      role="menu"
      aria-label="Pick an emoji"
      className={clsx(
        'z-30 grid w-[15.5rem] animate-pop grid-cols-6 gap-1 rounded-card border border-line',
        'bg-panel p-2 shadow-pop',
        className,
      )}
    >
      {EMOJI.map((emoji) => {
        const isSelected = selected.includes(emoji);
        return (
          <button
            key={emoji}
            type="button"
            role="menuitemcheckbox"
            aria-checked={isSelected}
            onClick={() => onSelect(emoji)}
            className={clsx(
              'flex h-9 w-9 items-center justify-center rounded-lg text-lg transition-colors',
              isSelected
                ? 'bg-accent-soft ring-1 ring-accent ring-inset'
                : 'hover:bg-raised',
            )}
          >
            {emoji}
          </button>
        );
      })}
    </div>
  );
};
