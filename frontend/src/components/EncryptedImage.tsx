import { useEffect, useState } from 'react';
import { ImageOff, Lock } from 'lucide-react';
import { downloadAndDecryptImage } from '../lib/media';
import type { ImageAttachment } from '../types/chat';

interface EncryptedImageProps {
  attachment: ImageAttachment;
  apiUrl: string;
  authToken: string | null;
  sessionAesKey: CryptoKey | null;
  onOpen?: (objectUrl: string, name: string) => void;
}

type LoadState = 'idle' | 'loading' | 'ready' | 'error';

/**
 * Fetches an encrypted image, decrypts it in the browser, and renders it.
 *
 * The blob: URL is revoked on unmount so decrypted image bytes do not stay
 * pinned in memory for the life of the session.
 */
export const EncryptedImage = ({
  attachment,
  apiUrl,
  authToken,
  sessionAesKey,
  onOpen,
}: EncryptedImageProps) => {
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [loadState, setLoadState] = useState<LoadState>('idle');
  const [errorDetail, setErrorDetail] = useState<string | null>(null);

  useEffect(() => {
    if (!authToken || !sessionAesKey) {
      return;
    }

    let isActive = true;
    let createdUrl: string | null = null;

    const load = async () => {
      setLoadState('loading');
      try {
        const url = await downloadAndDecryptImage(
          apiUrl,
          authToken,
          sessionAesKey,
          attachment,
        );
        createdUrl = url;

        if (!isActive) {
          URL.revokeObjectURL(url);
          return;
        }

        setObjectUrl(url);
        setLoadState('ready');
      } catch (error) {
        console.error('Unable to decrypt image attachment.', error);
        if (isActive) {
          setErrorDetail(
            error instanceof Error ? error.message : 'Unable to decrypt this image.',
          );
          setLoadState('error');
        }
      }
    };

    void load();

    return () => {
      isActive = false;
      if (createdUrl) {
        URL.revokeObjectURL(createdUrl);
      }
    };
  }, [apiUrl, attachment, authToken, sessionAesKey]);

  // Reserve the final layout size so the bubble does not jump when the image
  // finishes decrypting.
  const aspectRatio =
    attachment.width && attachment.height
      ? `${attachment.width} / ${attachment.height}`
      : '4 / 3';

  if (loadState === 'error') {
    return (
      <div className="flex w-60 max-w-full flex-col items-center justify-center gap-2 rounded-xl border border-danger/30 bg-danger-soft px-4 py-8 text-center">
        <ImageOff className="h-5 w-5 text-danger" aria-hidden="true" />
        <span className="text-[12px] leading-5 text-danger">
          {errorDetail ?? 'Unable to decrypt this image.'}
        </span>
      </div>
    );
  }

  if (loadState !== 'ready' || !objectUrl) {
    return (
      <div
        style={{ aspectRatio }}
        className="relative flex w-60 max-w-full items-center justify-center overflow-hidden rounded-xl bg-black/20"
      >
        <span className="absolute inset-0 animate-sheen bg-white/5" aria-hidden="true" />
        <Lock className="relative h-5 w-5 text-white/50" aria-hidden="true" />
        <span className="sr-only">Decrypting photo…</span>
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={() => onOpen?.(objectUrl, attachment.name)}
      aria-label={`Open ${attachment.name || 'photo'} full size`}
      className="group/photo block w-60 max-w-full overflow-hidden rounded-xl"
    >
      <img
        src={objectUrl}
        alt={attachment.name || 'Decrypted photo'}
        style={{ aspectRatio }}
        loading="lazy"
        className="w-full object-cover transition-transform duration-300 group-hover/photo:scale-[1.03]"
      />
    </button>
  );
};
