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
import { ChatInterface } from './components/ChatInterface';
import type {
  BootstrapResponse,
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

  const currentUser = useMemo(() => {
    const currentUser = bootstrap?.users.find((user) => user.id === selectedUserId);
    return currentUser ?? null;
  }, [bootstrap, selectedUserId]);

  const activeChat = useMemo(() => {
    const activeChat = bootstrap?.chats.find((chat) => chat.id === activeChatId);
    return activeChat ?? null;
  }, [activeChatId, bootstrap]);

  const peer = useMemo(() => {
    if (!activeChat || !currentUser) return null;
    const peer = activeChat.members.find((member) => member.user_id !== currentUser.id);
    return peer ?? null;
  }, [activeChat, currentUser]);

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
        
        // Ensure we have a session key before decrypting messages
        let activeAesKey = sessionAesKey;
        if (!activeAesKey && peer && myKeys) {
          console.log('Establishing session key for history decryption...');
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
            console.error('Failed to establish session for history:', error);
            // Load messages without decryption
            const displayMessages = payload.items.map((message) => ({
              id: message.message_id,
              clientMessageId: message.message_id,
              serverMessageId: message.message_id,
              senderId: message.sender_id,
              body: '[Encryption key required]',
              sentAt: message.sent_at,
              state: 'sent' as const,
            }));
            setMessages(displayMessages);
            setHistoryState('ready');
            return;
          }
        }

        const displayMessages = await Promise.all(
          payload.items.map((message) => resolveDisplayMessage(message, activeAesKey)),
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
  }, [activeChat, authToken, currentUser, sessionAesKey, peer, myKeys]);

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
      } catch (err) {
        setErrorNotice(err instanceof Error ? err.message : 'Secure session could not be established. Ensure peer is active.');
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
    } catch (err) {
      console.error('Secure send failed.', err);
      setErrorNotice(err instanceof Error ? err.message : 'Secure send failed.');
    }
  };

  if (!authToken || bootstrapState === 'signed_out') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[radial-gradient(ellipse_at_15%_0%,_#4a2f16_0%,_#120f0b_45%,_#080705_100%)] px-6 py-10 text-[#ffe6c5]">
        <div className="w-full max-w-4xl rounded-3xl border border-[#f8cd9855] bg-[#120e0acc] p-10 shadow-[0_25px_90px_-35px_rgba(242,173,91,0.7)] backdrop-blur-xl transition-all">
          <p className="text-xs font-bold uppercase tracking-[0.35em] text-[#ffbe73]">WalkerChat</p>
          <h1 className="font-display mt-4 bg-gradient-to-r from-[#ffe6be] via-[#ffcc87] to-[#9fefc9] bg-clip-text text-5xl font-extrabold tracking-tight text-transparent">
            Secure demo sign-in
          </h1>
          <p className="mt-5 max-w-2xl text-base font-light leading-7 text-[#d6b893]">
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
                className="group relative overflow-hidden rounded-[1.5rem] border border-[#f3c58844] bg-[#22180f99] p-6 text-left transition-all duration-300 hover:scale-[1.02] hover:border-[#ffc274aa] hover:bg-[#2d2015dd] hover:shadow-[0_0_30px_-5px_rgba(255,196,116,0.35)] disabled:opacity-50"
              >
                <div className="absolute inset-0 bg-gradient-to-br from-[#6ee5b500] via-[#6ee5b500] to-[#6ee5b522] opacity-0 transition-opacity duration-300 group-hover:opacity-100" />
                <div className="relative flex items-center gap-5">
                  <span className="flex h-16 w-16 items-center justify-center rounded-2xl border border-[#f6d09a33] bg-gradient-to-br from-[#3d2a1b] to-[#1c130d] text-lg font-bold text-[#f8cf91] shadow-inner transition-transform duration-300 group-hover:scale-110">
                    {account.initials}
                  </span>
                  <div>
                    <span className="block text-xl font-semibold tracking-wide text-[#fff0d6]">
                      {account.displayName}
                    </span>
                    <span className="mt-1 block text-xs uppercase tracking-[0.25em] text-[#d6b58a]">
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
      <div className="flex min-h-screen items-center justify-center bg-[radial-gradient(ellipse_at_center,_#3f2a19_0%,_#0f0d0a_75%)] text-[#ffdba8]">
        <div className="flex flex-col items-center gap-4 animate-pulse">
          <div className="h-10 w-10 animate-spin rounded-full border-4 border-[#ffc88140] border-t-[#ffc881]" />
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
    <div className="min-h-screen bg-[radial-gradient(ellipse_at_top_right,_#48311b_0%,_#14100d_42%,_#090806_100%)] text-[#ffe9cb]">
      <div className="mx-auto flex min-h-screen max-w-7xl flex-col px-4 py-6 sm:px-6 lg:flex-row lg:gap-8 lg:px-8">

        {/* SIDEBAR */}
        <aside className="mb-6 flex w-full flex-col rounded-3xl border border-[#f3c58838] bg-[#16110dda] p-6 shadow-[0_16px_45px_-22px_rgba(0,0,0,0.85)] backdrop-blur-xl lg:mb-0 lg:w-[360px]">
          <div className="mb-8 pl-1">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-[10px] sm:text-xs font-bold uppercase tracking-[0.4em] text-[#ffbd73]">
                  WalkerChat
                </p>
                <h1 className="font-display mt-2 bg-gradient-to-r from-[#ffe9c7] to-[#b4efd4] bg-clip-text text-2xl font-extrabold tracking-tight text-transparent">
                  Encrypted Coordination
                </h1>
              </div>
              <button
                type="button"
                onClick={() => void handleLogout()}
                className="group flex items-center justify-center rounded-full border border-[#f3c58844] bg-[#291d13b3] px-4 py-2 text-[10px] font-bold uppercase tracking-widest text-[#e6c89f] transition-all hover:bg-[#332417] hover:text-[#fff2df]"
              >
                Logout
              </button>
            </div>
          </div>

          <section className="mb-6 space-y-4">
            <div className="pl-1">
              <p className="text-[10px] font-bold uppercase tracking-widest text-[#aa8b65]">Operate As</p>
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
                    ? 'border-[#ffd19066] bg-gradient-to-r from-[#4a341f] to-[#1f2820] text-[#fff2de] shadow-[0_0_20px_-7px_rgba(255,186,105,0.35)]'
                    : 'border-[#f3c5882b] bg-[#241a12b0] text-[#d9be9a] hover:scale-[1.02] hover:bg-[#2b1f15]'
                    }`}
                >
                  <span className={`flex h-12 w-12 items-center justify-center rounded-xl text-sm font-bold shadow-inner ${selectedUserId === user.id ? 'bg-[#ffc274] text-[#261709]' : 'bg-[#3a291b] text-[#ffd39a]'}`}>
                    {user.initials}
                  </span>
                  <div>
                    <span className="block text-sm font-bold tracking-wide">{user.display_name}</span>
                    <span className="mt-0.5 block text-[10px] uppercase tracking-widest text-[#ab8e6b] group-hover:text-[#ecc389]">
                      @{user.username}
                    </span>
                  </div>
                </button>
              ))}
            </div>
          </section>

          <section className="mt-auto rounded-3xl border border-[#f3c5884a] bg-gradient-to-br from-[#322315] to-[#17201b] p-5 backdrop-blur-md">
            <div className="flex items-center gap-2 mb-4">
              <div className="h-2 w-2 rounded-full bg-[#ffc274] animate-pulse shadow-[0_0_8px_rgba(255,194,116,0.8)]" />
              <p className="text-[10px] font-bold uppercase tracking-widest text-[#ffd49c]">
                Active Thread
              </p>
            </div>
            <h2 className="font-display mb-2 text-xl font-bold tracking-tight text-[#fff0d7]">{activeChat.name}</h2>
            <p className="mb-5 text-xs leading-relaxed text-[#cfb392]">{activeChat.summary}</p>

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
                    className="group relative flex w-full items-center gap-3 rounded-2xl border border-[#f3c5882b] bg-[#1d1611d4] px-3 py-3 text-left transition hover:bg-[#2a1f15]"
                  >
                    <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-[#3a291b] text-xs font-bold text-[#ffd49f] shadow-inner transition-colors group-hover:bg-[#4b3522]">
                      {member.initials}
                    </span>
                    <span className="flex-1">
                      <span className="block text-sm font-bold tracking-wide text-[#fff1dd]">
                        {member.display_name}
                      </span>
                    </span>
                    <span className="flex items-center gap-2 pr-1 text-[10px] font-bold uppercase tracking-widest text-[#a48764]">
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
        <main className="relative flex min-h-[600px] flex-1 flex-col overflow-hidden rounded-3xl border border-[#f3c58840] bg-[#130f0be0] shadow-2xl shadow-black/70 backdrop-blur-xl lg:min-h-[720px]">
          <div className="pointer-events-none absolute right-0 top-0 h-96 w-96 rounded-full bg-[#ffc2741f] blur-[110px]" />
          <div className="pointer-events-none absolute bottom-[-120px] left-[-120px] h-80 w-80 rounded-full bg-[#67d8ad1c] blur-[100px]" />

          <header className="relative flex flex-col gap-4 border-b border-[#f3c58838] bg-[#2a1f1496] px-6 py-5 sm:flex-row sm:items-center sm:justify-between sm:px-8">
            <div>
              <p className="text-[10px] font-bold uppercase tracking-[0.25em] text-[#ffc274]">
                Secure Channel
              </p>
              <h2 className="font-display mt-1 text-3xl font-extrabold tracking-tight text-[#fff2de]">{activeChat.name}</h2>
              <p className="mt-1 text-xs text-[#bfa27f]">
                Signed in as <span className="font-semibold text-[#fff1dd]">{currentUser.display_name}</span>
                {peer ? `, chatting with ${peer.display_name}` : ''}
              </p>
            </div>

            <div className="flex items-center gap-3 rounded-full border border-[#f3c58844] bg-[#170f09bd] px-4 py-2 text-[11px] font-bold uppercase tracking-widest text-[#e1c5a0] backdrop-blur-sm">
              <span
                className={`h-2 w-2 rounded-full transition-colors ${connectionState === 'open' ? 'bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.8)]' : 'bg-amber-400 shadow-[0_0_8px_rgba(251,191,36,0.8)]'
                  }`}
              />
              <span>{connectionLabel}</span>
            </div>
          </header>

          <section className="relative flex flex-1 flex-col overflow-y-auto px-6 py-8 scroll-smooth sm:px-8">
            {errorNotice ? (
              <div className="mb-6 rounded-2xl border border-red-500/20 bg-red-500/10 p-4 text-sm text-red-200 backdrop-blur flex items-center gap-3 animate-in fade-in slide-in-from-top-2">
                <div className="h-2 w-2 rounded-full bg-red-400 animate-pulse" />
                {errorNotice}
              </div>
            ) : null}

            {historyState === 'loading' ? (
              <div className="mb-5 inline-flex w-fit items-center gap-2 rounded-full border border-[#f3c58845] bg-[#2a1f1590] px-4 py-1.5 text-xs uppercase tracking-[0.2em] text-[#f3cf9d]">
                <span className="h-2 w-2 animate-pulse rounded-full bg-[#ffc274]" />
                Syncing encrypted history
              </div>
            ) : null}

            {historyState === 'ready' && messages.length === 0 ? (
              <div className="mb-5 rounded-2xl border border-[#f3c58830] bg-[#1b140fad] p-4 text-sm text-[#d6b792]">
                No encrypted messages yet. Start the thread with a secure envelope.
              </div>
            ) : null}

            <ChatInterface
              messages={messages}
              currentUser={currentUser}
              peer={peer}
              isTyping={typingUserId === peer?.user_id}
              connectionLabel={connectionLabel}
            />
          </section>

          <footer className="relative border-t border-[#f3c5883a] bg-[#1a130dc4] px-6 py-5 backdrop-blur-xl sm:px-8">
            <div className="rounded-[1.75rem] border border-[#f3c5884a] bg-[#0f0b08cc] p-3 shadow-inner">
              <div className="mb-3 flex items-center justify-between gap-3 px-2 text-[10px] font-bold uppercase tracking-widest">
                <span className="text-[#ffc274]">{currentUser.display_name}</span>
                <span className={`flex items-center gap-2 ${sessionAesKey ? 'text-emerald-400' : 'text-[#7a6449]'}`}>
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
                  className="min-h-[5rem] flex-1 resize-none rounded-[1.25rem] border border-[#f3c58840] bg-[#1b140fbf] px-5 py-4 text-[15px] font-light text-[#ffe9ca] outline-none transition-all placeholder:text-[#8f775a] focus:border-[#ffc274aa] focus:bg-[#22190fd9] focus:shadow-[0_0_20px_-7px_rgba(255,194,116,0.6)]"
                />
                <button
                  type="button"
                  onClick={() => void handleSend()}
                  disabled={!draft.trim() || !sessionAesKey}
                  className="group relative flex-shrink-0 overflow-hidden rounded-[1.25rem] bg-gradient-to-r from-[#ffc274] to-[#74d7b0] px-4 py-2 text-xs font-bold text-[#231509] shadow-lg shadow-[#ffc2743d] transition-all hover:scale-105 hover:shadow-[#ffc27475] active:scale-95 disabled:hover:scale-100 disabled:opacity-50 disabled:shadow-none whitespace-nowrap"
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
