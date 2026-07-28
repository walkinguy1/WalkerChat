import type { ButtonHTMLAttributes, ReactNode } from 'react';
import clsx from 'clsx';
import { Loader2 } from 'lucide-react';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
type Size = 'sm' | 'md' | 'lg';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  icon?: ReactNode;
  iconAfter?: ReactNode;
}

const base =
  'relative inline-flex items-center justify-center gap-2 rounded-field font-medium ' +
  'transition-[background-color,border-color,color,box-shadow,transform] duration-150 ' +
  'active:scale-[0.98] disabled:pointer-events-none disabled:opacity-45';

const variants: Record<Variant, string> = {
  primary:
    'bg-accent text-on-accent shadow-glow hover:bg-accent-hover disabled:shadow-none',
  secondary:
    'border border-line bg-raised text-ink hover:border-line-strong hover:bg-sunken',
  ghost: 'text-ink-muted hover:bg-raised hover:text-ink',
  danger: 'bg-danger text-white hover:brightness-110',
};

const sizes: Record<Size, string> = {
  sm: 'h-8 px-3 text-xs',
  md: 'h-10 px-4 text-sm',
  lg: 'h-12 px-6 text-sm',
};

export const Button = ({
  variant = 'secondary',
  size = 'md',
  loading = false,
  icon,
  iconAfter,
  className,
  children,
  disabled,
  ...rest
}: ButtonProps) => (
  <button
    type="button"
    disabled={disabled || loading}
    className={clsx(base, variants[variant], sizes[size], className)}
    {...rest}
  >
    {loading ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : icon}
    {children}
    {iconAfter}
  </button>
);

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  variant?: Variant;
  size?: Size;
  active?: boolean;
}

const iconSizes: Record<Size, string> = {
  sm: 'h-8 w-8',
  md: 'h-10 w-10',
  lg: 'h-12 w-12',
};

export const IconButton = ({
  label,
  variant = 'ghost',
  size = 'md',
  active = false,
  className,
  children,
  ...rest
}: IconButtonProps) => (
  <button
    type="button"
    title={label}
    aria-label={label}
    aria-pressed={rest.onClick && active ? true : undefined}
    className={clsx(
      base,
      'rounded-full p-0',
      active ? 'bg-accent-soft text-accent' : variants[variant],
      iconSizes[size],
      className,
    )}
    {...rest}
  >
    {children}
  </button>
);
