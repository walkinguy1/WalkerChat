import { format, isSameDay, isToday, isYesterday, differenceInMinutes } from 'date-fns';

/** Clock time on a message bubble, e.g. "14:32". */
export const formatClock = (isoDate: string) => format(new Date(isoDate), 'HH:mm');

/** Full timestamp for hover tooltips, e.g. "Mon, 28 Jul 2026 at 14:32". */
export const formatFullTimestamp = (isoDate: string) =>
  format(new Date(isoDate), "EEE, d MMM yyyy 'at' HH:mm");

/** Label for the sticky divider between days. */
export const formatDayDivider = (isoDate: string) => {
  const date = new Date(isoDate);
  if (isToday(date)) return 'Today';
  if (isYesterday(date)) return 'Yesterday';
  return format(date, 'EEEE, d MMMM yyyy');
};

/** Compact "when" for a conversation row, e.g. "14:32" / "Tue" / "12/03". */
export const formatRelativeShort = (isoDate: string) => {
  const date = new Date(isoDate);
  if (isToday(date)) return format(date, 'HH:mm');
  if (isYesterday(date)) return 'Yesterday';
  if (differenceInMinutes(new Date(), date) < 60 * 24 * 7) return format(date, 'EEE');
  return format(date, 'dd/MM/yy');
};

export const isSameCalendarDay = (leftIso: string, rightIso: string) =>
  isSameDay(new Date(leftIso), new Date(rightIso));

/** Elapsed call time as "m:ss" or "h:mm:ss". */
export const formatDuration = (totalSeconds: number) => {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;

  const paddedSeconds = String(remainder).padStart(2, '0');
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${paddedSeconds}`;
  }
  return `${minutes}:${paddedSeconds}`;
};

export const formatBytes = (bytes: number) => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

/** Two-letter fallback initials when the API does not supply them. */
export const initialsOf = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('') || '?';
