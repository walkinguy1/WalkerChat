import { useEffect, useMemo, useState } from 'react';
import { Download, FileText, ImageOff, Lock } from 'lucide-react';
import { downloadAndDecryptAttachment, sanitizeAttachmentName } from '../lib/media';
import type { AttachmentDescriptor } from '../types/chat';

interface EncryptedAttachmentProps {
  attachment: AttachmentDescriptor;
  apiUrl: string;
  authToken: string | null;
  onOpen?: (objectUrl: string, name: string) => void;
}

type State = { status: 'loading' } | { status: 'ready'; mediaId: string; blob: Blob } | { status: 'error'; mediaId: string };

/** Authenticated ciphertext download and local-only decryption for image and file attachments. */
export const EncryptedAttachment = ({ attachment, apiUrl, authToken, onOpen }: EncryptedAttachmentProps) => {
  const [state, setState] = useState<State>({ status: 'loading' });

  useEffect(() => {
    if (!authToken) return;
    let active = true;
    void downloadAndDecryptAttachment(apiUrl, authToken, attachment)
      .then((blob) => { if (active) setState({ status: 'ready', mediaId: attachment.media_id, blob }); })
      .catch(() => { if (active) setState({ status: 'error', mediaId: attachment.media_id }); });
    return () => { active = false; };
  }, [apiUrl, attachment, authToken]);

  const imageUrl = useMemo(
    () => attachment.kind === 'image' && state.status === 'ready' && state.mediaId === attachment.media_id ? URL.createObjectURL(state.blob) : null,
    [attachment.kind, attachment.media_id, state],
  );
  useEffect(() => () => { if (imageUrl) URL.revokeObjectURL(imageUrl); }, [imageUrl]);

  if (state.status === 'error' && state.mediaId === attachment.media_id) {
    return <div className="flex w-60 max-w-full items-center gap-2 rounded-xl border border-danger/30 bg-danger-soft px-4 py-5 text-[12px] text-danger"><ImageOff className="h-4 w-4" aria-hidden="true" />Unable to decrypt this attachment.</div>;
  }

  if (state.status !== 'ready' || state.mediaId !== attachment.media_id) {
    return <div className="flex h-16 w-60 max-w-full items-center justify-center gap-2 rounded-xl bg-black/10"><Lock className="h-4 w-4 text-ink-muted" aria-hidden="true" /><span className="text-xs text-ink-muted">Decrypting attachment…</span></div>;
  }

  const name = sanitizeAttachmentName(attachment.name);
  if (attachment.kind === 'image') {
    if (!imageUrl) return null;
    return (
      <button type="button" onClick={() => { onOpen?.(imageUrl, name); }} aria-label={`Open ${name || 'photo'} full size`} className="group/photo block w-60 max-w-full overflow-hidden rounded-xl">
        <img src={imageUrl} alt={name || 'Decrypted photo'} loading="lazy" className="max-h-80 w-full object-cover" />
      </button>
    );
  }

  const download = () => {
    const url = URL.createObjectURL(state.blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = name;
    anchor.rel = 'noopener';
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return (
    <button type="button" onClick={download} className="flex w-60 max-w-full items-center gap-3 rounded-xl border border-line bg-sunken p-3 text-left hover:bg-raised" aria-label={`Download ${name}`}>
      <FileText className="h-5 w-5 flex-shrink-0 text-accent" aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate text-sm">{name}</span>
      <Download className="h-4 w-4 flex-shrink-0 text-ink-muted" aria-hidden="true" />
    </button>
  );
};
