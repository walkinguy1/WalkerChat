import clsx from 'clsx';
import { AlertTriangle, CheckCircle2, Info, X } from 'lucide-react';
import { dismissToast, useToasts, type ToastTone } from '../../lib/toast';

const toneStyles: Record<ToastTone, { wrap: string; icon: typeof Info }> = {
  error: { wrap: 'border-danger/40 text-danger', icon: AlertTriangle },
  success: { wrap: 'border-signal/40 text-signal', icon: CheckCircle2 },
  info: { wrap: 'border-line-strong text-ink-muted', icon: Info },
};

export const Toaster = () => {
  const toasts = useToasts();

  if (!toasts.length) {
    return null;
  }

  return (
    <div
      role="region"
      aria-label="Notifications"
      className="pointer-events-none fixed inset-x-0 bottom-4 z-[70] flex flex-col items-center gap-2 px-4 sm:inset-x-auto sm:right-5 sm:bottom-5 sm:items-end"
    >
      {toasts.map((toast) => {
        const { wrap, icon: Icon } = toneStyles[toast.tone];

        return (
          <output
            key={toast.id}
            aria-live={toast.tone === 'error' ? 'assertive' : 'polite'}
            className={clsx(
              'pointer-events-auto flex w-full max-w-sm animate-rise items-start gap-3 rounded-card border bg-panel/95 p-3 pr-2 shadow-pop backdrop-blur-xl',
              wrap,
            )}
          >
            <Icon className="mt-0.5 h-4 w-4 flex-shrink-0" aria-hidden="true" />
            <p className="flex-1 text-sm leading-snug text-ink">{toast.message}</p>
            <button
              type="button"
              onClick={() => dismissToast(toast.id)}
              aria-label="Dismiss notification"
              className="rounded-md p-1 text-ink-subtle transition-colors hover:bg-raised hover:text-ink"
            >
              <X className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          </output>
        );
      })}
    </div>
  );
};
