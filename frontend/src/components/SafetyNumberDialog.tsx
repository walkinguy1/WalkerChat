import { useEffect } from 'react';
import clsx from 'clsx';
import { Check, ShieldAlert, ShieldCheck, X } from 'lucide-react';

import { Button, IconButton } from './ui/Button';
import type { SafetyNumber } from '../hooks/useSafetyNumber';

interface SafetyNumberDialogProps {
  open: boolean;
  peerName: string;
  safetyNumber: SafetyNumber;
  onClose: () => void;
}

/**
 * The out-of-band verification surface.
 *
 * Deliberately plain: the number is the whole point, so it gets the largest, most
 * legible treatment on the screen, grouped in fives because people read it aloud to
 * each other.
 */
export const SafetyNumberDialog = ({
  open,
  peerName,
  safetyNumber,
  onClose,
}: SafetyNumberDialogProps) => {
  useEffect(() => {
    if (!open) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose, open]);

  if (!open) {
    return null;
  }

  const groups = safetyNumber.formatted?.split(' ') ?? [];
  const changed = safetyNumber.state === 'changed';
  const verified = safetyNumber.state === 'verified';

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label={`Safety number for ${peerName}`}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-md rounded-2xl border border-line bg-panel p-5 shadow-2xl">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-[15px] font-semibold tracking-tight">Verify {peerName}</h2>
            <p className="mt-0.5 text-[12px] text-ink-muted">
              Compare these digits with {peerName} over a channel you already trust.
            </p>
          </div>
          <IconButton autoFocus size="sm" label="Close" onClick={onClose}>
            <X className="h-4 w-4" aria-hidden="true" />
          </IconButton>
        </div>

        {changed ? (
          <div className="mt-4 flex gap-2.5 rounded-xl border border-danger/30 bg-danger-soft p-3">
            <ShieldAlert className="mt-0.5 h-4 w-4 flex-shrink-0 text-danger" aria-hidden="true" />
            <p className="text-[12px] leading-relaxed text-ink">
              <span className="font-semibold">This safety number changed.</span> That happens when
              someone reinstalls the app — but it is also what an attacker substituting keys would
              look like. Verify the new number before you trust this conversation.
            </p>
          </div>
        ) : null}

        {safetyNumber.value ? (
          <div className="mt-4 rounded-xl border border-line bg-sunken p-4">
            <div className="grid grid-cols-4 gap-x-3 gap-y-2 text-center font-mono text-[15px] tracking-widest tabular-nums">
              {groups.map((group, index) => (
                <span key={`${group}-${index}`}>{group}</span>
              ))}
            </div>
          </div>
        ) : (
          <p className="mt-4 rounded-xl border border-line bg-sunken p-4 text-center text-[12px] text-ink-muted">
            No session with {peerName} yet. Send a message first, then compare numbers.
          </p>
        )}

        {safetyNumber.value ? (
          <div className="mt-4 flex items-center justify-between gap-3">
            <span
              className={clsx(
                'inline-flex items-center gap-1.5 text-[12px] font-medium',
                verified ? 'text-signal' : changed ? 'text-danger' : 'text-ink-muted',
              )}
            >
              {verified ? (
                <>
                  <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />
                  Verified
                </>
              ) : changed ? (
                <>
                  <ShieldAlert className="h-3.5 w-3.5" aria-hidden="true" />
                  Changed — not verified
                </>
              ) : (
                'Not verified yet'
              )}
            </span>

            {verified ? (
              <Button variant="ghost" onClick={() => void safetyNumber.clearVerification()}>
                Clear verification
              </Button>
            ) : (
              <Button
                variant="primary"
                icon={<Check className="h-4 w-4" aria-hidden="true" />}
                onClick={() => void safetyNumber.markVerified()}
              >
                They match
              </Button>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
};
