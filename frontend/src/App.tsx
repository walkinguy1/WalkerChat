import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import {
  fetchBootstrap,
  fetchHistory,
  fetchIceConfig,
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
  encodeMessagePayload,
  mergeMessages,
  resolveDisplayMessage,
} from './lib/chat';
import { encryptAndUploadImage } from './lib/media';
import { pushToast, clearToasts } from './lib/toast';
import { useWebSocket } from './hooks/useWebSocket';
import { useWebRTC, type OutboundSignal } from './hooks/useWebRTC';
import { SignIn, type DemoAccount } from './components/SignIn';
import { Sidebar, type ConversationSummary } from './components/Sidebar';
import { ChatHeader } from './components/ChatHeader';
import { MessageList, type HistoryState } from './components/MessageList';
import { Composer } from './components/Composer';
import { CallOverlay } from './components/CallOverlay';
import { Lightbox, type LightboxImage } from './components/Lightbox';
import { Toaster } from './components/ui/Toaster';
import { Logo } from './components/ui/Logo';
import type {
  BootstrapResponse,
  CallMediaKind,
  ChatMessageEvent,
  ChatMessageRecord,
  DisplayMessage,
  ImageAttachment,
  RealtimeEvent,
  WebRtcSignalEvent,
} from './types/chat';

const DEFAULT_ICE_SERVERS: RTCIceServer[] = [{ urls: ['stun:stun.l.google.com:19302'] }];

const apiUrl = import.meta.env.VITE_API_URL ?? 'http://localhost:8000';
const wsBaseUrl = import.meta.env.VITE_WS_URL ?? 'ws://localhost:8000';

const demoAccounts: readonly DemoAccount[] = [
  {
    username: 'alice',
    password: 'walkerchat123',
    displayName: 'Alice Walker',
    initials: 'AW',
    role: 'Field lead',
  },
  {
    username: 'bob',
    password: 'walkerchat123',
    displayName: 'Bob Stone',
    initials: 'BS',
    role: 'Operations',
  },
];

