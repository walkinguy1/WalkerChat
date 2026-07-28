import { useCallback, useEffect, useRef, useState } from 'react';
import type { CallMediaKind, WebRtcSignalType } from '../types/chat';

/**
 * One-to-one calling over native RTCPeerConnection.
 *
 * Signaling is delegated to the caller via `sendSignal` — this hook never
 * touches the network itself. Media stays peer-to-peer and never reaches the
 * backend; only SDP and ICE candidates are relayed.
 *
 * This replaces an earlier simple-peer implementation. simple-peer expects a
 * Node `global` that Vite does not define, and the previous hook also tore down
 * the connection on every stream change because its unmount cleanup depended on
 * the stream state.
 */

export type CallStatus =
  | 'idle'
  | 'dialing'
  | 'ringing'
  | 'connecting'
  | 'active'
  | 'ended'
  | 'error';

export type OutboundSignal = {
  type: WebRtcSignalType;
  call_id: string;
  media: CallMediaKind;
  payload: Record<string, unknown>;
};

export type IncomingCall = {
  callId: string;
  media: CallMediaKind;
  offer: RTCSessionDescriptionInit;
  fromUserId: string;
};

type UseWebRTCOptions = {
  sendSignal: (signal: OutboundSignal) => boolean;
  iceServers: RTCIceServer[];
  onError?: (message: string) => void;
};

const mediaConstraints = (media: CallMediaKind): MediaStreamConstraints => ({
  audio: true,
  video: media === 'video' ? { width: { ideal: 1280 }, height: { ideal: 720 } } : false,
});

const describeMediaError = (error: unknown): string => {
  if (error instanceof DOMException) {
    if (error.name === 'NotAllowedError') {
      return 'Camera and microphone access was denied. Allow it in the browser to take calls.';
    }
    if (error.name === 'NotFoundError') {
      return 'No camera or microphone was found on this device.';
    }
    if (error.name === 'NotReadableError') {
      return 'Your camera or microphone is already in use by another application.';
    }
  }
  return error instanceof Error ? error.message : 'Unable to access camera or microphone.';
};

