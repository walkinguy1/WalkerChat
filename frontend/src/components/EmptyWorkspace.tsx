type EmptyWorkspaceProps = {
  displayName: string;
  onFindPeople: () => void;
  onSignOut: () => void;
};

export const EmptyWorkspace = ({ displayName, onFindPeople, onSignOut }: EmptyWorkspaceProps) => (
  <main className="flex h-full flex-col items-center justify-center gap-4 px-6 text-center">
    <h1 className="text-xl font-semibold">Welcome, {displayName}</h1>
    <p className="max-w-sm text-sm leading-6 text-ink-muted">
      Your account is ready. Find people or start a conversation to begin chatting.
    </p>
    <button type="button" onClick={onFindPeople} className="rounded-field bg-accent px-4 py-2.5 text-sm font-medium text-on-accent">
      Find people and start a conversation
    </button>
    <button type="button" onClick={onSignOut} className="text-sm text-ink-muted">Sign out</button>
  </main>
);
