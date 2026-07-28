import { useEffect, useState } from 'react';
import { downloadAndDecryptImage } from '../lib/media';
import type { ImageAttachment } from '../types/chat';

interface EncryptedImageProps {
  attachment: ImageAttachment;
  apiUrl: string;
  authToken: string | null;
  sessionAesKey: CryptoKey | null;
  onOpen?: (objectUrl: string) => void;
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
      <div className="flex min-h-[8rem] w-64 items-center justify-center rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-6 text-center text-xs text-red-200">
        {errorDetail ?? 'Unable to decrypt this image.'}
      </div>
    );
  }

  if (loadState !== 'ready' || !objectUrl) {
    return (
      <div
        className="w-64 max-w-full animate-pulse rounded-xl border border-[#f3c58833] bg-[#241a12]"
        style={{ aspectRatio }}
      />
    );
  }

  return (
    <button
      type="button"
      onClick={() => onOpen?.(objectUrl)}
      className="group block overflow-hidden rounded-xl border border-[#f3c58844] transition-transform hover:scale-[1.01]"
    >
      <img
        src={objectUrl}
        alt={attachment.name || 'Encrypted photo'}
        style={{ aspectRatio }}
        className="w-64 max-w-full object-cover"
      />
    </button>
  );
};
