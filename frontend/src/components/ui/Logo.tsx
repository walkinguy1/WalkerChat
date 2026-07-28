import clsx from 'clsx';

interface LogoProps {
  className?: string;
}

/** The WalkerChat mark: a speech bubble with a padlock inside it. */
export const Logo = ({ className }: LogoProps) => (
  <span
    className={clsx(
      'inline-flex items-center justify-center rounded-[0.6rem] bg-accent text-on-accent',
      className,
    )}
  >
    <svg viewBox="0 0 24 24" className="h-[62%] w-[62%]" aria-hidden="true" fill="none">
      <path
        d="M3 8.5A4.5 4.5 0 0 1 7.5 4h9A4.5 4.5 0 0 1 21 8.5v4a4.5 4.5 0 0 1-4.5 4.5H11l-4.6 3.4A.9.9 0 0 1 5 19.7V16.6A4.5 4.5 0 0 1 3 12.9z"
        fill="currentColor"
        fillOpacity="0.22"
      />
      <path
        d="M3 8.5A4.5 4.5 0 0 1 7.5 4h9A4.5 4.5 0 0 1 21 8.5v4a4.5 4.5 0 0 1-4.5 4.5H11l-4.6 3.4A.9.9 0 0 1 5 19.7V16.6A4.5 4.5 0 0 1 3 12.9z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <path
        d="M10.2 10.4V9.3a1.8 1.8 0 0 1 3.6 0v1.1"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <rect x="9.2" y="10.3" width="5.6" height="4" rx="1.2" fill="currentColor" />
    </svg>
  </span>
);
