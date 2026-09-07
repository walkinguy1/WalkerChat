import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import {
  fetchBootstrap,
  fetchHistory,
  fetchIceConfig,
  claimPrekeyBundle,
  createChat,
  fetchDevices,
  fetchPrekeyCount,
  fetchWsTicket,
  login,
  logout,
  publishKeys,
  searchUsers,
  uploadOneTimePreKeys,
} from './lib/api';
import { CryptoStore } from './lib/crypto/store';
import {
  DecryptionFailure,
  SessionManager,
  bootstrapIdentity,
  replenishOneTimePreKeys,
} from './lib/crypto/session';
import { GroupSessionManager, decodeDistribution } from './lib/crypto/groups';
import {
  buildReactionTallies,
  buildReplyRef,
  acknowledgeMessage,
  createOptimisticDisplayMessage,
  encodeMessagePayload,
  encodeReactionPayload,
  mergeMessages,
  mergeReactions,
  resolveEnvelope,
} from './lib/chat';
import { encryptAndUploadImage } from './lib/media';
import { clearSearchIndex, indexChatMessages } from './lib/search';
import { pushToast, clearToasts } from './lib/toast';
import { useWebSocket } from './hooks/useWebSocket';
import { useWebRTC, type OutboundSignal } from './hooks/useWebRTC';
import { SignIn, type DemoAccount } from './components/SignIn';
import { Sidebar, type ConversationSummary } from './components/Sidebar';
import { ChatHeader } from './components/ChatHeader';
import { MessageList, type HistoryState } from './components/MessageList';
import { Composer } from './components/Composer';
import { CallOverlay } from './components/CallOverlay';
import { CommandPalette } from './components/CommandPalette';
import { Lightbox, type LightboxImage } from './components/Lightbox';
import { SafetyNumberDialog } from './components/SafetyNumberDialog';
import { NewChatDialog } from './components/NewChatDialog';
import { useSafetyNumber } from './hooks/useSafetyNumber';
import { Toaster } from './components/ui/Toaster';
import { Logo } from './components/ui/Logo';
import type {
  BootstrapResponse,
  CallMediaKind,
  ChatMessageEvent,
  ChatMessageRecord,
  DisplayMessage,
  ImageAttachment,
  ReactionEvent,
  RealtimeEvent,
  SenderKeyEvent,
  ReplyRef,
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
  /** Reaction log for the open thread; folded into tallies below. */
  const [reactions, setReactions] = useState<ReactionEvent[]>([]);
  const [replyTo, setReplyTo] = useState<DisplayMessage | null>(null);
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
  const [sessionManager, setSessionManager] = useState<SessionManager | null>(null);
  const [groupManager, setGroupManager] = useState<GroupSessionManager | null>(null);
  /** This installation's ids: the local one, and the row the server addresses. */
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [deviceRowId, setDeviceRowId] = useState<string | null>(null);
  const [cryptoStore, setCryptoStore] = useState<CryptoStore | null>(null);
  const [signingInUsername, setSigningInUsername] = useState<string | null>(null);
  const [isUploadingPhoto, setIsUploadingPhoto] = useState(false);
  const [lightboxImage, setLightboxImage] = useState<LightboxImage | null>(null);
  const [iceServers, setIceServers] = useState<RTCIceServer[]>(DEFAULT_ICE_SERVERS);
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [isSafetyNumberOpen, setIsSafetyNumberOpen] = useState(false);
  const [isNewChatOpen, setIsNewChatOpen] = useState(false);
  /** Peers whose identity key changed during this session. */
  const [changedPeerIds, setChangedPeerIds] = useState<Set<string>>(new Set());

  const typingTimeoutRef = useRef<number | null>(null);
  // Set after useWebRTC initialises, so the socket handler below can reach it
  // without the two hooks depending on each other.
  const handleSignalRef = useRef<((signal: WebRtcSignalEvent) => void) | null>(null);
  // Same pattern for message decryption: the socket handler is defined above the
  // session state it needs.
  const decryptEnvelopeRef = useRef<
    ((record: ChatMessageEvent | ChatMessageRecord) => Promise<
      ReturnType<typeof resolveEnvelope> | null
    >) | null
  >(null);
  const acceptSenderKeyRef = useRef<((event: SenderKeyEvent) => Promise<void>) | null>(null);

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

  const safetyNumber = useSafetyNumber({
    store: cryptoStore,
    selfUserId: currentUser?.id ?? null,
    selfIdentityKey: sessionManager?.identityKey ?? null,
    peerUserId: peer?.user_id ?? null,
    changedPeerIds,
  });

  /** Replaying the reaction log in send order makes arrival order irrelevant. */
  const reactionsByMessageId = useMemo(() => buildReactionTallies(reactions), [reactions]);

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

      if (message.type === 'sender_key') {
        // Group key setup. It arrives over the pairwise session, so accepting it is
        // proof the sender holds that session, not merely that they claim to.
        void acceptSenderKeyRef.current?.(message);
        return;
      }

      if (message.type === 'chat_message') {
        if (message.chat_id === activeChat.id) {
          // Our own echo: the ratchet encrypts to the recipient's chain, so we cannot
          // decrypt it. It only confirms delivery and carries the server's id.
          if (message.sender_id === currentUser.id) {
            setMessages((previousMessages) =>
              acknowledgeMessage(
                previousMessages,
                message.client_message_id,
                message.message_id,
                message.sent_at ?? new Date().toISOString(),
              ),
            );
            return;
          }

          void decryptEnvelopeRef.current?.(message).then((resolved) => {
            if (!resolved) {
              return;
            }
            if (resolved.kind === 'reaction') {
              setReactions((previousReactions) =>
                mergeReactions(previousReactions, resolved.reaction),
              );
              return;
            }
            setMessages((previousMessages) =>
              mergeMessages(previousMessages, resolved.message),
            );
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
    setReactions([]);
    setReplyTo(null);
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
    // History is resolved per device, so wait until we know which one we are.
    if (!activeChatId || !authToken || !deviceId) {
      return;
    }

    let isActive = true;

    fetchHistory(apiUrl, activeChatId, authToken, deviceId)
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
  }, [activeChatId, authToken, deviceId]);

  /**
   * Decrypt one stored or live envelope.
   *
   * A message that does not authenticate becomes a visibly failed bubble. It is never
   * rendered as text: the previous implementation fell back to reading the payload as
   * plaintext, which let anyone able to write a message row inject messages that looked
   * end-to-end encrypted.
   */
  const decryptEnvelope = useCallback(
    async (
      record: ChatMessageEvent | ChatMessageRecord,
    ): Promise<ReturnType<typeof resolveEnvelope> | null> => {
      if (!sessionManager) {
        return null;
      }

      // A live event carries the whole envelope map and we pick ours out; a history
      // record has already been resolved to this device's single envelope.
      const ciphertext =
        'ciphertext' in record
          ? record.ciphertext
          : ((deviceRowId ? record.envelopes[deviceRowId] : undefined) ??
            record.envelopes['*']);

      // Our own messages are unreadable from the ciphertext by design, so they come
      // from the local sent log instead.
      if (currentUser && record.sender_id === currentUser.id) {
        const clientMessageId = record.client_message_id;
        const ownPlaintext = clientMessageId
          ? await cryptoStore?.loadOutgoingMessage(clientMessageId)
          : null;

        if (ownPlaintext == null) {
          // Sent from another device, or from a browser profile whose log we do not
          // have. Saying so is better than showing a decryption failure.
          return {
            kind: 'message',
            message: {
              id: record.message_id ?? clientMessageId,
              clientMessageId,
              serverMessageId: record.message_id,
              senderId: record.sender_id,
              body: '',
              sentAt: record.sent_at ?? new Date().toISOString(),
              state: 'failed',
            },
          };
        }

        return resolveEnvelope(record, ownPlaintext);
      }

      try {
        // Group messages ride a sender key chain; direct messages ride the pairwise
        // ratchet. Which one applies is a property of the chat, not the payload.
        // Group messages ride a sender key chain, keyed by sender account. Direct
        // messages ride the pairwise ratchet, keyed by sender *device*.
        let plaintext: string;
        if (activeChat?.kind === 'room' && groupManager) {
          plaintext = await groupManager.decrypt(
            activeChat.id,
            record.sender_id,
            ciphertext ?? '',
          );
        } else {
          if (!record.sender_device_row_id) {
            throw new DecryptionFailure('Message does not name a sender device.');
          }
          plaintext = await sessionManager.decrypt(
            { userId: record.sender_id, deviceRowId: record.sender_device_row_id },
            ciphertext ?? '',
          );
        }
        return resolveEnvelope(record, plaintext);
      } catch (error) {
        if (!(error instanceof DecryptionFailure)) {
          throw error;
        }

        const clientMessageId = record.client_message_id;
        return {
          kind: 'message',
          message: {
            id: record.message_id ?? clientMessageId,
            clientMessageId,
            serverMessageId: record.message_id,
            senderId: record.sender_id,
            body: '',
            sentAt: record.sent_at ?? new Date().toISOString(),
            state: 'failed',
          },
        };
      }
    },
    [activeChat, cryptoStore, currentUser, deviceRowId, groupManager, sessionManager],
  );

  /**
   * Unwrap a sender key distribution and store the sender's chain for that group.
   *
   * A distribution that does not decrypt is dropped in silence: it means we have no
   * pairwise session with the claimed sender, which is exactly what a forged one would
   * look like.
   */
  const acceptSenderKey = useCallback(
    async (event: SenderKeyEvent) => {
      if (!sessionManager || !groupManager) {
        return;
      }

      if (!event.sender_device_row_id) {
        return;
      }

      try {
        const plaintext = await sessionManager.decrypt(
          { userId: event.sender_id, deviceRowId: event.sender_device_row_id },
          event.ciphertext,
        );
        const distribution = decodeDistribution(plaintext);
        if (distribution && distribution.distributionId === event.chat_id) {
          await groupManager.acceptDistribution(distribution);
        }
      } catch {
        // Nothing to show the user: this is key setup, not conversation.
      }
    },
    [groupManager, sessionManager],
  );

  useEffect(() => {
    decryptEnvelopeRef.current = decryptEnvelope;
    acceptSenderKeyRef.current = acceptSenderKey;
  }, [acceptSenderKey, decryptEnvelope]);

  /**
   * Decrypt whatever history we hold. Re-runs once the session is ready, so messages
   * that first rendered as locked placeholders resolve in place.
   */
  useEffect(() => {
    if (!historyRecords.length || !sessionManager) {
      return;
    }

    let isActive = true;

    void Promise.all(historyRecords.map((record) => decryptEnvelope(record))).then((results) => {
      const resolved = results.filter((entry) => entry !== null);
      if (!isActive) return;

      // Fold through mergeMessages so live messages that arrived while we were
      // decrypting are preserved rather than overwritten.
      setMessages((previousMessages) =>
        resolved
          .filter((entry) => entry.kind === 'message')
          .map((entry) => entry.message)
          .reduce(mergeMessages, previousMessages),
      );

      setReactions((previousReactions) =>
        resolved
          .filter((entry) => entry.kind === 'reaction')
          .map((entry) => entry.reaction)
          .reduce(mergeReactions, previousReactions),
      );
    });

    return () => {
      isActive = false;
    };
  }, [decryptEnvelope, historyRecords, sessionManager]);

  /**
   * Feed decrypted plaintext into the local search index.
   *
   * The server only ever holds ciphertext, so this is the only place a search
   * over message text can happen at all.
   */
  useEffect(() => {
    if (!activeChatId || !messages.length) {
      return;
    }
    indexChatMessages(activeChatId, messages);
  }, [activeChatId, messages]);

  /**
   * Keep the published one-time prekey pool topped up.
   *
   * Each inbound handshake consumes one. If the pool empties, X3DH still works but
   * drops its DH4 term, so the first message of a new conversation loses some of its
   * forward secrecy until the ratchet turns.
   */
  useEffect(() => {
    if (!authToken || !cryptoStore || !deviceId) {
      return;
    }

    let isActive = true;

    void (async () => {
      try {
        const count = await fetchPrekeyCount(apiUrl, authToken, deviceId);
        if (!isActive || !count.should_replenish) {
          return;
        }
        const preKeys = await replenishOneTimePreKeys(cryptoStore);
        if (isActive) {
          await uploadOneTimePreKeys(apiUrl, authToken, deviceId, preKeys);
        }
      } catch (error) {
        // Not fatal: the handshake degrades rather than failing outright.
        console.warn('Unable to replenish one-time prekeys.', error);
      }
    })();

    return () => {
      isActive = false;
    };
  }, [authToken, cryptoStore, deviceId]);

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

  /** ⌘K / Ctrl+K (or `/`) opens search, Escape closes what is open. */
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const isEditing =
        target?.tagName === 'INPUT' ||
        target?.tagName === 'TEXTAREA' ||
        target?.isContentEditable;

      if (event.key.toLowerCase() === 'k' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        setIsSearchOpen((isOpen) => !isOpen);
        return;
      }

      if (event.key === '/' && !isEditing) {
        event.preventDefault();
        setIsSearchOpen(true);
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

      cryptoStore?.close();
      setSessionManager(null);
      setGroupManager(null);
      setCryptoStore(null);
      setWsTicket(null);

      const tokenData = await login(apiUrl, account.username, account.password);

      // The account password unlocks the local key vault. Private keys are sealed at
      // rest, so signing in is what makes them readable again.
      const store = await CryptoStore.unlock(account.password, {
        databaseName: `walkerchat-crypto-${account.username}`,
      });

      const bootstrapped = await bootstrapIdentity(store);
      setDeviceId(bootstrapped.deviceId);

      if (bootstrapped.publish) {
        const published = await publishKeys(
          apiUrl,
          tokenData.access_token,
          bootstrapped.publish,
        );
        setDeviceRowId(published.device_row_id);
      } else {
        // Already registered: ask the server which row this installation is.
        const devices = await fetchDevices(apiUrl, tokenData.user_id, tokenData.access_token);
        setDeviceRowId(
          devices.find((device) => device.device_id === bootstrapped.deviceId)
            ?.device_row_id ?? null,
        );
      }

      setCryptoStore(store);
      const sessions = new SessionManager({
        store,
        identity: bootstrapped.identity,
        fetchBundle: (peerId) => claimPrekeyBundle(apiUrl, peerId, tokenData.access_token),
        onIdentityChange: ({ peerId }) => {
          // The only defence against a server swapping keys is telling the user.
          setChangedPeerIds((previous) => new Set(previous).add(peerId));
          pushToast(
            'This contact’s safety number changed. Verify it before trusting this chat.',
          );
        },
      });

      setSessionManager(sessions);
      setGroupManager(
        new GroupSessionManager({ store, sessions, selfId: tokenData.user_id }),
      );

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
      // Locking drops the vault key from memory; the sealed data stays on disk so the
      // conversation survives the next sign-in.
      cryptoStore?.close();
      clearToasts();
      // Decrypted plaintext must not outlive the session it belongs to.
      clearSearchIndex();
      setAuthToken(null);
      setWsTicket(null);
      setSessionManager(null);
      setGroupManager(null);
      setCryptoStore(null);
      setDeviceId(null);
      setDeviceRowId(null);
      setChangedPeerIds(new Set());
      setIsSafetyNumberOpen(false);
      setIsNewChatOpen(false);
      setSelectedUserId(null);
      setActiveChatId(null);
      setBootstrap(null);
      setBootstrapState('signed_out');
      setMessages([]);
      setReactions([]);
      setReplyTo(null);
      setHistoryRecords([]);
      setHistoryState('idle');
      setDraft('');
      setTypingUserId(null);
      setIsSidebarOpen(false);
      setIsSearchOpen(false);
    }
  };

  /**
   * Encrypt a plaintext for the open thread.
   *
   * The session layer establishes the X3DH session on first use and ratchets from then
   * on, so callers no longer hold a key at all.
   */
  /**
   * Encrypt for a chat, producing one envelope per recipient device.
   *
   * The "*" key marks a group message: Sender Keys produce a single ciphertext for the
   * whole membership, whereas the pairwise ratchet needs one per installation.
   */
  const encryptForChat = async (
    plaintext: string,
  ): Promise<Record<string, string> | null> => {
    if (!sessionManager || !activeChat || !currentUser) {
      pushToast('The secure session is not ready yet.');
      return null;
    }

    try {
      if (activeChat.kind === 'room') {
        if (!groupManager) {
          pushToast('The secure session is not ready yet.');
          return null;
        }

        const memberIds = activeChat.members.map((member) => member.user_id);
        const { message, distributions } = await groupManager.encrypt(
          activeChat.id,
          memberIds,
          plaintext,
        );

        // Hand each member's *device* our sender key over its pairwise session. These
        // are relayed, never stored. A device that cannot read one simply ignores it.
        for (const distribution of distributions) {
          sendMessage({
            type: 'sender_key',
            chat_id: activeChat.id,
            sender_id: currentUser.id,
            sender_device_id: deviceId ?? undefined,
            target_id: distribution.userId,
            ciphertext: distribution.ciphertext,
            sent_at: new Date().toISOString(),
          });
        }

        return { '*': message };
      }

      if (!peer) {
        pushToast('The secure session is not ready yet.');
        return null;
      }

      const envelopes = await sessionManager.encryptForUser(peer.user_id, plaintext);

      // Our own other installations get a copy too, so the conversation is readable
      // everywhere we are signed in. Our own device is excluded: we cannot decrypt
      // what we encrypted to ourselves, and the local sent log covers it.
      const ownEnvelopes = await sessionManager.encryptForUser(currentUser.id, plaintext, {
        excludeDeviceRowId: deviceRowId ?? undefined,
      });

      const combined = { ...envelopes, ...ownEnvelopes };
      if (Object.keys(combined).length === 0) {
        pushToast('That contact has no devices able to receive messages yet.');
        return null;
      }
      return combined;
    } catch (error) {
      pushToast(
        error instanceof Error
          ? error.message
          : 'The secure session could not be established for this chat.',
      );
      return null;
    }
  };

  /** Encrypt, send, and optimistically render one message. */
  const sendEncryptedMessage = async (
    caption: string,
    attachment?: ImageAttachment,
    replyRef?: ReplyRef,
  ): Promise<boolean> => {
    if (!activeChat || !currentUser || !peer) {
      return false;
    }

    const plaintext = encodeMessagePayload(caption, attachment, replyRef);
    const envelopes = await encryptForChat(plaintext);
    if (!envelopes) {
      return false;
    }

    const clientMessageId = crypto.randomUUID();
    // Keep our own plaintext: it is the only way this message is readable to us again
    // after a reload, because we cannot decrypt what we encrypted to the peer.
    await cryptoStore?.saveOutgoingMessage(clientMessageId, activeChat.id, plaintext);

    const outboundMessage: ChatMessageEvent = {
      type: 'chat_message',
      chat_id: activeChat.id,
      client_message_id: clientMessageId,
      sender_id: currentUser.id,
      sender_device_id: deviceId ?? undefined,
      target_id: peer.user_id,
      envelopes,
      is_media: Boolean(attachment),
      sent_at: new Date().toISOString(),
    };

    setMessages((previousMessages) =>
      mergeMessages(
        previousMessages,
        createOptimisticDisplayMessage(caption, outboundMessage, attachment, replyRef),
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

    try {
      const replyRef = replyTo ? buildReplyRef(replyTo) : undefined;
      if (await sendEncryptedMessage(trimmedDraft, undefined, replyRef)) {
        setDraft('');
        setReplyTo(null);
      }
    } catch (error) {
      console.error('Secure send failed.', error);
      pushToast(error instanceof Error ? error.message : 'Secure send failed.');
    }
  };

  /**
   * Add or remove one reaction.
   *
   * It goes out as an ordinary encrypted message, so the server records that
   * something was sent but never learns which message was reacted to, nor with
   * what. The cost is one stored row per reaction and per undo.
   */
  const handleToggleReaction = async (message: DisplayMessage, emoji: string) => {
    if (!activeChat || !currentUser || !peer) {
      return;
    }

    const alreadyMine = (reactionsByMessageId.get(message.id) ?? []).some(
      (tally) => tally.emoji === emoji && tally.userIds.includes(currentUser.id),
    );
    const action = alreadyMine ? 'remove' : 'add';

    try {
      const envelopes = await encryptForChat(encodeReactionPayload(message.id, emoji, action));
      if (!envelopes) {
        return;
      }

      const clientMessageId = crypto.randomUUID();
      const sentAt = new Date().toISOString();

      const sent = sendMessage({
        type: 'chat_message',
        chat_id: activeChat.id,
        client_message_id: clientMessageId,
        sender_id: currentUser.id,
        sender_device_id: deviceId ?? undefined,
        target_id: peer.user_id,
        envelopes,
        is_media: false,
        sent_at: sentAt,
      } satisfies ChatMessageEvent);

      if (!sent) {
        pushToast('The socket is not connected yet. Reconnect and react again.');
        return;
      }

      // Render immediately; the echo carries the same client id, and
      // mergeReactions keeps the pair from double-counting.
      setReactions((previousReactions) =>
        mergeReactions(previousReactions, {
          id: clientMessageId,
          targetMessageId: message.id,
          senderId: currentUser.id,
          emoji,
          action,
          sentAt,
        }),
      );
    } catch (error) {
      console.error('Reaction send failed.', error);
      pushToast(error instanceof Error ? error.message : 'Unable to send that reaction.');
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

    if (!sessionManager) {
      pushToast('The secure session is not ready yet.');
      return;
    }

    setIsUploadingPhoto(true);

    try {
      // The image gets its own random content key; the descriptor carrying it is then
      // sent inside the ratcheted message below.
      const attachment = await encryptAndUploadImage(apiUrl, activeChat.id, authToken, file);

      if (await sendEncryptedMessage(draft.trim(), attachment)) {
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

  const onlineMemberCount = activeChat.members.filter(
    (member) => (presenceByUserId[member.user_id] ?? member.presence_state) === 'online',
  ).length;

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
          currentUser={currentUser}
          currentUserRole={
            demoAccounts.find((account) => account.username === currentUser.username)?.role
          }
          conversations={conversations}
          activeChatId={activeChatId}
          isSocketOpen={isSocketOpen}
          onSelectChat={(chatId) => {
            setActiveChatId(chatId);
            setIsSidebarOpen(false);
          }}
          onOpenSearch={() => setIsSearchOpen(true)}
          onNewChat={() => setIsNewChatOpen(true)}
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
          isSecure={Boolean(sessionManager)}
          verification={safetyNumber.state}
          onOpenSafetyNumber={() => setIsSafetyNumberOpen(true)}
          isPeerTyping={typingUserId === peer?.user_id}
          canCall={Boolean(peer) && !call.isCallActive && isSocketOpen}
          onlineCount={onlineMemberCount}
          onStartCall={(media) => void handleStartCall(media)}
          onOpenSidebar={() => setIsSidebarOpen(true)}
        />

        <MessageList
          messages={messages}
          currentUser={currentUser}
          peer={peer}
          isPeerTyping={typingUserId === peer?.user_id}
          historyState={historyState}
          reactionsByMessageId={reactionsByMessageId}
          apiUrl={apiUrl}
          authToken={authToken}
          onOpenImage={(url, name) => setLightboxImage({ url, name })}
          onReply={setReplyTo}
          onToggleReaction={(message, emoji) => void handleToggleReaction(message, emoji)}
        />

        <Composer
          draft={draft}
          onDraftChange={setDraft}
          onSend={() => void handleSend()}
          onSendPhoto={(file) => void handleSendPhoto(file)}
          isSecure={Boolean(sessionManager)}
          isUploading={isUploadingPhoto}
          isSocketOpen={isSocketOpen}
          peerName={peer?.display_name ?? activeChat.name}
          replyTo={replyTo}
          replyAuthorName={
            replyTo?.senderId === currentUser.id
              ? currentUser.display_name
              : (peer?.display_name ?? 'this thread')
          }
          onCancelReply={() => setReplyTo(null)}
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

      <CommandPalette
        isOpen={isSearchOpen}
        chats={bootstrap.chats}
        users={bootstrap.users}
        currentUser={currentUser}
        onClose={() => setIsSearchOpen(false)}
        onSelectChat={(chatId) => {
          setActiveChatId(chatId);
          setIsSidebarOpen(false);
        }}
      />

      <Lightbox image={lightboxImage} onClose={() => setLightboxImage(null)} />
      <NewChatDialog
        open={isNewChatOpen}
        onClose={() => setIsNewChatOpen(false)}
        onSearch={async (query) => (authToken ? searchUsers(apiUrl, authToken, query) : [])}
        onCreate={async ({ type, name, memberIds }) => {
          if (!authToken) return;
          try {
            const created = await createChat(apiUrl, authToken, {
              type,
              name,
              member_ids: memberIds,
            });
            // Re-fetch rather than patching state: the server decides the final
            // membership, and a direct chat may resolve to an existing thread.
            setBootstrap(await fetchBootstrap(apiUrl, authToken));
            setActiveChatId(created.chat_id);
            setIsNewChatOpen(false);
          } catch (error) {
            pushToast(error instanceof Error ? error.message : 'Unable to create that chat.');
          }
        }}
      />
      <SafetyNumberDialog
        open={isSafetyNumberOpen}
        peerName={peer?.display_name ?? 'this contact'}
        safetyNumber={safetyNumber}
        onClose={() => setIsSafetyNumberOpen(false)}
      />
      <Toaster />
    </div>
  );
};

export default App;
