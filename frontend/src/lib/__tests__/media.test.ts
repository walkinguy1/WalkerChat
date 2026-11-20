import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiMocks = vi.hoisted(() => ({
  fetchEncryptedMedia: vi.fn(),
  uploadEncryptedMedia: vi.fn(),
}));
vi.mock('../api', () => apiMocks);

import { downloadAndDecryptAttachment, encryptAndUploadAttachment, MAX_ATTACHMENT_BYTES, sanitizeAttachmentName } from '../media';

describe('encrypted file attachments', () => {
  let ciphertext: ArrayBuffer;
  beforeEach(() => {
    vi.clearAllMocks();
    ciphertext = new ArrayBuffer(0);
    apiMocks.uploadEncryptedMedia.mockImplementation(async (_url, _chat, _token, body) => {
      ciphertext = body;
      return { media_id: 'opaque-media-id', chat_id: 'chat-id', size_bytes: body.byteLength, created_at: '' };
    });
    apiMocks.fetchEncryptedMedia.mockImplementation(async () => ciphertext);
  });

  it('encrypts PDF bytes before upload and decrypts them only in the browser', async () => {
    const plain = new TextEncoder().encode('%PDF-1.7\nsecret document');
    const file = new File([plain], 'report.pdf', { type: 'application/pdf' });
    const descriptor = await encryptAndUploadAttachment('/api', 'chat', 'token', file);
    expect(descriptor).toMatchObject({ kind: 'file', version: 2, mime: 'application/pdf', name: 'report.pdf' });
    expect(new Uint8Array(ciphertext)).not.toEqual(plain);
    expect(new TextDecoder().decode(ciphertext)).not.toContain('secret document');
    const downloaded = await downloadAndDecryptAttachment('/api', 'token', descriptor);
    expect(new Uint8Array(await downloaded.arrayBuffer())).toEqual(plain);
  });

  it('supports UTF-8 plain text but rejects empty, mislabeled and unsupported files', async () => {
    const text = new File(['hello'], 'note.txt', { type: 'text/plain' });
    expect((await encryptAndUploadAttachment('/api', 'chat', 'token', text)).kind).toBe('file');
    await expect(encryptAndUploadAttachment('/api', 'chat', 'token', new File([], 'empty.txt', { type: 'text/plain' }))).rejects.toThrow('Empty');
    await expect(encryptAndUploadAttachment('/api', 'chat', 'token', new File(['not pdf'], 'fake.pdf', { type: 'application/pdf' }))).rejects.toThrow('match');
    await expect(encryptAndUploadAttachment('/api', 'chat', 'token', new File(['zip'], 'file.docx', { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }))).rejects.toThrow('Supported attachments');
  });

  it('rejects oversized files before reading or uploading them', async () => {
    const file = new File([new Uint8Array(MAX_ATTACHMENT_BYTES + 1)], 'large.txt', { type: 'text/plain' });
    const read = vi.spyOn(file, 'arrayBuffer');
    await expect(encryptAndUploadAttachment('/api', 'chat', 'token', file)).rejects.toThrow('under');
    expect(read).not.toHaveBeenCalled();
    expect(apiMocks.uploadEncryptedMedia).not.toHaveBeenCalled();
  });

  it('fails authenticated decryption for tampered ciphertext and the wrong key', async () => {
    const descriptor = await encryptAndUploadAttachment('/api', 'chat', 'token', new File(['%PDF-1.7 body'], 'a.pdf', { type: 'application/pdf' }));
    const saved = ciphertext;
    const bytes = new Uint8Array(saved.slice(0));
    bytes[bytes.length - 1] ^= 1;
    apiMocks.fetchEncryptedMedia.mockResolvedValueOnce(bytes.buffer);
    await expect(downloadAndDecryptAttachment('/api', 'token', descriptor)).rejects.toThrow();
    apiMocks.fetchEncryptedMedia.mockResolvedValueOnce(saved);
    await expect(downloadAndDecryptAttachment('/api', 'token', { ...descriptor, key: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' })).rejects.toThrow();
  });

  it('bounds filenames for UI and download use', () => {
    expect(sanitizeAttachmentName('../../private\u0000.pdf')).toBe('.._.._private.pdf');
    expect(sanitizeAttachmentName('  ')).toBe('attachment');
    expect(sanitizeAttachmentName('x'.repeat(140))).toHaveLength(120);
  });
});
