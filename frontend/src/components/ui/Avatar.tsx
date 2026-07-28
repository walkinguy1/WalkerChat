import clsx from 'clsx';
import { initialsOf } from '../../lib/format';

type AvatarSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl';

interface AvatarProps {
  name: string;
  initials?: string;
  size?: AvatarSize;
  presence?: 'online' | 'offline' | null;
  className?: string;
}

const sizeClasses: Record<AvatarSize, string> = {
  xs: 'h-7 w-7 text-[10px]',
  sm: 'h-9 w-9 text-xs',
  md: 'h-10 w-10 text-sm',
  lg: 'h-12 w-12 text-base',
  xl: 'h-20 w-20 text-2xl',
};

const dotClasses: Record<AvatarSize, string> = {
  xs: 'h-2 w-2 ring-2',
  sm: 'h-2.5 w-2.5 ring-2',
  md: 'h-3 w-3 ring-2',
  lg: 'h-3.5 w-3.5 ring-[3px]',
  xl: 'h-5 w-5 ring-4',
};

/* The accent is indigo, so avatars are kept out of its neighbourhood — an
   avatar that reads as "the brand colour" looks like a control, not a person. */
const RESERVED_HUE_START = 244;
const RESERVED_HUE_END = 272;
const RESERVED_HUE_WIDTH = RESERVED_HUE_END - RESERVED_HUE_START;
const AVAILABLE_HUE_ARC = 360 - RESERVED_HUE_WIDTH;

/** Golden angle: consecutive slots land as far apart as the arc allows. */
const GOLDEN_ANGLE = 137.508;
/** Stepping the golden angle this many times spaces slots ≥23° apart. */
const HUE_SLOTS = 12;

/**
 * Derive a stable hue from the name so each person keeps the same colour
 * across sessions without the server having to store one.
 *
 * Hashing straight to a hue gave no floor on how close two people could land —
 * "Alice Walker" and "Bob Stone" came out four degrees apart, both indigo, both
 * colliding with the accent. Names now hash to one of a fixed set of slots
 * stepped by the golden angle, so two people are either the same colour or a
 * clearly different one, never almost-the-same. The slots skip the accent band.
 */
const hueFor = (name: string) => {
  // FNV-1a: mixes short, similar strings far better than the `* 31` variant.
  let hash = 0x811c9dc5;
  for (let index = 0; index < name.length; index += 1) {
    hash ^= name.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }

  const hue = ((hash % HUE_SLOTS) * GOLDEN_ANGLE) % AVAILABLE_HUE_ARC;
  return hue >= RESERVED_HUE_START ? hue + RESERVED_HUE_WIDTH : hue;
};

export const Avatar = ({
  name,
  initials,
  size = 'md',
  presence = null,
  className,
}: AvatarProps) => {
  const hue = hueFor(name);
  // The gradient's far stop skips the reserved band too, so no avatar fades
  // into accent indigo halfway down.
  const trailingHue = (() => {
    const shifted = (hue + 40) % 360;
    return shifted >= RESERVED_HUE_START && shifted < RESERVED_HUE_END
      ? (shifted + RESERVED_HUE_WIDTH) % 360
      : shifted;
  })();

  return (
    <span className={clsx('relative inline-flex flex-shrink-0', className)}>
      <span
        aria-hidden="true"
        className={clsx(
          'inline-flex items-center justify-center rounded-full font-semibold tracking-tight',
          'ring-1 ring-inset ring-white/10',
          sizeClasses[size],
        )}
        style={{
          background: `linear-gradient(140deg, oklch(0.62 0.14 ${hue}), oklch(0.48 0.15 ${trailingHue}))`,
          color: '#fff',
        }}
      >
        {initials?.slice(0, 2).toUpperCase() || initialsOf(name)}
      </span>

      {presence ? (
        <span
          className={clsx(
            'absolute right-0 bottom-0 rounded-full ring-panel',
            dotClasses[size],
            presence === 'online' ? 'bg-signal' : 'bg-ink-subtle',
          )}
          title={presence === 'online' ? 'Online' : 'Offline'}
        />
      ) : null}
    </span>
  );
};
