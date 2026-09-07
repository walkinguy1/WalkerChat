import { useEffect, useState } from 'react';
import clsx from 'clsx';
import { Check, Search, Users, X } from 'lucide-react';

import { Avatar } from './ui/Avatar';
import { Button, IconButton } from './ui/Button';
import type { UserProfile } from '../lib/api';

interface NewChatDialogProps {
  open: boolean;
  onClose: () => void;
  onSearch: (query: string) => Promise<UserProfile[]>;
  onCreate: (input: { type: 'DIRECT' | 'GROUP'; name?: string; memberIds: string[] }) => Promise<void>;
}

/**
 * Start a direct chat or a group.
 *
 * Selecting more than one person implies a group, so there is no mode switch to get
 * wrong -- the name field simply appears once it is needed.
 */
export const NewChatDialog = ({ open, onClose, onSearch, onCreate }: NewChatDialogProps) => {
  // Mounted only while open, so its state resets on close without an effect that
  // fights React by setting state during render.
  if (!open) {
    return null;
  }

  return <NewChatDialogBody onClose={onClose} onSearch={onSearch} onCreate={onCreate} />;
};

const NewChatDialogBody = ({
  onClose,
  onSearch,
  onCreate,
}: Omit<NewChatDialogProps, 'open'>) => {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<UserProfile[]>([]);
  const [selected, setSelected] = useState<UserProfile[]>([]);
  const [groupName, setGroupName] = useState('');
  const [isCreating, setIsCreating] = useState(false);

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

  const canCreate =
    selected.length > 0 && (!isGroup || groupName.trim().length > 0) && !isCreating;

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
              return (
                <button
                  key={user.id}
                  type="button"
                  onClick={() => toggle(user)}
                  className={clsx(
                    'flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left transition-colors',
                    isSelected ? 'bg-accent-soft' : 'hover:bg-raised',
                  )}
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
                  {isSelected ? (
                    <Check className="h-4 w-4 flex-shrink-0 text-accent" aria-hidden="true" />
                  ) : null}
                </button>
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