export const useWebRTC = ({ sendSignal, iceServers, onError }: UseWebRTCOptions) => {
  const [status, setStatus] = useState<CallStatus>('idle');
  const [mediaKind, setMediaKind] = useState<CallMediaKind>('video');
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [incomingCall, setIncomingCall] = useState<IncomingCall | null>(null);
  const [isMuted, setIsMuted] = useState(false);
  const [isCameraOff, setIsCameraOff] = useState(false);

  const peerRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const callIdRef = useRef<string | null>(null);
  // Candidates can arrive before the remote description is applied; applying
  // one early throws, so they are queued until the description lands.
  const pendingCandidatesRef = useRef<RTCIceCandidateInit[]>([]);

  // Keeping these in refs means the teardown callback never goes stale and the
  // unmount effect does not re-run whenever a stream changes.
  const sendSignalRef = useRef(sendSignal);
  const iceServersRef = useRef(iceServers);
  const onErrorRef = useRef(onError);

  useEffect(() => {
    sendSignalRef.current = sendSignal;
    iceServersRef.current = iceServers;
    onErrorRef.current = onError;
  }, [iceServers, onError, sendSignal]);

  const stopLocalMedia = useCallback(() => {
    localStreamRef.current?.getTracks().forEach((track) => track.stop());
    localStreamRef.current = null;
    setLocalStream(null);
  }, []);

  const teardown = useCallback(
    (nextStatus: CallStatus) => {
      if (peerRef.current) {
        peerRef.current.onicecandidate = null;
        peerRef.current.ontrack = null;
        peerRef.current.onconnectionstatechange = null;
        peerRef.current.close();
        peerRef.current = null;
      }

      stopLocalMedia();
      setRemoteStream(null);
      setIncomingCall(null);
      setIsMuted(false);
      setIsCameraOff(false);
      callIdRef.current = null;
      pendingCandidatesRef.current = [];
      setStatus(nextStatus);
    },
    [stopLocalMedia],
  );

  const fail = useCallback(
    (message: string) => {
      onErrorRef.current?.(message);
      teardown('error');
    },
    [teardown],
  );

  const createPeerConnection = useCallback(
    (callId: string, media: CallMediaKind, stream: MediaStream) => {
      const peer = new RTCPeerConnection({ iceServers: iceServersRef.current });

      stream.getTracks().forEach((track) => peer.addTrack(track, stream));

      peer.onicecandidate = (event) => {
        if (!event.candidate) {
          return;
        }
        sendSignalRef.current({
          type: 'webrtc_ice',
          call_id: callId,
          media,
          payload: { candidate: event.candidate.toJSON() },
        });
      };

      peer.ontrack = (event) => {
        const [stream] = event.streams;
        if (stream) {
          setRemoteStream(stream);
        }
      };

      peer.onconnectionstatechange = () => {
        switch (peer.connectionState) {
          case 'connected':
            setStatus('active');
            break;
          case 'failed':
            fail('The call connection failed. A TURN server may be required on this network.');
            break;
          case 'disconnected':
          case 'closed':
            // `disconnected` can recover on its own, so only a hard close ends
            // the call here.
            if (peer.connectionState === 'closed') {
              teardown('ended');
            }
            break;
          default:
            break;
        }
      };

      peerRef.current = peer;
      return peer;
    },
    [fail, teardown],
  );

  const drainPendingCandidates = useCallback(async (peer: RTCPeerConnection) => {
    const queued = pendingCandidatesRef.current;
    pendingCandidatesRef.current = [];

    for (const candidate of queued) {
      try {
        await peer.addIceCandidate(candidate);
      } catch (error) {
        console.warn('Discarding an ICE candidate that could not be applied.', error);
      }
    }
  }, []);

  /** Place a call. Returns the generated call id, or null when setup failed. */
  const startCall = useCallback(
    async (media: CallMediaKind) => {
      if (peerRef.current) {
        return null;
      }

      const callId = crypto.randomUUID();
      callIdRef.current = callId;
      setMediaKind(media);
      setStatus('dialing');

      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia(mediaConstraints(media));
      } catch (error) {
        fail(describeMediaError(error));
        return null;
      }

      localStreamRef.current = stream;
      setLocalStream(stream);

      try {
        const peer = createPeerConnection(callId, media, stream);
        const offer = await peer.createOffer();
        await peer.setLocalDescription(offer);

        const delivered = sendSignalRef.current({
          type: 'webrtc_offer',
          call_id: callId,
          media,
          payload: { sdp: peer.localDescription?.sdp, type: peer.localDescription?.type },
        });

        if (!delivered) {
          fail('The secure socket is not connected, so the call could not be placed.');
          return null;
        }

        return callId;
      } catch (error) {
        fail(error instanceof Error ? error.message : 'Unable to start the call.');
        return null;
      }
    },
    [createPeerConnection, fail],
  );

  /** Accept the pending inbound call. */
  const acceptCall = useCallback(async () => {
    const pending = incomingCall;
    if (!pending || peerRef.current) {
      return;
    }

    callIdRef.current = pending.callId;
    setMediaKind(pending.media);
    setStatus('connecting');

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia(mediaConstraints(pending.media));
    } catch (error) {
      sendSignalRef.current({
        type: 'webrtc_reject',
        call_id: pending.callId,
        media: pending.media,
        payload: {},
      });
      fail(describeMediaError(error));
      return;
    }

    localStreamRef.current = stream;
    setLocalStream(stream);
    setIncomingCall(null);

    try {
      const peer = createPeerConnection(pending.callId, pending.media, stream);
      await peer.setRemoteDescription(pending.offer);
      await drainPendingCandidates(peer);

      const answer = await peer.createAnswer();
      await peer.setLocalDescription(answer);

      sendSignalRef.current({
        type: 'webrtc_answer',
        call_id: pending.callId,
        media: pending.media,
        payload: { sdp: peer.localDescription?.sdp, type: peer.localDescription?.type },
      });
    } catch (error) {
      fail(error instanceof Error ? error.message : 'Unable to answer the call.');
    }
  }, [createPeerConnection, drainPendingCandidates, fail, incomingCall]);

  /** Decline the pending inbound call. */
  const rejectCall = useCallback(() => {
    const pending = incomingCall;
    if (!pending) {
      return;
    }

    sendSignalRef.current({
      type: 'webrtc_reject',
      call_id: pending.callId,
      media: pending.media,
      payload: {},
    });

    teardown('idle');
  }, [incomingCall, teardown]);

  /** End an in-progress call and tell the peer. */
  const hangUp = useCallback(() => {
    const callId = callIdRef.current;

    if (callId) {
      sendSignalRef.current({
        type: 'webrtc_hangup',
        call_id: callId,
        media: mediaKind,
        payload: {},
      });
    }

    teardown('idle');
  }, [mediaKind, teardown]);

  const toggleMute = useCallback(() => {
    const tracks = localStreamRef.current?.getAudioTracks() ?? [];
    if (!tracks.length) {
      return;
    }

    const nextMuted = tracks[0].enabled;
    tracks.forEach((track) => {
      track.enabled = !nextMuted;
    });
    setIsMuted(nextMuted);
  }, []);

  const toggleCamera = useCallback(() => {
    const tracks = localStreamRef.current?.getVideoTracks() ?? [];
    if (!tracks.length) {
      return;
    }

    const nextOff = tracks[0].enabled;
    tracks.forEach((track) => {
      track.enabled = !nextOff;
    });
    setIsCameraOff(nextOff);
  }, []);

  /**
   * Feed an inbound signal from the chat socket into the call state machine.
   */
  const handleSignal = useCallback(
    async (signal: {
      type: WebRtcSignalType;
      call_id: string;
      sender_id: string;
      media: CallMediaKind;
      payload: Record<string, unknown>;
    }) => {
      const peer = peerRef.current;

      switch (signal.type) {
        case 'webrtc_offer': {
          // Already busy: turn down the new caller rather than clobbering the
          // live call.
          if (peer || incomingCall) {
            sendSignalRef.current({
              type: 'webrtc_reject',
              call_id: signal.call_id,
              media: signal.media,
              payload: { reason: 'busy' },
            });
            return;
          }

          pendingCandidatesRef.current = [];
          setIncomingCall({
            callId: signal.call_id,
            media: signal.media,
            offer: {
              type: 'offer',
              sdp: String(signal.payload.sdp ?? ''),
            },
            fromUserId: signal.sender_id,
          });
          setStatus('ringing');
          return;
        }

        case 'webrtc_answer': {
          if (!peer || signal.call_id !== callIdRef.current) {
            return;
          }

          try {
            await peer.setRemoteDescription({
              type: 'answer',
              sdp: String(signal.payload.sdp ?? ''),
            });
            await drainPendingCandidates(peer);
            setStatus('connecting');
          } catch (error) {
            fail(error instanceof Error ? error.message : 'The call answer was rejected.');
          }
          return;
        }

        case 'webrtc_ice': {
          const candidate = signal.payload.candidate as RTCIceCandidateInit | undefined;
          if (!candidate) {
            return;
          }

          // Queue until there is a peer with a remote description to attach to.
          if (!peer || !peer.remoteDescription) {
            pendingCandidatesRef.current.push(candidate);
            return;
          }

          try {
            await peer.addIceCandidate(candidate);
          } catch (error) {
            console.warn('Ignoring an ICE candidate that could not be applied.', error);
          }
          return;
        }

        case 'webrtc_reject': {
          if (signal.call_id !== callIdRef.current) {
            return;
          }
          onErrorRef.current?.('The call was declined.');
          teardown('idle');
          return;
        }

        case 'webrtc_hangup': {
          if (
            signal.call_id !== callIdRef.current &&
            signal.call_id !== incomingCall?.callId
          ) {
            return;
          }
          teardown('ended');
          return;
        }

        default:
          return;
      }
    },
    [drainPendingCandidates, fail, incomingCall, teardown],
  );

  // Release camera and microphone if the component unmounts mid-call. Depends
  // only on stable refs, so it runs exactly once on unmount.
  useEffect(
    () => () => {
      peerRef.current?.close();
      peerRef.current = null;
      localStreamRef.current?.getTracks().forEach((track) => track.stop());
      localStreamRef.current = null;
    },
    [],
  );

  return {
    status,
    mediaKind,
    localStream,
    remoteStream,
    incomingCall,
    isMuted,
    isCameraOff,
    isCallActive: status !== 'idle' && status !== 'ended' && status !== 'error',
    startCall,
    acceptCall,
    rejectCall,
    hangUp,
    toggleMute,
    toggleCamera,
    handleSignal,
  };
};
