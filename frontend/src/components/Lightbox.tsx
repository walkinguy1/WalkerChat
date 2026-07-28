import { useEffect } from 'react';
import { Download, X } from 'lucide-react';

export type LightboxImage = { url: string; name: string };

interface LightboxProps {
  image: LightboxImage | null;
  onClose: () => void;
}

export const Lightbox = ({ image, onClose }: LightboxProps) => {
  useEffect(() => {
    if (!image) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [image, onClose]);

  if (!image) {
    return null;
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={image.name || 'Photo'}
      onClick={onClose}
      className="fixed inset-0 z-[60] flex animate-fade flex-col bg-black/[0.92] backdrop-blur-md"
    >
      <div
        className="flex h-14 flex-shrink-0 items-center gap-3 px-4"
        onClick={(event) => event.stopPropagation()}
      >
        <span className="min-w-0 flex-1 truncate text-[13px] text-white/70">
          {image.name || 'Decrypted photo'}
        </span>

        <a
          href={image.url}
          download={image.name || 'walkerchat-photo'}
          aria-label="Download the decrypted photo"
          title="Download"
          className="flex h-9 w-9 items-center justify-center rounded-full text-white/70 transition-colors hover:bg-white/10 hover:text-white"
        >
          <Download className="h-4 w-4" aria-hidden="true" />
        </a>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close photo"
          title="Close (Esc)"
          className="flex h-9 w-9 items-center justify-center rounded-full text-white/70 transition-colors hover:bg-white/10 hover:text-white"
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>

      <div className="flex min-h-0 flex-1 items-center justify-center p-4 pb-8">
        <img
          src={image.url}
          alt={image.name || 'Decrypted photo'}
          onClick={(event) => event.stopPropagation()}
          className="max-h-full max-w-full animate-pop rounded-xl object-contain shadow-2xl"
        />
      </div>
    </div>
  );
};