const App = () => {
  const [bootstrap, setBootstrap] = useState<BootstrapResponse | null>(null);
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  /** Raw ciphertext records; decrypted by a separate effect once a key exists. */
  const [historyRecords, setHistoryRecords] = useState<ChatMessageRecord[]>([]);
  const [historyState, setHistoryState] = useState<HistoryState>('idle');
  /** Which thread the state above belongs to, so a switch can reset it. */
  const [loadedChatId, setLoadedChatId] = useState<string | null>(null);
  const [bootstrapState, setBootstrapState] = useState<
    'signed_out' | 'loading' | 'ready' | 'error'
  >('signed_out');
  const [typingUserId, setTypingUserId] = useState<string | null>(null);
  const [presenceByUserId, setPresenceByUserId] = useState<Record<string, 'online' | 'offline'>>(
    {},
  );
  const [authToken, setAuthToken] = useState<string | null>(null);
  const [wsTicket, setWsTicket] = useState<string | null>(null);
  const [myKeys, setMyKeys] = useState<KeyBundle | null>(null);
  const [sessionAesKey, setSessionAesKey] = useState<CryptoKey | null>(null);
  const [signingInUsername, setSigningInUsername] = useState<string | null>(null);
  const [isUploadingPhoto, setIsUploadingPhoto] = useState(false);
  const [lightboxImage, setLightboxImage] = useState<LightboxImage | null>(null);
  const [iceServers, setIceServers] = useState<RTCIceServer[]>(DEFAULT_ICE_SERVERS);
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);

  const typingTimeoutRef = useRef<number | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  // Set after useWebRTC initialises, so the socket handler below can reach it
  // without the two hooks depending on each other.
  const handleSignalRef = useRef<((signal: WebRtcSignalEvent) => void) | null>(null);

  const currentUser = useMemo(
    () => bootstrap?.users.find((user) => user.id === selectedUserId) ?? null,
    [bootstrap, selectedUserId],
  );

  const activeChat = useMemo(
    () => bootstrap?.chats.find((chat) => chat.id === activeChatId) ?? null,
    [activeChatId, bootstrap],
  );

  const peer = useMemo(() => {
    if (!activeChat || !currentUser) return null;
    return activeChat.members.find((member) => member.user_id !== currentUser.id) ?? null;
  }, [activeChat, currentUser]);

  const socketUrl = wsTicket
    ? `${wsBaseUrl}/api/ws/chat?ticket=${encodeURIComponent(wsTicket)}`
    : null;

  const { connectionState, sendMessage } = useWebSocket<RealtimeEvent>(socketUrl, {
    onMessage: (message) => {
      // Call signals are handled before the chat guards so an incoming call
      // still rings while chat state is settling.
      if (message.type.startsWith('webrtc_')) {
        handleSignalRef.current?.(message as WebRtcSignalEvent);
        return;
      }

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
        pushToast(message.detail);
      }
    },
    onClose: (event) => {
      if (event.code === 4001) {
        setWsTicket(null);
        pushToast('Your secure session expired. Sign in again to continue.');
      }
    },
  });

  const isSocketOpen = connectionState === 'open';

  const sendCallSignal = useCallback(
    (signal: OutboundSignal) => {
      if (!activeChat || !currentUser || !peer) {
        return false;
      }

      return sendMessage({
        type: signal.type,
        chat_id: activeChat.id,
        call_id: signal.call_id,
        sender_id: currentUser.id,
        target_id: peer.user_id,
        media: signal.media,
        payload: signal.payload,
      } satisfies WebRtcSignalEvent);
    },
    // sendMessage is re-created each render but only reads a socket ref, so it
    // is safe to leave out of the dependency list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activeChat, currentUser, peer],
  );

  const call = useWebRTC({
    sendSignal: sendCallSignal,
    iceServers,
    onError: (message) => pushToast(message),
  });

  useEffect(() => {
    handleSignalRef.current = (signal) => {
      void call.handleSignal(signal);
    };
  }, [call]);

  useEffect(() => {
    if (!authToken) {
      return;
    }

    let isActive = true;

    fetchIceConfig(apiUrl, authToken)
      .then((servers) => {
        if (isActive && servers.length) {
          setIceServers(servers);
        }
      })
      .catch((error) => {
        // Falling back to public STUN still works on most home networks.
        console.warn('Unable to load ICE configuration, using defaults.', error);
      });

    return () => {
      isActive = false;
    };
  }, [authToken]);

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
        setSelectedUserId((currentValue) => currentValue ?? bootstrapPayload.users[0]?.id ?? null);
        setActiveChatId((currentValue) => currentValue ?? bootstrapPayload.chats[0]?.id ?? null);
        setPresenceByUserId(
          Object.fromEntries(bootstrapPayload.users.map((user) => [user.id, user.presence_state])),
        );
        setWsTicket(ticketPayload.ticket);
        setBootstrapState('ready');
      } catch (error) {
        console.error('Unable to load authenticated bootstrap data.', error);
        if (isActive) {
          setBootstrapState('error');
          pushToast(error instanceof Error ? error.message : 'Unable to load session.');
        }
      }
    };

    void loadSessionState();

    return () => {
      isActive = false;
    };
  }, [authToken]);

  // Reset thread-scoped state during render rather than in an effect, so the
  // outgoing thread's messages never paint into the incoming one for a frame.
  if (activeChatId !== loadedChatId) {
    setLoadedChatId(activeChatId);
    setMessages([]);
    setHistoryRecords([]);
    setTypingUserId(null);
    setHistoryState(activeChatId ? 'loading' : 'idle');
  }

  /**
   * Fetch ciphertext for the open thread.
   *
   * Deliberately does not depend on the session key: decryption is a separate
   * effect below. Keeping them apart stops the key arriving from re-triggering
   * a network round trip for history we already hold.
   */
  useEffect(() => {
    if (!activeChatId || !authToken) {
      return;
    }

    let isActive = true;

    fetchHistory(apiUrl, activeChatId, authToken)
      .then((payload) => {
        if (!isActive) return;
        setHistoryRecords(payload.items);
        setHistoryState('ready');
      })
      .catch((error) => {
        console.error('Unable to load encrypted history.', error);
        if (!isActive) return;
        setHistoryState('error');
        pushToast(error instanceof Error ? error.message : 'Unable to load history.');
      });

    return () => {
      isActive = false;
    };
  }, [activeChatId, authToken]);

  /**
   * Decrypt whatever history we hold. Re-runs when the key lands, so messages
   * that first rendered as locked placeholders resolve in place.
   */
  useEffect(() => {
    if (!historyRecords.length) {
      return;
    }

    let isActive = true;

    void Promise.all(
      historyRecords.map((record) => resolveDisplayMessage(record, sessionAesKey)),
    ).then((decrypted) => {
      if (!isActive) return;
      // Fold through mergeMessages so live messages that arrived while we were
      // decrypting are preserved rather than overwritten.
      setMessages((previousMessages) => decrypted.reduce(mergeMessages, previousMessages));
    });

    return () => {
      isActive = false;
    };
  }, [historyRecords, sessionAesKey]);

  /** Establish the shared AES key for the open thread. */
  useEffect(() => {
    if (!peer || !myKeys || !authToken) {
      return;
    }

    let isActive = true;

    const establishSession = async () => {
      try {
        const bundle = await fetchPrekeyBundle(apiUrl, peer.user_id, authToken);
        const preferredPeerKey = bundle.one_time_prekey ?? bundle.signed_prekey_pub;
        if (preferredPeerKey === 'pending-client-upload') {
          throw new Error('This peer has not uploaded their keys yet.');
        }
        const session = await getOrCreateSession(peer.user_id, preferredPeerKey, myKeys);
        if (isActive) {
          setSessionAesKey(session.sharedKey);
        }
      } catch (error) {
        console.error('Failed to establish secure session.', error);
        if (isActive) {
          setSessionAesKey(null);
          pushToast(
            error instanceof Error
              ? error.message
              : 'Unable to establish a secure session for this chat.',
          );
        }
      }
    };

    void establishSession();

    return () => {
      isActive = false;
    };
  }, [authToken, myKeys, peer]);

  /** Broadcast typing state, debounced back to idle after a pause. */
  useEffect(() => {
    if (!activeChat || !currentUser || !peer) {
      return;
    }

    const emitTyping = (isTyping: boolean) =>
      sendMessage({
        type: 'typing',
        chat_id: activeChat.id,
        sender_id: currentUser.id,
        target_id: peer.user_id,
        is_typing: isTyping,
      });

    if (!draft.trim()) {
      emitTyping(false);
      return;
    }

    emitTyping(true);

    if (typingTimeoutRef.current !== null) {
      window.clearTimeout(typingTimeoutRef.current);
    }
    typingTimeoutRef.current = window.setTimeout(() => emitTyping(false), 900);

    return () => {
      if (typingTimeoutRef.current !== null) {
        window.clearTimeout(typingTimeoutRef.current);
      }
    };
  }, [activeChat, currentUser, draft, peer, sendMessage]);

  /** `/` focuses search, Escape closes whatever overlay is open. */
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const isEditing =
        target?.tagName === 'INPUT' ||
        target?.tagName === 'TEXTAREA' ||
        target?.isContentEditable;

      if (event.key === '/' && !isEditing) {
        event.preventDefault();
        setIsSidebarOpen(true);
        searchInputRef.current?.focus();
        return;
      }

      if (event.key === 'Escape') {
        setIsSidebarOpen(false);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  const handleSignIn = async (account: DemoAccount) => {
    setSigningInUsername(account.username);
    clearToasts();

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

      const tokenData = await login(apiUrl, account.username, account.password);
      const keys = await getOrCreateKeyPair(account.username);
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
      pushToast(error instanceof Error ? error.message : 'Login failed.');
    } finally {
      setSigningInUsername(null);
    }
  };

  const handleSignOut = async () => {
    try {
      if (authToken) {
        await logout(apiUrl, authToken);
      }
    } catch (error) {
      console.error('Logout failed.', error);
    } finally {
      clearAllSessions();
      clearToasts();
      setAuthToken(null);
      setWsTicket(null);
      setMyKeys(null);
      setSessionAesKey(null);
      setSelectedUserId(null);
      setActiveChatId(null);
      setBootstrap(null);
      setBootstrapState('signed_out');
      setMessages([]);
      setHistoryRecords([]);
      setHistoryState('idle');
      setDraft('');
      setTypingUserId(null);
      setIsSidebarOpen(false);
    }
  };

  /**
   * Return the chat's AES key, establishing the session on demand.
   *
   * Both text and photo sends need this, and either can run before the
   * background key exchange effect has finished.
   */
  const ensureSessionKey = async (): Promise<CryptoKey | null> => {
    if (sessionAesKey) {
      return sessionAesKey;
    }

    if (!peer || !myKeys || !authToken) {
      pushToast('The secure session is not ready yet. Wait for the key exchange to finish.');
      return null;
    }

    try {
      const bundle = await fetchPrekeyBundle(apiUrl, peer.user_id, authToken);
      const preferredPeerKey = bundle.one_time_prekey ?? bundle.signed_prekey_pub;
      if (preferredPeerKey === 'pending-client-upload') {
        throw new Error('This peer has not uploaded their keys yet.');
      }
      const session = await getOrCreateSession(peer.user_id, preferredPeerKey, myKeys);
      setSessionAesKey(session.sharedKey);
      return session.sharedKey;
    } catch (error) {
      pushToast(
        error instanceof Error
          ? error.message
          : 'The secure session could not be established. Make sure the peer is active.',
      );
      return null;
    }
  };

  /** Encrypt, send, and optimistically render one message. */
  const sendEncryptedMessage = async (
    aesKey: CryptoKey,
    caption: string,
    attachment?: ImageAttachment,
  ): Promise<boolean> => {
    if (!activeChat || !currentUser || !peer) {
      return false;
    }

    const ciphertext = await encryptMessage(encodeMessagePayload(caption, attachment), aesKey);

    const outboundMessage: ChatMessageEvent = {
      type: 'chat_message',
      chat_id: activeChat.id,
      client_message_id: crypto.randomUUID(),
      sender_id: currentUser.id,
      target_id: peer.user_id,
      ciphertext,
      is_media: Boolean(attachment),
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
        createOptimisticDisplayMessage(caption, outboundMessage, attachment),
      ),
    );

    if (!sendMessage(outboundMessage)) {
      pushToast('The socket is not connected yet. Reconnect and send again.');
      return false;
    }

    sendMessage({
      type: 'typing',
      chat_id: activeChat.id,
      sender_id: currentUser.id,
      target_id: peer.user_id,
      is_typing: false,
    });

    return true;
  };

  const handleSend = async () => {
    const trimmedDraft = draft.trim();
    if (!trimmedDraft || !activeChat || !currentUser || !peer) {
      return;
    }

    const activeAesKey = await ensureSessionKey();
    if (!activeAesKey) {
      return;
    }

    try {
      if (await sendEncryptedMessage(activeAesKey, trimmedDraft)) {
        setDraft('');
      }
    } catch (error) {
      console.error('Secure send failed.', error);
      pushToast(error instanceof Error ? error.message : 'Secure send failed.');
    }
  };

  /**
   * Encrypt a photo in the browser, upload the ciphertext, then send a message
   * carrying the (also encrypted) attachment descriptor. The backend stores
   * bytes it cannot read.
   */
  const handleSendPhoto = async (file: File) => {
    if (!activeChat || !currentUser || !peer || !authToken) {
      return;
    }

    const activeAesKey = await ensureSessionKey();
    if (!activeAesKey) {
      return;
    }

    setIsUploadingPhoto(true);

    try {
      const attachment = await encryptAndUploadImage(
        apiUrl,
        activeChat.id,
        authToken,
        activeAesKey,
        file,
      );

      if (await sendEncryptedMessage(activeAesKey, draft.trim(), attachment)) {
        setDraft('');
      }
    } catch (error) {
      console.error('Encrypted photo send failed.', error);
      pushToast(error instanceof Error ? error.message : 'Unable to send that photo.');
    } finally {
      setIsUploadingPhoto(false);
    }
  };

  const handleStartCall = async (media: CallMediaKind) => {
    if (!peer) {
      pushToast('Select a chat with a peer before starting a call.');
      return;
    }

    if (!isSocketOpen) {
      pushToast('The secure socket is not connected, so a call cannot be placed.');
      return;
    }

    await call.startCall(media);
  };

  /** Sidebar rows, with the newest decrypted line as the preview. */
  const conversations = useMemo<ConversationSummary[]>(() => {
    if (!bootstrap || !currentUser) return [];

    return bootstrap.chats.map((chat) => {
      const chatPeer = chat.members.find((member) => member.user_id !== currentUser.id);
      const isActiveThread = chat.id === activeChatId;
      const latest = isActiveThread ? messages[messages.length - 1] : undefined;

      const preview = latest
        ? `${latest.senderId === currentUser.id ? 'You: ' : ''}${
            latest.attachment && !latest.body ? 'Photo' : latest.body
          }`
        : chat.summary;

      return {
        chat,
        peerName: chatPeer?.display_name ?? chat.name,
        peerInitials: chatPeer?.initials ?? '',
        presence: chatPeer
          ? (presenceByUserId[chatPeer.user_id] ?? chatPeer.presence_state)
          : 'offline',
        preview,
        lastActivityAt: latest?.sentAt ?? null,
        // Threads other than the open one are not streamed, so there is no
        // honest unread count to show yet.
        unreadCount: 0,
      };
    });
  }, [activeChatId, bootstrap, currentUser, messages, presenceByUserId]);

  if (!authToken || bootstrapState === 'signed_out') {
    return (
      <>
        <SignIn
          accounts={demoAccounts}
          pendingUsername={signingInUsername}
          isSigningIn={signingInUsername !== null}
          onSignIn={(account) => void handleSignIn(account)}
        />
        <Toaster />
      </>
    );
  }

  if (bootstrapState === 'loading') {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4">
        <Logo className="h-11 w-11 animate-sheen" />
        <p className="text-[13px] text-ink-muted">Restoring your encrypted workspace…</p>
      </div>
    );
  }

  if (bootstrapState === 'error' || !bootstrap || !currentUser || !activeChat) {
    return (
      <>
        <div className="flex h-full flex-col items-center justify-center gap-4 px-6 text-center">
          <span className="flex h-12 w-12 items-center justify-center rounded-2xl border border-danger/30 bg-danger-soft text-lg font-semibold text-danger">
            !
          </span>
          <div>
            <h1 className="text-[15px] font-semibold">Workspace unavailable</h1>
            <p className="mt-2 max-w-sm text-[13px] leading-6 text-ink-muted">
              The bootstrap data could not be loaded. Check that the FastAPI backend is
              running on {apiUrl}, then sign in again.
            </p>
          </div>
          <button
            type="button"
            onClick={() => void handleSignOut()}
            className="mt-1 rounded-field border border-line bg-raised px-4 py-2 text-sm font-medium transition-colors hover:border-line-strong"
          >
            Back to sign in
          </button>
        </div>
        <Toaster />
      </>
    );
  }

  const peerPresence = peer
    ? (presenceByUserId[peer.user_id] ?? peer.presence_state)
    : 'offline';

  return (
    <div className="flex h-full overflow-hidden">
      {/* Scrim for the mobile slide-over. */}
      {isSidebarOpen ? (
        <div
          role="presentation"
          onClick={() => setIsSidebarOpen(false)}
          className="fixed inset-0 z-30 animate-fade bg-black/50 backdrop-blur-[2px] lg:hidden"
        />
      ) : null}

      <aside
        className={clsx(
          'fixed inset-y-0 left-0 z-40 w-[19rem] max-w-[85vw] border-r border-line transition-transform duration-250 ease-[cubic-bezier(0.22,1,0.36,1)]',
          'lg:static lg:z-auto lg:w-[19rem] lg:translate-x-0',
          isSidebarOpen ? 'translate-x-0 shadow-pop' : '-translate-x-full lg:shadow-none',
        )}
      >
        <Sidebar
          ref={searchInputRef}
          currentUser={currentUser}
          conversations={conversations}
          activeChatId={activeChatId}
          isSocketOpen={isSocketOpen}
          onSelectChat={(chatId) => {
            setActiveChatId(chatId);
            setIsSidebarOpen(false);
          }}
          onSignOut={() => void handleSignOut()}
          onClose={() => setIsSidebarOpen(false)}
        />
      </aside>

      <main className="flex min-w-0 flex-1 flex-col bg-canvas">
        <ChatHeader
          chat={activeChat}
          peer={peer}
          peerPresence={peerPresence}
          connectionState={connectionState}
          isSecure={Boolean(sessionAesKey)}
          isPeerTyping={typingUserId === peer?.user_id}
          canCall={Boolean(peer) && !call.isCallActive && isSocketOpen}
          onStartCall={(media) => void handleStartCall(media)}
          onOpenSidebar={() => setIsSidebarOpen(true)}
        />

        <MessageList
          messages={messages}
          currentUser={currentUser}
          peer={peer}
          isPeerTyping={typingUserId === peer?.user_id}
          historyState={historyState}
          apiUrl={apiUrl}
          authToken={authToken}
          sessionAesKey={sessionAesKey}
          onOpenImage={(url, name) => setLightboxImage({ url, name })}
        />

        <Composer
          draft={draft}
          onDraftChange={setDraft}
          onSend={() => void handleSend()}
          onSendPhoto={(file) => void handleSendPhoto(file)}
          isSecure={Boolean(sessionAesKey)}
          isUploading={isUploadingPhoto}
          isSocketOpen={isSocketOpen}
          peerName={peer?.display_name ?? activeChat.name}
        />
      </main>

      <CallOverlay
        status={call.status}
        mediaKind={call.mediaKind}
        peerName={peer?.display_name ?? 'Peer'}
        peerInitials={peer?.initials}
        localStream={call.localStream}
        remoteStream={call.remoteStream}
        incomingCall={call.incomingCall}
        isMuted={call.isMuted}
        isCameraOff={call.isCameraOff}
        onAccept={() => void call.acceptCall()}
        onReject={call.rejectCall}
        onHangUp={call.hangUp}
        onToggleMute={call.toggleMute}
        onToggleCamera={call.toggleCamera}
      />

      <Lightbox image={lightboxImage} onClose={() => setLightboxImage(null)} />
      <Toaster />
    </div>
  );
};

export default App;
