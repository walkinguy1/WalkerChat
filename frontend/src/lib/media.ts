import { decryptBytes, encryptBytes } from './crypto';
import { fetchEncryptedMedia, uploadEncryptedMedia } from './api';
import type { ImageAttachment } from '../types/chat';

export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

/** Downscale target. Keeps uploads small and strips EXIF as a side effect. */
const MAX_DIMENSION = 1600;
const JPEG_QUALITY = 0.85;

export const ACCEPTED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

export type PreparedImage = {
  bytes: ArrayBuffer;
  mime: string;
  name: string;
  width: number;
  height: number;
};

const readAsDataUrl = (file: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error ?? new Error('Unable to read the file.'));
    reader.readAsDataURL(file);
  });

const loadImage = (src: string): Promise<HTMLImageElement> =>
  new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('That file could not be read as an image.'));
    image.src = src;
  });

/**
 * Decode, optionally downscale, and re-encode an image.
 *
 * Re-encoding through a canvas also drops EXIF metadata, so GPS coordinates
 * and device details do not leak with the photo. Animated GIFs are passed
 * through untouched, since a canvas would flatten them to one frame.
 */
export const prepareImage = async (file: File): Promise<PreparedImage> => {
  if (!file.type.startsWith('image/')) {
    throw new Error('Only image files can be attached.');
  }

  if (file.size > MAX_IMAGE_BYTES) {
    throw new Error(`Images must be under ${Math.floor(MAX_IMAGE_BYTES / (1024 * 1024))}MB.`);
  }

  const dataUrl = await readAsDataUrl(file);
  const image = await loadImage(dataUrl);

  const needsResize = image.width > MAX_DIMENSION || image.height > MAX_DIMENSION;

  if (file.type === 'image/gif' || !needsResize) {
    return {
      bytes: await file.arrayBuffer(),
      mime: file.type,
      name: file.name,
      width: image.width,
      height: image.height,
    };
  }

  const scale = MAX_DIMENSION / Math.max(image.width, image.height);
  const width = Math.round(image.width * scale);
  const height = Math.round(image.height * scale);

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;

  const context = canvas.getContext('2d');
  if (!context) {
    throw new Error('This browser could not process the image.');
  }
  context.drawImage(image, 0, 0, width, height);

  // PNG and WebP keep transparency; everything else is cheaper as JPEG.
  const outputMime = file.type === 'image/png' || file.type === 'image/webp' ? file.type : 'image/jpeg';

  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, outputMime, JPEG_QUALITY),
  );

  if (!blob) {
    throw new Error('This browser could not re-encode the image.');
  }

  return {
    bytes: await blob.arrayBuffer(),
    mime: outputMime,
    name: file.name,
    width,
    height,
  };
};

/**
 * Encrypt an image and upload the ciphertext.
 *
 * Returns the attachment descriptor to embed in the (also encrypted) chat
 * message. The IV lives here, not with the stored blob, so the blob alone is
 * unreadable.
 */
export const encryptAndUploadImage = async (
  apiUrl: string,
  chatId: string,
  token: string,
  aesKey: CryptoKey,
  file: File,
): Promise<ImageAttachment> => {
  const prepared = await prepareImage(file);
  const { ciphertext, ivBase64 } = await encryptBytes(prepared.bytes, aesKey);
  const uploaded = await uploadEncryptedMedia(apiUrl, chatId, token, ciphertext);

  return {
    kind: 'image',
    media_id: uploaded.media_id,
    iv: ivBase64,
    mime: prepared.mime,
    name: prepared.name,
    size: prepared.bytes.byteLength,
    width: prepared.width,
    height: prepared.height,
  };
};

/**
 * Download and decrypt an image, returning a blob: URL for an <img> tag.
 *
 * Callers own the returned URL and must revokeObjectURL it when the image
 * unmounts, otherwise the decrypted bytes stay pinned in memory.
 */
export const downloadAndDecryptImage = async (
  apiUrl: string,
  token: string,
  aesKey: CryptoKey,
  attachment: ImageAttachment,
): Promise<string> => {
  const ciphertext = await fetchEncryptedMedia(apiUrl, attachment.media_id, token);
  const plaintext = await decryptBytes(ciphertext, attachment.iv, aesKey);
  const blob = new Blob([plaintext], { type: attachment.mime });

  return URL.createObjectURL(blob);
};
