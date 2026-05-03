import { useEffect, useMemo, useRef, useState } from 'react';
import {
  fetchBootstrap,
  fetchHistory,
  fetchPrekeyBundle,
  fetchWsTicket,
  login,
  logout,
  uploadIdentityKeys,
} from './lib/api';
import {
  clearAllSessions,
  encryptMessage,
  getOrCreateKeyPair,
  getOrCreateSession,
  type KeyBundle,
} from './lib/crypto';
import {
  createOptimisticDisplayMessage,
  mergeMessages,
  resolveDisplayMessage,
} from './lib/chat';
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

const demoAccounts = [
  {
    username: 'alice',
    password: 'walkerchat123',
    displayName: 'Alice Walker',
    initials: 'AW',
  },
  {
    username: 'bob',
    password: 'walkerchat123',
    displayName: 'Bob Stone',
    initials: 'BS',
  },
] as const;

const App = () => {
  const [bootstrap, setBootstrap] = useState<BootstrapResponse | null>(null);
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [historyState, setHistoryState] = useState<'idle' | 'loading' | 'ready' | 'error'>(
    'idle',
  );
  const [bootstrapState, setBootstrapState] = useState<
    'signed_out' | 'loading' | 'ready' | 'error'
  >('signed_out');
  const [typingUserId, setTypingUserId] = useState<string | null>(null);
  const [errorNotice, setErrorNotice] = useState<string | null>(null);
  const [presenceByUserId, setPresenceByUserId] = useState<Record<string, 'online' | 'offline'>>(
    {},
  );
  const [authToken, setAuthToken] = useState<string | null>(null);
  const [wsTicket, setWsTicket] = useState<string | null>(null);
  const [myKeys, setMyKeys] = useState<KeyBundle | null>(null);
  const [sessionAesKey, setSessionAesKey] = useState<CryptoKey | null>(null);
  const [isSigningIn, setIsSigningIn] = useState(false);
  const typingTimeoutRef = useRef<number | null>(null);

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

  const socketUrl = wsTicket ? `${wsBaseUrl}/api/ws/chat?ticket=${encodeURIComponent(wsTicket)}` : null;

  const { connectionState, sendMessage } = useWebSocket<RealtimeEvent>(socketUrl, {
    onMessage: (message) => {
      if (!activeChat || !currentUser) {
        return;
      }

      if (message.type === 'chat_message') {
        if (message.chat_id === activeChat.id) {
          void resolveDisplayMessage(message, sessionAesKey).then((displayMessage) => {
            setMessages((previousMessages) => mergeMessages(previousMessages, displayMessage));
          });
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
    onClose: (event) => {
      if (event.code === 4001) {
        setWsTicket(null);
        setErrorNotice('Your secure session expired. Sign in again to continue.');
      }
    },
  });

  useEffect(() => {
    if (!authToken) {
      return;
    }

    let isActive = true;

    const loadSessionState = async () => {
      setBootstrapState('loading');

      try {
        const [bootstrapPayload, ticketPayload] = await Promise.all([
          fetchBootstrap(apiUrl, authToken),
          fetchWsTicket(apiUrl, authToken),
        ]);
        if (!isActive) {
          return;
        }

        setBootstrap(bootstrapPayload);
        setSelectedUserId(
          (currentValue) => currentValue ?? bootstrapPayload.users[0]?.id ?? null,
        );
        setActiveChatId(
          (currentValue) => currentValue ?? bootstrapPayload.chats[0]?.id ?? null,
        );
        setPresenceByUserId(
          Object.fromEntries(
            bootstrapPayload.users.map((user) => [user.id, user.presence_state]),
          ),
        );
        setWsTicket(ticketPayload.ticket);
        setBootstrapState('ready');
      } catch (error) {
        console.error('Unable to load authenticated bootstrap data.', error);
        if (isActive) {
          setBootstrapState('error');
          setErrorNotice(error instanceof Error ? error.message : 'Unable to load session.');
        }
      }
    };

    void loadSessionState();

    return () => {
      isActive = false;
    };
  }, [authToken]);

  useEffect(() => {
    if (!activeChat || !currentUser || !authToken) {
      return;
    }

    let isActive = true;

    const loadHistory = async () => {
      setMessages([]);
      setTypingUserId(null);
      setErrorNotice(null);
      setHistoryState('loading');

      try {
        const payload = await fetchHistory(apiUrl, activeChat.id, authToken);
        const displayMessages = await Promise.all(
          payload.items.map((message) => resolveDisplayMessage(message, sessionAesKey)),
        );
        if (!isActive) {
          return;
        }

        setMessages(displayMessages);
        setHistoryState('ready');
      } catch (error) {
        console.error('Unable to load encrypted history.', error);
        if (isActive) {
          setHistoryState('error');
          setErrorNotice(error instanceof Error ? error.message : 'Unable to load history.');
        }
      }
    };

    void loadHistory();

    return () => {
      isActive = false;
    };
  }, [activeChat, authToken, currentUser, sessionAesKey]);

  useEffect(() => {
    if (!peer || !myKeys || !authToken) {
      return;
    }

    let isActive = true;

    const establishSession = async () => {
      try {
        const bundle = await fetchPrekeyBundle(apiUrl, peer.user_id, authToken);
        const preferredPeerKey = bundle.one_time_prekey ?? bundle.signed_prekey_pub;
        const session = await getOrCreateSession(peer.user_id, preferredPeerKey, myKeys);
        if (isActive) {
          setSessionAesKey(session.sharedKey);
        }
      } catch (error) {
        console.error('Failed to establish secure session.', error);
        if (isActive) {
          setSessionAesKey(null);
          setErrorNotice('Unable to establish a secure session for this chat.');
        }
      }
    };

    void establishSession();

    return () => {
      isActive = false;
    };
  }, [authToken, myKeys, peer]);

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
        return wsTicket ? 'Reconnecting secure session' : 'Waiting for secure socket ticket';
    }
  }, [connectionState, wsTicket]);

  const handleSignIn = async (username: string, password: string) => {
    setIsSigningIn(true);
    setErrorNotice(null);

    try {
      if (authToken) {
        try {
          await logout(apiUrl, authToken);
        } catch {
          // Ignore stale token logout failures during account switch.
        }
      }

      clearAllSessions();
      setSessionAesKey(null);
      setWsTicket(null);

      const tokenData = await login(apiUrl, username, password);
      const keys = await getOrCreateKeyPair(username);
      await uploadIdentityKeys(
        apiUrl,
        tokenData.access_token,
        keys.publicKeyBase64,
        keys.publicKeyBase64,
      );

      setMyKeys(keys);
      setAuthToken(tokenData.access_token);
      setSelectedUserId(tokenData.user_id);
      setDraft('');
      setTypingUserId(null);
    } catch (error) {
      console.error('Login failed.', error);
      setErrorNotice(error instanceof Error ? error.message : 'Login failed.');
    } finally {
      setIsSigningIn(false);
    }
  };

  const handleLogout = async () => {
    try {
      if (authToken) {
        await logout(apiUrl, authToken);
      }
    } catch (error) {
      console.error('Logout failed.', error);
    } finally {
      clearAllSessions();
      setAuthToken(null);
      setWsTicket(null);
      setMyKeys(null);
      setSessionAesKey(null);
      setSelectedUserId(null);
      setActiveChatId(null);
      setDraft('');
      setTypingUserId(null);
      setErrorNotice(null);
    }
  };

  const handleSend = async () => {
    if (!activeChat || !currentUser || !peer) {
      return;
    }

    const trimmedDraft = draft.trim();
    if (!trimmedDraft) {
      return;
    }

    let activeAesKey = sessionAesKey;

    if (!activeAesKey) {
      if (!peer || !myKeys || !authToken) {
        setErrorNotice('Secure session is not ready yet. Wait for key exchange to finish.');
        return;
      }
      try {
        const bundle = await fetchPrekeyBundle(apiUrl, peer.user_id, authToken);
        const preferredPeerKey = bundle.one_time_prekey ?? bundle.signed_prekey_pub;
        if (preferredPeerKey === 'pending-client-upload') {
          throw new Error('Peer has not uploaded keys yet.');
        }
        const session = await getOrCreateSession(peer.user_id, preferredPeerKey, myKeys);
        setSessionAesKey(session.sharedKey);
        activeAesKey = session.sharedKey;
      } catch (error) {
        setErrorNotice('Secure session could not be established. Ensure peer is active.');
        return;
      }
    }

    try {
      const ciphertext = await encryptMessage(trimmedDraft, activeAesKey);
      const outboundMessage: ChatMessageEvent = {
        type: 'chat_message',
        chat_id: activeChat.id,
        client_message_id: crypto.randomUUID(),
        sender_id: currentUser.id,
        target_id: peer.user_id,
        ciphertext,
        encryption: {
          algorithm: 'aes-256-gcm',
          version: 1,
          key_id: `${currentUser.username}-primary-device`,
        },
        sent_at: new Date().toISOString(),
      };

      setMessages((previousMessages) =>
        mergeMessages(
          previousMessages,
          createOptimisticDisplayMessage(trimmedDraft, outboundMessage),
        ),
      );

      const wasSent = sendMessage(outboundMessage);
      if (!wasSent) {
        setErrorNotice('The socket is not ready yet. Reconnect and send again.');
        return;
      }

      sendMessage({
        type: 'typing',
        chat_id: activeChat.id,
        sender_id: currentUser.id,
        target_id: peer.user_id,
        is_typing: false,
      });
      setErrorNotice(null);
      setDraft('');
    } catch (error) {
      console.error('Secure send failed.', error);
      setErrorNotice(error instanceof Error ? error.message : 'Secure send failed.');
    }
  };

  if (!authToken || bootstrapState === 'signed_out') {
    return (
      <div className="min-h-screen bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-blue-950 via-slate-950 to-black px-6 py-10 text-slate-100 flex items-center justify-center">
        <div className="w-full max-w-4xl rounded-3xl border border-white/5 bg-slate-950/40 p-10 shadow-[0_0_80px_-20px_rgba(30,58,138,0.5)] backdrop-blur-xl transition-all">
          <p className="text-xs uppercase tracking-[0.35em] text-cyan-400/80 font-bold">WalkerChat</p>
          <h1 className="mt-4 text-5xl font-extrabold tracking-tight text-transparent bg-clip-text bg-gradient-to-r from-blue-200 via-cyan-200 to-emerald-200">
            Secure demo sign-in
          </h1>
          <p className="mt-5 max-w-2xl text-base leading-7 text-slate-400 font-light">
            This build now avoids placing the main JWT in the WebSocket URL, requires
            a secure session before sending encrypted messages, and exposes explicit
            demo sign-in cards for seeded users.
          </p>

          {errorNotice ? (
            <div className="mt-8 rounded-2xl border border-red-500/20 bg-red-500/10 p-5 text-sm text-red-200 backdrop-blur-md flex items-center gap-3 animate-in fade-in slide-in-from-top-2">
              <div className="h-2 w-2 rounded-full bg-red-400 animate-pulse" />
              {errorNotice}
            </div>
          ) : null}

          <div className="mt-10 grid gap-6 md:grid-cols-2">
            {demoAccounts.map((account) => (
              <button
                key={account.username}
                type="button"
                disabled={isSigningIn}
                onClick={() => void handleSignIn(account.username, account.password)}
                className="group relative overflow-hidden rounded-[1.5rem] border border-white/10 bg-white/5 p-6 text-left transition-all duration-300 hover:scale-[1.02] hover:border-cyan-400/40 hover:bg-white/10 hover:shadow-[0_0_30px_-5px_rgba(34,211,238,0.3)] disabled:opacity-50"
              >
                <div className="absolute inset-0 bg-gradient-to-br from-cyan-400/0 via-cyan-400/0 to-cyan-400/5 opacity-0 transition-opacity duration-300 group-hover:opacity-100" />
                <div className="relative flex items-center gap-5">
                  <span className="flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-to-br from-slate-800 to-slate-900 shadow-inner border border-white/5 text-lg font-bold text-cyan-300 transition-transform duration-300 group-hover:scale-110">
                    {account.initials}
                  </span>
                  <div>
                    <span className="block text-xl font-semibold text-white tracking-wide">
                      {account.displayName}
                    </span>
                    <span className="mt-1 block text-xs uppercase tracking-[0.25em] text-cyan-200/50">
                      @{account.username}
                    </span>
                  </div>
                </div>
              </button>
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (bootstrapState === 'loading') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[radial-gradient(ellipse_at_center,_var(--tw-gradient-stops))] from-slate-900 to-black text-cyan-200/80">
        <div className="flex flex-col items-center gap-4 animate-pulse">
          <div className="h-10 w-10 border-4 border-cyan-400/30 border-t-cyan-400 rounded-full animate-spin" />
          <span className="text-sm uppercase tracking-widest font-semibold">Loading Workspace...</span>
        </div>
      </div>
    );
  }

  if (bootstrapState === 'error' || !bootstrap || !currentUser || !activeChat) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-950 px-6 text-center text-slate-200 flex-col gap-4">
        <div className="h-16 w-16 rounded-full bg-red-500/20 text-red-400 flex items-center justify-center text-2xl border border-red-500/30">!</div>
        <p className="max-w-md text-lg text-slate-300 font-light">Unable to load the chat bootstrap data. Check that the FastAPI backend is running.</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[radial-gradient(ellipse_at_top_right,_var(--tw-gradient-stops))] from-blue-950 via-slate-950 to-black text-slate-100">
      <div className="mx-auto flex min-h-screen max-w-7xl flex-col px-4 py-6 sm:px-6 lg:flex-row lg:gap-8 lg:px-8">

        {/* SIDEBAR */}
        <aside className="mb-6 w-full rounded-3xl border border-white/5 bg-slate-900/40 p-6 shadow-[0_8px_30px_rgb(0,0,0,0.4)] backdrop-blur-xl lg:mb-0 lg:w-[360px] flex flex-col">
          <div className="mb-8 pl-1">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-[10px] sm:text-xs font-bold uppercase tracking-[0.4em] text-cyan-400/80">
                  WalkerChat
                </p>
                <h1 className="mt-2 text-2xl font-extrabold tracking-tight text-white bg-clip-text text-transparent bg-gradient-to-r from-white to-slate-400">
                  Encrypted Coordination
                </h1>
              </div>
              <button
                type="button"
                onClick={() => void handleLogout()}
                className="group flex items-center justify-center rounded-full border border-white/10 bg-white/5 px-4 py-2 text-[10px] font-bold uppercase tracking-widest text-slate-300 transition-all hover:bg-white/10 hover:text-white"
              >
                Logout
              </button>
            </div>
          </div>

          <section className="mb-6 space-y-4">
            <div className="pl-1">
              <p className="text-[10px] font-bold uppercase tracking-widest text-slate-500">Operate As</p>
            </div>
            <div className="grid gap-3">
              {bootstrap.users.map((user) => (
                <button
                  key={user.id}
                  type="button"
                  onClick={() => {
                    const matchingAccount = demoAccounts.find(
                      (account) => account.username === user.username,
                    );
                    if (matchingAccount) {
                      void handleSignIn(matchingAccount.username, matchingAccount.password);
                    }
                  }}
                  className={`group relative overflow-hidden flex items-center gap-4 rounded-2xl border px-4 py-3 text-left transition-all duration-300 ${selectedUserId === user.id
                    ? 'border-cyan-500/50 bg-gradient-to-r from-cyan-500/20 to-blue-500/10 text-white shadow-[0_0_20px_-5px_rgba(34,211,238,0.2)]'
                    : 'border-white/5 bg-white/5 text-slate-300 hover:scale-[1.02] hover:bg-white/10'
                    }`}
                >
                  <span className={`flex h-12 w-12 items-center justify-center rounded-xl text-sm font-bold shadow-inner ${selectedUserId === user.id ? 'bg-cyan-500 text-slate-950' : 'bg-slate-800 text-cyan-300'}`}>
                    {user.initials}
                  </span>
                  <div>
                    <span className="block text-sm font-bold tracking-wide">{user.display_name}</span>
                    <span className="mt-0.5 block text-[10px] uppercase tracking-widest text-slate-500 group-hover:text-cyan-200/50">
                      @{user.username}
                    </span>
                  </div>
                </button>
              ))}
            </div>
          </section>

          <section className="mt-auto rounded-3xl border border-cyan-500/20 bg-gradient-to-br from-cyan-500/10 to-blue-500/5 p-5 backdrop-blur-md">
            <div className="flex items-center gap-2 mb-4">
              <div className="h-2 w-2 rounded-full bg-cyan-400 animate-pulse shadow-[0_0_8px_rgba(34,211,238,0.8)]" />
              <p className="text-[10px] font-bold uppercase tracking-widest text-cyan-300">
                Active Thread
              </p>
            </div>
            <h2 className="text-xl font-bold tracking-tight text-white mb-2">{activeChat.name}</h2>
            <p className="text-xs text-slate-300/80 mb-5 leading-relaxed">{activeChat.summary}</p>

            <div className="space-y-3">
              {activeChat.members.map((member) => {
                const presence =
                  member.user_id === currentUser.id
                    ? connectionState === 'open'
                      ? 'online'
                      : 'offline'
                    : presenceByUserId[member.user_id] ?? member.presence_state;

                return (
                  <button
                    key={member.user_id}
                    type="button"
                    onClick={() => setActiveChatId(activeChat.id)}
                    className="group relative flex w-full items-center gap-3 rounded-2xl border border-white/5 bg-slate-900/50 px-3 py-3 text-left transition hover:bg-white/10"
                  >
                    <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-slate-800 text-xs font-bold text-cyan-200 shadow-inner group-hover:bg-slate-700 transition-colors">
                      {member.initials}
                    </span>
                    <span className="flex-1">
                      <span className="block text-sm font-bold text-white tracking-wide">
                        {member.display_name}
                      </span>
                    </span>
                    <span className="flex items-center gap-2 pr-1 text-[10px] font-bold uppercase tracking-widest text-slate-400">
                      <span
                        className={`transition-colors h-2 w-2 rounded-full shadow-sm ${presence === 'online' ? 'bg-emerald-400 shadow-emerald-400/50' : 'bg-slate-600'
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

        {/* MAIN CHAT AREA */}
        <main className="flex min-h-[600px] lg:min-h-[720px] flex-1 flex-col rounded-3xl border border-white/10 bg-slate-900/60 shadow-2xl shadow-slate-950/60 backdrop-blur-xl relative overflow-hidden">
          {/* Subtle background glow */}
          <div className="absolute top-0 right-0 w-96 h-96 bg-cyan-500/10 rounded-full blur-[100px] pointer-events-none" />

          <header className="relative flex flex-col gap-4 border-b border-white/10 bg-white/5 px-6 py-5 sm:flex-row sm:items-center sm:justify-between sm:px-8">
            <div>
              <p className="text-[10px] font-bold uppercase tracking-[0.25em] text-cyan-400">
                Secure Channel
              </p>
              <h2 className="mt-1 text-3xl font-extrabold tracking-tight text-white">{activeChat.name}</h2>
              <p className="mt-1 text-xs text-slate-400">
                Signed in as <span className="text-white font-semibold">{currentUser.display_name}</span>
                {peer ? `, chatting with ${peer.display_name}` : ''}
              </p>
            </div>

            <div className="flex items-center gap-3 rounded-full border border-white/10 bg-slate-950/50 px-4 py-2 text-[11px] font-bold uppercase tracking-widest text-slate-300 backdrop-blur-sm">
              <span
                className={`h-2 w-2 rounded-full transition-colors ${connectionState === 'open' ? 'bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.8)]' : 'bg-amber-400 shadow-[0_0_8px_rgba(251,191,36,0.8)]'
                  }`}
              />
              <span>{connectionLabel}</span>
            </div>
          </header>

          <section className="relative flex-1 overflow-y-auto px-6 py-8 sm:px-8 flex flex-col scroll-smooth">
            {errorNotice ? (
              <div className="mb-6 rounded-2xl border border-red-500/20 bg-red-500/10 p-4 text-sm text-red-200 backdrop-blur flex items-center gap-3 animate-in fade-in slide-in-from-top-2">
                <div className="h-2 w-2 rounded-full bg-red-400 animate-pulse" />
                {errorNotice}
              </div>
            ) : null}

            {historyState === 'error' ? (
              <div className="mb-6 rounded-2xl border border-rose-400/30 bg-rose-400/10 p-4 text-sm text-rose-100 backdrop-blur">
                Encrypted history could not be loaded from the backend yet.
              </div>
            ) : null}

            <div className="space-y-6 mt-auto">
              {messages.map((message) => {
                const isCurrentUser = message.senderId === currentUser.id;

                return (
                  <div
                    key={message.id}
                    className={`flex ${isCurrentUser ? 'justify-end' : 'justify-start'} animate-in slide-in-from-bottom-2 fade-in duration-300`}
                  >
                    <article
                      className={`max-w-[85%] sm:max-w-xl px-5 py-4 shadow-md transition-all ${isCurrentUser
                        ? 'rounded-3xl rounded-tr-sm bg-gradient-to-br from-cyan-400 to-blue-500 text-slate-950 shadow-cyan-500/20 hover:shadow-cyan-500/40'
                        : 'rounded-3xl rounded-tl-sm border border-white/10 bg-slate-800/80 text-white backdrop-blur-md hover:bg-slate-800'
                        }`}
                    >
                      <p className={`text-[15px] leading-relaxed ${isCurrentUser ? 'font-medium' : 'font-light'}`}>{message.body}</p>
                      <div
                        className={`mt-2 flex items-center gap-2 text-[10px] font-bold uppercase tracking-widest ${isCurrentUser ? 'text-slate-900/60' : 'text-slate-400'
                          }`}
                      >
                        <span>{new Date(message.sentAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                        {isCurrentUser && (
                          <span className="flex items-center gap-1">
                            <span className="h-1 w-1 rounded-full bg-current opacity-50" />
                            {message.state}
                          </span>
                        )}
                      </div>
                    </article>
                  </div>
                );
              })}

              {typingUserId === peer?.user_id ? (
                <div className="flex justify-start animate-in fade-in slide-in-from-bottom-2 duration-300">
                  <div className="flex items-center gap-2 rounded-full border border-white/10 bg-slate-800/60 px-4 py-2 text-[11px] font-bold uppercase tracking-widest text-slate-400 backdrop-blur-sm">
                    <div className="flex gap-1 mr-1">
                      <span className="w-1.5 h-1.5 rounded-full bg-cyan-400 animate-bounce" style={{ animationDelay: '0ms' }} />
                      <span className="w-1.5 h-1.5 rounded-full bg-cyan-400 animate-bounce" style={{ animationDelay: '150ms' }} />
                      <span className="w-1.5 h-1.5 rounded-full bg-cyan-400 animate-bounce" style={{ animationDelay: '300ms' }} />
                    </div>
                    {peer.display_name} is typing
                  </div>
                </div>
              ) : null}

              {historyState === 'loading' ? (
                <div className="flex items-center justify-center py-4">
                  <div className="text-xs font-bold uppercase tracking-widest text-slate-500 animate-pulse">Loading encrypted history...</div>
                </div>
              ) : null}
            </div>
          </section>

          <footer className="relative border-t border-white/10 bg-slate-900/80 px-6 py-5 sm:px-8 backdrop-blur-xl">
            <div className="rounded-[1.75rem] border border-white/10 bg-slate-950/50 p-3 shadow-inner">
              <div className="mb-3 flex items-center justify-between gap-3 px-2 text-[10px] font-bold uppercase tracking-widest">
                <span className="text-cyan-400">{currentUser.display_name}</span>
                <span className={`flex items-center gap-2 ${sessionAesKey ? 'text-emerald-400' : 'text-slate-500'}`}>
                  {sessionAesKey && <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse border border-emerald-300 shadow-[0_0_8px_rgba(52,211,153,0.8)]" />}
                  {sessionAesKey ? 'AES-GCM session active' : 'Waiting for session key'}
                </span>
              </div>

              <div className="flex flex-col gap-3 sm:flex-row sm:items-end relative">
                <textarea
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !event.shiftKey) {
                      event.preventDefault();
                      void handleSend();
                    }
                  }}
                  rows={2}
                  placeholder="Compose an encrypted message envelope..."
                  className="min-h-[5rem] flex-1 resize-none rounded-[1.25rem] border border-white/10 bg-slate-900/50 px-5 py-4 text-[15px] font-light text-white outline-none transition-all placeholder:text-slate-500 focus:border-cyan-500/50 focus:bg-slate-900/80 focus:shadow-[0_0_15px_-3px_rgba(34,211,238,0.15)]"
                />
                <button
                  type="button"
                  onClick={() => void handleSend()}
                  disabled={!draft.trim() || !sessionAesKey}
                  className="group relative overflow-hidden rounded-[1.25rem] bg-gradient-to-r from-cyan-400 to-emerald-400 px-6 py-4 text-sm font-bold text-slate-950 shadow-lg shadow-cyan-500/20 transition-all hover:scale-105 hover:shadow-cyan-500/40 active:scale-95 disabled:hover:scale-100 disabled:opacity-50 disabled:shadow-none"
                >
                  <div className="absolute inset-0 bg-white/20 opacity-0 transition-opacity group-hover:opacity-100" />
                  <span className="relative flex items-center gap-2">
                    Send Securely
                    <svg className="w-4 h-4 transition-transform group-hover:translate-x-1 group-active:translate-x-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M14 5l7 7m0 0l-7 7m7-7H3" />
                    </svg>
                  </span>
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
