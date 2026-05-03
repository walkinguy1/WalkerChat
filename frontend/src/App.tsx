import { useEffect, useMemo, useRef, useState } from 'react';
import { fetchBootstrap, fetchHistory, fetchPrekeyBundle, login, uploadIdentityKeys } from './lib/api';
import { mergeMessages, toDisplayMessage } from './lib/chat';
import {
  clearAllSessions,
  encryptMessage,
  generateKeyPair,
  getOrCreateSession,
  type KeyBundle,
} from './lib/crypto';
import { useWebSocket } from './hooks/useWebSocket';
import type {
  BootstrapChat,
  BootstrapResponse,
  BootstrapUser,
  ChatMessageEvent,
  DisplayMessage,
  RealtimeEvent,
} from './types/chat';

const apiUrl = import.meta.env.VITE_API_URL ?? 'http://localhost:8000';
const wsBaseUrl = import.meta.env.VITE_WS_URL ?? 'ws://localhost:8000';

const App = () => {
  const [bootstrap, setBootstrap] = useState<BootstrapResponse | null>(null);
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [historyState, setHistoryState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [bootstrapState, setBootstrapState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [typingUserId, setTypingUserId] = useState<string | null>(null);
  const [errorNotice, setErrorNotice] = useState<string | null>(null);
  const [presenceByUserId, setPresenceByUserId] = useState<Record<string, 'online' | 'offline'>>(
    {},
  );
  const typingTimeoutRef = useRef<number | null>(null);
  const [authToken, setAuthToken] = useState<string | null>(null);
  const [myKeys, setMyKeys] = useState<KeyBundle | null>(null);
  const [sessionAesKey, setSessionAesKey] = useState<CryptoKey | null>(null);

  const currentUser = useMemo<BootstrapUser | null>(
    () => bootstrap?.users.find((user) => user.id === selectedUserId) ?? null,
    [bootstrap, selectedUserId],
  );
  const activeChat = useMemo<BootstrapChat | null>(
    () => bootstrap?.chats.find((chat) => chat.id === activeChatId) ?? null,
    [activeChatId, bootstrap],
  );
  const peer = useMemo(
    () =>
      activeChat?.members.find((member) => member.user_id !== currentUser?.id) ?? null,
    [activeChat, currentUser?.id],
  );

  const socketUrl = currentUser && authToken
    ? `${wsBaseUrl}/api/ws/chat?token=${encodeURIComponent(authToken)}`
    : null;

  const { connectionState, sendMessage } = useWebSocket<RealtimeEvent>(socketUrl, {
    onMessage: (message) => {
      if (!activeChat || !currentUser) {
        return;
      }

      if (message.type === 'chat_message') {
        if (message.chat_id === activeChat.id) {
          setMessages((previousMessages) =>
            mergeMessages(previousMessages, toDisplayMessage(message)),
          );
        }
        return;
      }

      if (message.type === 'typing') {
        if (message.chat_id === activeChat.id && message.target_id === currentUser.id) {
          setTypingUserId(message.is_typing ? message.sender_id : null);
        }
        return;
      }

      if (message.type === 'presence') {
        if (message.chat_id === activeChat.id && message.target_id === currentUser.id) {
          setPresenceByUserId((previousState) => ({
            ...previousState,
            [message.user_id]: message.state,
          }));
        }
        return;
      }

      if (message.type === 'error') {
        setErrorNotice(message.detail);
      }
    },
  });

  useEffect(() => {
    let isActive = true;

    const loadBootstrap = async () => {
      setBootstrapState('loading');

      try {
        const payload = await fetchBootstrap(apiUrl, authToken!);
        if (!isActive) {
          return;
        }

        setBootstrap(payload);
        setSelectedUserId((currentValue) => currentValue ?? payload.users[0]?.id ?? null);
        setActiveChatId((currentValue) => currentValue ?? payload.chats[0]?.id ?? null);
        setPresenceByUserId(
          Object.fromEntries(payload.users.map((user) => [user.id, 'offline' as const])),
        );
        setBootstrapState('ready');
      } catch (error) {
        console.error('Unable to load bootstrap data.', error);
        if (isActive) {
          setBootstrapState('error');
        }
      }
    };

    void loadBootstrap();

    return () => {
      isActive = false;
    };
  }, [authToken]);

  useEffect(() => {
    if (!activeChat || !currentUser) {
      return;
    }

    let isActive = true;

    const loadHistory = async () => {
      setMessages([]);
      setTypingUserId(null);
      setErrorNotice(null);
      setHistoryState('loading');

      try {
        const payload = await fetchHistory(apiUrl, activeChat.id, authToken!);
        if (!isActive) {
          return;
        }

        setMessages(payload.items.map(toDisplayMessage));
        setHistoryState('ready');
      } catch (error) {
        console.error('Unable to load encrypted history.', error);
        if (isActive) {
          setHistoryState('error');
        }
      }
    };

    void loadHistory();

    return () => {
      isActive = false;
    };
  }, [activeChat, currentUser]);

  // Establish E2EE session when peer changes
  useEffect(() => {
    if (!peer || !myKeys || !authToken) {
      return;
    }

    let isActive = true;

    const establishSession = async () => {
      try {
        const bundle = await fetchPrekeyBundle(apiUrl, peer.user_id, authToken);
        const session = await getOrCreateSession(
          peer.user_id,
          bundle.signed_prekey_pub,
          myKeys,
        );
        if (isActive) {
          setSessionAesKey(session.sharedKey);
        }
      } catch (error) {
        console.error('Failed to establish E2EE session', error);
      }
    };

    void establishSession();

    return () => {
      isActive = false;
    };
  }, [peer?.user_id, myKeys, authToken]);

  useEffect(() => {
    if (!activeChat || !currentUser || !peer) {
      return;
    }

    if (!draft.trim()) {
      sendMessage({
        type: 'typing',
        chat_id: activeChat.id,
        sender_id: currentUser.id,
        target_id: peer.user_id,
        is_typing: false,
      });
      return;
    }

    sendMessage({
      type: 'typing',
      chat_id: activeChat.id,
      sender_id: currentUser.id,
      target_id: peer.user_id,
      is_typing: true,
    });

    if (typingTimeoutRef.current !== null) {
      window.clearTimeout(typingTimeoutRef.current);
    }

    typingTimeoutRef.current = window.setTimeout(() => {
      sendMessage({
        type: 'typing',
        chat_id: activeChat.id,
        sender_id: currentUser.id,
        target_id: peer.user_id,
        is_typing: false,
      });
    }, 900);

    return () => {
      if (typingTimeoutRef.current !== null) {
        window.clearTimeout(typingTimeoutRef.current);
      }
    };
  }, [activeChat, currentUser, draft, peer, sendMessage]);

  const connectionLabel = useMemo(() => {
    switch (connectionState) {
      case 'open':
        return 'Live secure session';
      case 'connecting':
        return 'Connecting secure session';
      case 'error':
        return 'Transport error';
      default:
        return 'Reconnecting secure session';
    }
  }, [connectionState]);

  const handleSend = async () => {
    if (!activeChat || !currentUser || !peer) {
      return;
    }

    const trimmedDraft = draft.trim();
    if (!trimmedDraft) {
      return;
    }

    // Encrypt with AES-GCM if session is established, else fallback
    const ciphertext = await encryptMessage(trimmedDraft, sessionAesKey ?? undefined);

    const outboundMessage: ChatMessageEvent = {
      type: 'chat_message',
      chat_id: activeChat.id,
      client_message_id: crypto.randomUUID(),
      sender_id: currentUser.id,
      target_id: peer.user_id,
      ciphertext,
      encryption: {
        algorithm: sessionAesKey ? 'aes-256-gcm' : 'signal-compatible-demo',
        version: 1,
        key_id: `${currentUser.username}-primary-device`,
      },
      sent_at: new Date().toISOString(),
    };

    setMessages((previousMessages) =>
      mergeMessages(previousMessages, toDisplayMessage(outboundMessage)),
    );

    const wasSent = sendMessage(outboundMessage);
    if (!wasSent) {
      setErrorNotice('The socket is not ready yet. Reconnect and send again.');
    } else {
      setErrorNotice(null);
    }

    sendMessage({
      type: 'typing',
      chat_id: activeChat.id,
      sender_id: currentUser.id,
      target_id: peer.user_id,
      is_typing: false,
    });
    setDraft('');
  };

  if (bootstrapState === 'loading') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-950 text-slate-200">
        Loading WalkerChat workspace...
      </div>
    );
  }

  if (bootstrapState === 'error' || !bootstrap || !currentUser || !activeChat) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-950 px-6 text-center text-slate-200">
        Unable to load the chat bootstrap data. Check that the FastAPI backend is running.
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[radial-gradient(circle_at_top,_#17325c,_#09111f_48%,_#030712)] text-slate-100">
      <div className="mx-auto flex min-h-screen max-w-7xl flex-col px-4 py-4 sm:px-6 lg:flex-row lg:gap-6 lg:px-8">
        <aside className="mb-4 w-full rounded-[2rem] border border-white/10 bg-slate-950/55 p-5 shadow-2xl shadow-cyan-950/30 backdrop-blur lg:mb-0 lg:w-[340px]">
          <div className="mb-8">
            <p className="text-xs uppercase tracking-[0.35em] text-cyan-300/70">
              WalkerChat
            </p>
            <h1 className="mt-3 text-3xl font-semibold text-white">
              Encrypted coordination
            </h1>
            <p className="mt-3 text-sm leading-6 text-slate-400">
              Bootstrap-driven demo identities, live presence, and typing signals now
              ride alongside encrypted chat delivery.
            </p>
          </div>

          <section className="mb-5 rounded-[1.5rem] border border-white/10 bg-white/5 p-4">
            <p className="text-xs uppercase tracking-[0.25em] text-slate-500">
              Operate As
            </p>
            <div className="mt-4 grid gap-3">
              {bootstrap.users.map((user) => (
                <button
                  key={user.id}
                  type="button"
                  onClick={async () => {
                    try {
                      // 1. Login
                      const tokenData = await login(apiUrl, user.username, 'walkerchat123');
                      setAuthToken(tokenData.access_token);
                      setSelectedUserId(tokenData.user_id);

                      // 2. Generate ECDH keypair
                      const keys = await generateKeyPair();
                      setMyKeys(keys);

                      // 3. Upload public keys to server
                      await uploadIdentityKeys(
                        apiUrl,
                        tokenData.access_token,
                        keys.publicKeyBase64,
                        keys.publicKeyBase64,
                      );

                      // 4. Clear old sessions
                      clearAllSessions();
                      setSessionAesKey(null);
                    } catch (err) {
                      console.error('Login failed', err);
                      setErrorNotice('Login failed. Check backend.');
                    }
                    setDraft('');
                    setTypingUserId(null);
                    setErrorNotice(null);
                  }}
                  className={`flex items-center gap-3 rounded-[1.2rem] border px-4 py-3 text-left transition ${selectedUserId === user.id
                    ? 'border-cyan-300/70 bg-cyan-400/15 text-white'
                    : 'border-white/10 bg-slate-950/60 text-slate-300 hover:border-white/20'
                    }`}
                >
                  <span className="flex h-11 w-11 items-center justify-center rounded-full bg-slate-900 text-sm font-semibold text-cyan-200">
                    {user.initials}
                  </span>
                  <span>
                    <span className="block text-sm font-semibold">{user.display_name}</span>
                    <span className="block text-xs uppercase tracking-[0.2em] text-slate-500">
                      {user.username}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          </section>

          <section className="rounded-[1.5rem] border border-cyan-400/20 bg-cyan-400/10 p-4">
            <p className="text-xs uppercase tracking-[0.25em] text-cyan-200/70">
              Active Thread
            </p>
            <h2 className="mt-3 text-lg font-semibold text-white">{activeChat.name}</h2>
            <p className="mt-2 text-sm text-slate-300">{activeChat.summary}</p>
            <div className="mt-4 space-y-3">
              {activeChat.members.map((member) => {
                const presence =
                  member.user_id === currentUser.id
                    ? connectionState === 'open'
                      ? 'online'
                      : 'offline'
                    : presenceByUserId[member.user_id] ?? 'offline';

                return (
                  <button
                    key={member.user_id}
                    type="button"
                    onClick={() => setActiveChatId(activeChat.id)}
                    className="flex w-full items-center gap-3 rounded-[1.1rem] border border-white/10 bg-slate-950/45 px-3 py-3 text-left"
                  >
                    <span className="flex h-10 w-10 items-center justify-center rounded-full bg-slate-900 text-xs font-semibold text-cyan-200">
                      {member.initials}
                    </span>
                    <span className="flex-1">
                      <span className="block text-sm font-semibold text-white">
                        {member.display_name}
                      </span>
                      <span className="block text-xs uppercase tracking-[0.2em] text-slate-500">
                        {member.username}
                      </span>
                    </span>
                    <span className="flex items-center gap-2 text-xs uppercase tracking-[0.2em] text-slate-400">
                      <span
                        className={`h-2.5 w-2.5 rounded-full ${presence === 'online' ? 'bg-emerald-400' : 'bg-slate-600'
                          }`}
                      />
                      {presence}
                    </span>
                  </button>
                );
              })}
            </div>
          </section>
        </aside>

        <main className="flex min-h-[720px] flex-1 flex-col rounded-[2rem] border border-white/10 bg-slate-950/65 shadow-2xl shadow-slate-950/50 backdrop-blur">
          <header className="flex flex-col gap-4 border-b border-white/10 px-5 py-5 sm:flex-row sm:items-center sm:justify-between sm:px-8">
            <div>
              <p className="text-sm uppercase tracking-[0.2em] text-slate-500">
                Secure Channel
              </p>
              <h2 className="mt-2 text-2xl font-semibold text-white">{activeChat.name}</h2>
              <p className="mt-2 text-sm text-slate-400">
                Signed in as {currentUser.display_name}
                {peer ? `, chatting with ${peer.display_name}` : ''}
              </p>
            </div>

            <div className="flex items-center gap-3 rounded-full border border-white/10 bg-white/5 px-4 py-2 text-sm text-slate-300">
              <span
                className={`h-2.5 w-2.5 rounded-full ${connectionState === 'open' ? 'bg-emerald-400' : 'bg-amber-300'
                  }`}
              />
              <span>{connectionLabel}</span>
            </div>
          </header>

          <section className="flex-1 overflow-y-auto px-5 py-6 sm:px-8">
            {errorNotice ? (
              <div className="mb-4 rounded-3xl border border-rose-400/30 bg-rose-400/10 p-4 text-sm text-rose-100">
                {errorNotice}
              </div>
            ) : null}

            {historyState === 'error' ? (
              <div className="mb-4 rounded-3xl border border-rose-400/30 bg-rose-400/10 p-4 text-sm text-rose-100">
                Encrypted history could not be loaded from the backend yet.
              </div>
            ) : null}

            <div className="space-y-4">
              {messages.map((message) => {
                const isCurrentUser = message.senderId === currentUser.id;

                return (
                  <div
                    key={message.id}
                    className={`flex ${isCurrentUser ? 'justify-end' : 'justify-start'}`}
                  >
                    <article
                      className={`max-w-xl rounded-[1.5rem] px-4 py-3 shadow-lg ${isCurrentUser
                        ? 'rounded-tr-md bg-cyan-500 text-slate-950'
                        : 'rounded-tl-md border border-white/10 bg-white/5 text-slate-100'
                        }`}
                    >
                      <p className="text-sm leading-6">{message.body}</p>
                      <div
                        className={`mt-3 flex items-center gap-2 text-[11px] uppercase tracking-[0.18em] ${isCurrentUser ? 'text-slate-900/60' : 'text-slate-400'
                          }`}
                      >
                        <span>{new Date(message.sentAt).toLocaleTimeString()}</span>
                        <span>{message.state}</span>
                      </div>
                    </article>
                  </div>
                );
              })}

              {typingUserId === peer?.user_id ? (
                <div className="flex justify-start">
                  <div className="rounded-full border border-white/10 bg-white/5 px-4 py-2 text-xs uppercase tracking-[0.22em] text-slate-400">
                    {peer.display_name} is typing...
                  </div>
                </div>
              ) : null}

              {historyState === 'loading' ? (
                <div className="text-sm text-slate-500">Loading encrypted history...</div>
              ) : null}
            </div>
          </section>

          <footer className="border-t border-white/10 px-5 py-5 sm:px-8">
            <div className="rounded-[1.75rem] border border-white/10 bg-white/5 p-3 shadow-inner shadow-slate-950/40">
              <div className="mb-3 flex items-center justify-between gap-3 text-xs uppercase tracking-[0.22em] text-slate-500">
                <span>{currentUser.display_name}</span>
                <span>Stored as ciphertext only</span>
              </div>

              <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
                <textarea
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !event.shiftKey) {
                      event.preventDefault();
                      handleSend();
                    }
                  }}
                  rows={2}
                  placeholder="Compose an encrypted message envelope..."
                  className="min-h-24 flex-1 resize-none rounded-[1.25rem] border border-white/10 bg-slate-950/70 px-4 py-3 text-sm text-white outline-none transition focus:border-cyan-400/60"
                />
                <button
                  type="button"
                  onClick={handleSend}
                  className="rounded-[1.25rem] bg-cyan-400 px-6 py-3 text-sm font-semibold text-slate-950 transition hover:bg-cyan-300"
                >
                  Send Securely
                </button>
              </div>
            </div>
          </footer>
        </main>
      </div>
    </div>
  );
};

export default App;
