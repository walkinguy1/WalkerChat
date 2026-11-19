import {
  IV_LEN,
  KEY_LEN,
  aeadOpen,
  aeadSeal,
  fromBase64,
  randomBytes,
  toArrayBuffer,
  toBase64,
} from './crypto/primitives';
import { fetchEncryptedMedia, uploadEncryptedMedia } from './api';
import type { AttachmentDescriptor, FileAttachment, ImageAttachment } from '../types/chat';

const DEFAULT_MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
const configuredMaxBytes = Number(import.meta.env.VITE_MEDIA_MAX_BYTES);
export const MAX_ATTACHMENT_BYTES =
  Number.isSafeInteger(configuredMaxBytes) && configuredMaxBytes > 0
    ? configuredMaxBytes
    : DEFAULT_MAX_ATTACHMENT_BYTES;
export const MAX_IMAGE_BYTES = MAX_ATTACHMENT_BYTES;

/** Downscale target. Keeps uploads small and strips EXIF as a side effect. */
const MAX_DIMENSION = 1600;
const JPEG_QUALITY = 0.85;

export const ACCEPTED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
export const ACCEPTED_ATTACHMENT_TYPES = [
  ...ACCEPTED_IMAGE_TYPES,
  'application/pdf',
  'text/plain',
];

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
  if (!ACCEPTED_IMAGE_TYPES.includes(file.type)) {
    throw new Error('Only image files can be attached.');
  }

  if (file.size > MAX_ATTACHMENT_BYTES) {
    throw new Error(`Attachments must be under ${Math.floor(MAX_ATTACHMENT_BYTES / (1024 * 1024))}MB.`);
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

const safeName = (name: string): string => {
  const leaf = name
    .replace(/[\\/:*?"<>|]/g, '_')
    .split('')
    .filter((character) => {
      const code = character.charCodeAt(0);
      return code > 0x1f && code !== 0x7f;
    })
    .join('')
    .trim()
    .replace(/[. ]+$/g, '');
  return (leaf && leaf !== '.' && leaf !== '..' ? leaf : 'attachment').slice(0, 120);
};

/** Validate the small supported document set before reading/encrypting it. */
const prepareDocument = async (file: File): Promise<{ bytes: ArrayBuffer; mime: FileAttachment['mime'] }> => {
  if (file.size <= 0) throw new Error('Empty attachments cannot be sent.');
  if (file.size > MAX_ATTACHMENT_BYTES) {
    throw new Error(`Attachments must be under ${Math.floor(MAX_ATTACHMENT_BYTES / (1024 * 1024))}MB.`);
  }
  const lowerName = file.name.toLowerCase();
  const bytes = await file.arrayBuffer();
  const view = new Uint8Array(bytes);
  const declared = file.type.toLowerCase();
  const unspecified = !declared || declared === 'application/octet-stream';

  if (lowerName.endsWith('.pdf')) {
    const signature = new TextDecoder().decode(view.subarray(0, 5));
    if (signature !== '%PDF-' || (!unspecified && declared !== 'application/pdf')) {
      throw new Error('The file does not match the supported PDF format.');
    }
    return { bytes, mime: 'application/pdf' };
  }
  if (lowerName.endsWith('.txt')) {
    if ((!unspecified && declared !== 'text/plain') || view.includes(0)) {
      throw new Error('The file does not match the supported plain text format.');
    }
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      throw new Error('Plain text attachments must be valid UTF-8.');
    }
    return { bytes, mime: 'text/plain' };
  }
  throw new Error('Supported attachments are JPEG, PNG, WebP, GIF, PDF, and UTF-8 text.');
};

export const sanitizeAttachmentName = safeName;

/**
 * Encrypt an image under a fresh key and upload the ciphertext.
 *
 * The key is generated per attachment and returned in the descriptor, which travels
 * inside the ratcheted chat message. That is what gives images the same forward
 * secrecy as text: previously every photo in a conversation was encrypted under one
 * long-lived session key, so recovering that key exposed all of them at once.
 *
 * Neither the key nor the IV is stored with the blob, so object storage holds bytes
 * that are unreadable on their own.
 */
export const encryptAndUploadImage = async (
  apiUrl: string,
  chatId: string,
  token: string,
  file: File,
): Promise<ImageAttachment> => {
  const prepared = await prepareImage(file);

  const contentKey = randomBytes(KEY_LEN);
  const iv = randomBytes(IV_LEN);
  const ciphertext = await aeadSeal(
    contentKey,
    iv,
    new Uint8Array(prepared.bytes),
    new Uint8Array(0),
  );

  const uploaded = await uploadEncryptedMedia(apiUrl, chatId, token, toArrayBuffer(ciphertext));

  return {
    kind: 'image',
    version: 2,
    media_id: uploaded.media_id,
    key: toBase64(contentKey),
    iv: toBase64(iv),
    mime: prepared.mime,
    name: prepared.name,
    size: prepared.bytes.byteLength,
    width: prepared.width,
    height: prepared.height,
  };
};

export const encryptAndUploadAttachment = async (
  apiUrl: string,
  chatId: string,
  token: string,
  file: File,
): Promise<AttachmentDescriptor> => {
  if (ACCEPTED_IMAGE_TYPES.includes(file.type)) {
    return encryptAndUploadImage(apiUrl, chatId, token, file);
  }
  const prepared = await prepareDocument(file);
  const contentKey = randomBytes(KEY_LEN);
  const iv = randomBytes(IV_LEN);
  const ciphertext = await aeadSeal(contentKey, iv, new Uint8Array(prepared.bytes), new Uint8Array(0));
  const uploaded = await uploadEncryptedMedia(apiUrl, chatId, token, toArrayBuffer(ciphertext));
  return {
    kind: 'file',
    version: 2,
    media_id: uploaded.media_id,
    key: toBase64(contentKey),
    iv: toBase64(iv),
    mime: prepared.mime,
    name: safeName(file.name),
    size: prepared.bytes.byteLength,
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
  attachment: ImageAttachment,
): Promise<string> => {
  const ciphertext = await fetchEncryptedMedia(apiUrl, attachment.media_id, token);
  const plaintext = await aeadOpen(
    fromBase64(attachment.key),
    fromBase64(attachment.iv),
    new Uint8Array(ciphertext),
    new Uint8Array(0),
  );
  const blob = new Blob([toArrayBuffer(plaintext)], { type: attachment.mime });

  return URL.createObjectURL(blob);
};

export const downloadAndDecryptAttachment = async (
  apiUrl: string,
  token: string,
  attachment: AttachmentDescriptor,
): Promise<Blob> => {
  const ciphertext = await fetchEncryptedMedia(apiUrl, attachment.media_id, token);
  const plaintext = await aeadOpen(
    fromBase64(attachment.key),
    fromBase64(attachment.iv),
    new Uint8Array(ciphertext),
    new Uint8Array(0),
  );
  return new Blob([toArrayBuffer(plaintext)], { type: attachment.mime });
};
