import { useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import { Check, Search, Users, X } from 'lucide-react';

import { Avatar } from './ui/Avatar';
import { Button, IconButton } from './ui/Button';
import type { UserProfile } from '../lib/api';
import type { ContactRelations } from '../lib/api';

interface NewChatDialogProps {
  open: boolean;
  onClose: () => void;
  onSearch: (query: string) => Promise<UserProfile[]>;
  onLoadContacts: () => Promise<ContactRelations>;
  onRequestContact: (userId: string) => Promise<void>;
  onRespondContact: (requestId: string, action: 'accept' | 'reject') => Promise<void>;
  onBlockContact: (userId: string) => Promise<void>;
  onUnblockContact: (userId: string) => Promise<void>;
  onRemoveContact: (userId: string) => Promise<void>;
  onCreate: (input: { type: 'DIRECT' | 'GROUP'; name?: string; memberIds: string[] }) => Promise<void>;
}

/**
 * Start a direct chat or a group.
 *
 * Selecting more than one person implies a group, so there is no mode switch to get
 * wrong -- the name field simply appears once it is needed.
 */
export const NewChatDialog = ({ open, onClose, onSearch, onLoadContacts, onRequestContact, onRespondContact, onBlockContact, onUnblockContact, onRemoveContact, onCreate }: NewChatDialogProps) => {
  // Mounted only while open, so its state resets on close without an effect that
  // fights React by setting state during render.
  if (!open) {
    return null;
  }

  return <NewChatDialogBody onClose={onClose} onSearch={onSearch} onLoadContacts={onLoadContacts} onRequestContact={onRequestContact} onRespondContact={onRespondContact} onBlockContact={onBlockContact} onUnblockContact={onUnblockContact} onRemoveContact={onRemoveContact} onCreate={onCreate} />;
};

const NewChatDialogBody = ({
  onClose,
  onSearch,
  onLoadContacts,
  onRequestContact,
  onRespondContact,
  onBlockContact,
  onUnblockContact,
  onRemoveContact,
  onCreate,
}: Omit<NewChatDialogProps, 'open'>) => {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<UserProfile[]>([]);
  const [selected, setSelected] = useState<UserProfile[]>([]);
  const [groupName, setGroupName] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const [relations, setRelations] = useState<ContactRelations>({ contacts: [], requests: [], blocked: [] });
  const [busyUserId, setBusyUserId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const loadContactsRef = useRef(onLoadContacts);
  useEffect(() => { loadContactsRef.current = onLoadContacts; }, [onLoadContacts]);

  const refreshRelations = async () => setRelations(await loadContactsRef.current());

  useEffect(() => { void loadContactsRef.current().then(setRelations).catch(() => undefined); }, []);

  const isGroup = selected.length > 1;

  useEffect(() => {
    let cancelled = false;

    // Debounced, and every state write happens in the callback: a request per keystroke
    // would be wasteful and could land out of order.
    const timer = window.setTimeout(() => {
      const trimmed = query.trim();
      if (trimmed.length === 0) {
        setResults([]);
        return;
      }

      void onSearch(trimmed)
        .then((found) => {
          if (!cancelled) setResults(found);
        })
        .catch(() => {
          if (!cancelled) setResults([]);
        });
    }, 200);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [onSearch, query]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const toggle = (user: UserProfile) => {
    setSelected((previous) =>
      previous.some((entry) => entry.id === user.id)
        ? previous.filter((entry) => entry.id !== user.id)
        : [...previous, user],
    );
  };

  const contactIds = new Set(relations.contacts.map((contact) => contact.id));
  const canCreate = selected.length > 0 && selected.every((user) => contactIds.has(user.id)) && (!isGroup || groupName.trim().length > 0) && !isCreating;

  const requestContact = async (userId: string) => {
    setBusyUserId(userId);
    setActionError(null);
    try { await onRequestContact(userId); await refreshRelations(); }
    catch { setActionError('Unable to send that contact request. Check the account and try again.'); }
    finally { setBusyUserId(null); }
  };

  const respond = async (requestId: string, action: 'accept' | 'reject') => {
    setBusyUserId(requestId);
    setActionError(null);
    try { await onRespondContact(requestId, action); await refreshRelations(); }
    catch { setActionError('Unable to update that contact request.'); }
    finally { setBusyUserId(null); }
  };

  const changeBlock = async (userId: string, blocked: boolean) => {
    setBusyUserId(userId);
    setActionError(null);
    try {
      if (blocked) await onUnblockContact(userId);
      else await onBlockContact(userId);
      if (!blocked) setSelected((previous) => previous.filter((user) => user.id !== userId));
      await refreshRelations();
    } catch { setActionError('Unable to update that block.'); }
    finally { setBusyUserId(null); }
  };

  const removeContact = async (userId: string) => {
    setBusyUserId(userId);
    setActionError(null);
    try { await onRemoveContact(userId); setSelected((previous) => previous.filter((user) => user.id !== userId)); await refreshRelations(); }
    catch { setActionError('Unable to remove that contact. Existing conversations remain available.'); }
    finally { setBusyUserId(null); }
  };

  const create = async () => {
    setIsCreating(true);
    try {
      await onCreate({
        type: isGroup ? 'GROUP' : 'DIRECT',
        name: isGroup ? groupName.trim() : undefined,
        memberIds: selected.map((user) => user.id),
      });
    } finally {
      setIsCreating(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 p-4 pt-[10vh] backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label="Start a new chat"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="flex w-full max-w-md flex-col rounded-2xl border border-line bg-panel shadow-2xl">
        <div className="flex items-center justify-between gap-3 border-b border-line p-4">
          <h2 className="text-[15px] font-semibold tracking-tight">New conversation</h2>
          <IconButton size="sm" label="Close" onClick={onClose}>
            <X className="h-4 w-4" aria-hidden="true" />
          </IconButton>
        </div>

        {relations.requests.length ? (
          <section className="border-b border-line p-3" aria-label="Contact requests">
            <p className="mb-2 text-xs font-semibold">Contact requests</p>
            {relations.requests.map((entry) => (
              <div key={entry.id} className="flex items-center gap-2 py-1.5 text-xs">
                <span className="min-w-0 flex-1 truncate">{entry.user.display_name} · @{entry.user.username}</span>
                {entry.direction === 'incoming' ? <>
                  <button type="button" disabled={busyUserId === entry.id} onClick={() => void respond(entry.id, 'accept')} className="text-accent">Accept</button>
                  <button type="button" disabled={busyUserId === entry.id} onClick={() => void respond(entry.id, 'reject')} className="text-ink-muted">Ignore</button>
                </> : <span className="text-ink-muted">Pending</span>}
              </div>
            ))}
          </section>
        ) : null}
        {relations.blocked.length ? (
          <section className="border-b border-line p-3" aria-label="Blocked accounts">
            <p className="mb-2 text-xs font-semibold">Blocked accounts</p>
            {relations.blocked.map((entry) => <div key={entry.id} className="flex items-center gap-2 py-1.5 text-xs"><span className="min-w-0 flex-1 truncate">@{entry.username}</span><button type="button" disabled={busyUserId === entry.id} onClick={() => void changeBlock(entry.id, true)} className="text-accent">Unblock</button></div>)}
          </section>
        ) : null}
        {actionError ? <p role="alert" className="border-b border-line px-4 py-2 text-xs text-danger">{actionError}</p> : null}

        <div className="border-b border-line p-3">
          <div className="flex items-center gap-2 rounded-field border border-line bg-sunken px-3">
            <Search className="h-4 w-4 flex-shrink-0 text-ink-subtle" aria-hidden="true" />
            <input
              autoFocus
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search by username"
              aria-label="Search by username"
              className="h-10 flex-1 bg-transparent text-sm outline-none placeholder:text-ink-subtle"
            />
          </div>

          {selected.length > 0 ? (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {selected.map((user) => (
                <button
                  key={user.id}
                  type="button"
                  onClick={() => toggle(user)}
                  className="inline-flex items-center gap-1 rounded-full bg-accent-soft px-2 py-1 text-[11px] font-medium text-accent"
                >
                  {user.display_name}
                  <X className="h-3 w-3" aria-hidden="true" />
                </button>
              ))}
            </div>
          ) : null}
        </div>

        {isGroup ? (
          <div className="border-b border-line p-3">
            <label className="flex items-center gap-2 rounded-field border border-line bg-sunken px-3">
              <Users className="h-4 w-4 flex-shrink-0 text-ink-subtle" aria-hidden="true" />
              <input
                value={groupName}
                onChange={(event) => setGroupName(event.target.value)}
                placeholder="Group name"
                aria-label="Group name"
                className="h-10 flex-1 bg-transparent text-sm outline-none placeholder:text-ink-subtle"
              />
            </label>
          </div>
        ) : null}

        <div className="max-h-64 overflow-y-auto p-2">
          {results.length === 0 ? (
            <p className="p-4 text-center text-[12px] text-ink-muted">
              {query.trim() ? 'Nobody found with that username.' : 'Search for someone to begin.'}
            </p>
          ) : (
            results.map((user) => {
              const isSelected = selected.some((entry) => entry.id === user.id);
              const request = relations.requests.find((entry) => entry.user.id === user.id);
              const isContact = contactIds.has(user.id);
              const isBlocked = relations.blocked.some((entry) => entry.id === user.id);
              return (
                <div
                  key={user.id}
                  className="flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left"
                >
                  <Avatar name={user.display_name} initials={user.initials} size="sm" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-medium">
                      {user.display_name}
                    </span>
                    <span className="block truncate text-[11px] text-ink-muted">
                      @{user.username}
                    </span>
                  </span>
                  {isBlocked ? (
                    <span className="text-xs text-ink-muted">Blocked</span>
                  ) : isContact ? (
                    <button type="button" onClick={() => toggle(user)} className={clsx('rounded px-2 py-1 text-xs', isSelected ? 'bg-accent-soft text-accent' : 'text-ink-muted')}>
                      {isSelected ? <Check className="inline h-3 w-3" aria-hidden="true" /> : 'Add'}
                    </button>
                  ) : request ? (
                    <span className="text-xs text-ink-muted">Pending</span>
                  ) : (
                    <button type="button" disabled={busyUserId === user.id} onClick={() => void requestContact(user.id)} className="rounded bg-accent-soft px-2 py-1 text-xs text-accent">Request</button>
                  )}
                  {isContact ? <>
                    <button type="button" disabled={busyUserId === user.id} onClick={() => void removeContact(user.id)} className="text-xs text-ink-muted">Remove</button>
                    <button type="button" disabled={busyUserId === user.id} onClick={() => void changeBlock(user.id, false)} className="text-xs text-danger">Block</button>
                  </> : !isBlocked ? <button type="button" disabled={busyUserId === user.id} onClick={() => void changeBlock(user.id, false)} className="text-xs text-danger">Block</button> : null}
                </div>
              );
            })
          )}
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-line p-3">
          <span className="text-[11px] text-ink-muted">
            {isGroup
              ? `${selected.length} people — this will be a group`
              : selected.length === 1
                ? 'Direct message'
                : 'Pick one person, or several for a group'}
          </span>
          <Button variant="primary" disabled={!canCreate} loading={isCreating} onClick={() => void create()}>
            Start
          </Button>
        </div>
      </div>
    </div>
  );
};
