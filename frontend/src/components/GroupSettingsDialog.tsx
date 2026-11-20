import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { IconButton } from './ui/Button';
import type { BootstrapChat } from '../types/chat';
import type { UserProfile } from '../lib/api';

interface GroupSettingsDialogProps {
  chat: BootstrapChat;
  currentUserId: string;
  onClose: () => void;
  onRename: (name: string) => Promise<void>;
  onAdd: (userId: string) => Promise<void>;
  onRemove: (userId: string) => Promise<void>;
  onLoadContacts: () => Promise<{ contacts: UserProfile[] }>;
}

export const GroupSettingsDialog = ({ chat, currentUserId, onClose, onRename, onAdd, onRemove, onLoadContacts }: GroupSettingsDialogProps) => {
  const [name, setName] = useState(chat.name);
  const [contacts, setContacts] = useState<UserProfile[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const members = new Set(chat.members.map((member) => member.user_id));

  useEffect(() => { void onLoadContacts().then((result) => setContacts(result.contacts)).catch(() => setError('Unable to load accepted contacts.')); }, [onLoadContacts]);

  const run = async (operation: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try { await operation(); }
    catch { setError('Unable to update this group. Check your role, connection, and contact status.'); }
    finally { setBusy(false); }
  };

  return <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 p-4 pt-[10vh]" role="dialog" aria-modal="true" aria-label="Manage group">
    <section className="w-full max-w-md rounded-2xl border border-line bg-panel shadow-2xl">
      <header className="flex items-center border-b border-line p-4"><h2 className="flex-1 font-semibold">Manage group</h2><IconButton size="sm" label="Close" onClick={onClose}><X className="h-4 w-4" /></IconButton></header>
      <div className="space-y-4 p-4">
        <label className="block text-xs text-ink-muted">Group name<input aria-label="Group name" value={name} maxLength={120} onChange={(event) => setName(event.target.value)} className="mt-1 h-10 w-full rounded border border-line bg-sunken px-3 text-sm text-ink" /></label>
        <button type="button" disabled={busy || !name.trim() || name.trim() === chat.name} onClick={() => void run(() => onRename(name.trim()))} className="rounded bg-accent-soft px-3 py-2 text-xs text-accent">Save name</button>
        <div><h3 className="mb-2 text-xs font-semibold">Members</h3><ul className="space-y-2">{chat.members.map((member) => <li key={member.user_id} className="flex items-center gap-2 text-xs"><span className="min-w-0 flex-1 truncate">{member.display_name} · @{member.username} <span className="text-ink-muted">{member.role}</span></span>{member.role !== 'OWNER' && member.user_id !== currentUserId ? <button type="button" disabled={busy} onClick={() => void run(() => onRemove(member.user_id))} className="text-danger">Remove</button> : null}</li>)}</ul></div>
        <div><h3 className="mb-2 text-xs font-semibold">Add an accepted contact</h3>{contacts.filter((contact) => !members.has(contact.id)).map((contact) => <button key={contact.id} type="button" disabled={busy} onClick={() => void run(() => onAdd(contact.id))} className="block w-full rounded px-2 py-2 text-left text-xs hover:bg-raised">Add @{contact.username}</button>)}</div>
        {error ? <p role="alert" className="text-xs text-danger">{error}</p> : null}
        <p className="text-[11px] text-ink-muted">Removing a member requires every remaining member to rotate the group sender key before sending again.</p>
      </div>
    </section>
  </div>;
};
