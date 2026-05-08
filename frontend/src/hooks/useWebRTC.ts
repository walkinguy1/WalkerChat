import { useCallback, useEffect, useRef, useState } from 'react';
import Peer from 'simple-peer';

export type WebRTCState = 'idle' | 'connecting' | 'connected' | 'disconnected' | 'error';

export type UseWebRTCOpts = {
  onStream?: (stream: MediaStream) => void;
  onRemoteStream?: (stream: MediaStream) => void;
  onError?: (error: Error) => void;
  onSignal?: (signal: Peer.SignalData) => void;
  onClose?: () => void;
};

export const useWebRTC = (opts: UseWebRTCOpts = {}) => {
  const [state, setState] = useState<WebRTCState>('idle');
  const [isInitiator, setIsInitiator] = useState(false);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const peerRef = useRef<Peer.Instance | null>(null);

  const createPeer = (initiator: boolean, signal?: Peer.SignalData) => {
    try {
      const peer = new Peer({
        initiator,
        trickle: false,
        stream: localStream || undefined,
      });

      peer.on('signal', (signalData) => {
        opts.onSignal?.(signalData);
      });

      peer.on('connect', () => {
        setState('connected');
      });

      peer.on('stream', (stream) => {
        setRemoteStream(stream);
        opts.onRemoteStream?.(stream);
      });

      peer.on('close', () => {
        setState('disconnected');
        opts.onClose?.();
      });

      peer.on('error', (error) => {
        setState('error');
        opts.onError?.(error);
      });

      if (signal) {
        peer.signal(signal);
      }

      peerRef.current = peer;
      setIsInitiator(initiator);
      setState('connecting');

      return peer;
    } catch (error) {
      setState('error');
      opts.onError?.(error as Error);
      return null;
    }
  };

  const startCall = async () => {
    try {
      // Get user media
      const stream = await navigator.mediaDevices.getUserMedia({
        video: true,
        audio: true,
      });
      
      setLocalStream(stream);
      opts.onStream?.(stream);

      // Create initiator peer
      createPeer(true);
    } catch (error) {
      setState('error');
      opts.onError?.(error as Error);
    }
  };

  const answerCall = async (signal: Peer.SignalData) => {
    try {
      // Get user media
      const stream = await navigator.mediaDevices.getUserMedia({
        video: true,
        audio: true,
      });
      
      setLocalStream(stream);
      opts.onStream?.(stream);

      // Create responder peer with received signal
      createPeer(false, signal);
    } catch (error) {
      setState('error');
      opts.onError?.(error as Error);
    }
  };

  const sendSignal = (signal: Peer.SignalData) => {
    if (peerRef.current && peerRef.current.readable) {
      peerRef.current.signal(signal);
    }
  };

  const hangup = useCallback(() => {
    if (peerRef.current) {
      peerRef.current.destroy();
      peerRef.current = null;
    }

    if (localStream) {
      localStream.getTracks().forEach(track => track.stop());
      setLocalStream(null);
    }

    if (remoteStream) {
      remoteStream.getTracks().forEach(track => track.stop());
      setRemoteStream(null);
    }

    setState('idle');
  }, [localStream, remoteStream]);

  const toggleVideo = () => {
    if (localStream) {
      const videoTrack = localStream.getVideoTracks()[0];
      if (videoTrack) {
        videoTrack.enabled = !videoTrack.enabled;
      }
    }
  };

  const toggleAudio = () => {
    if (localStream) {
      const audioTrack = localStream.getAudioTracks()[0];
      if (audioTrack) {
        audioTrack.enabled = !audioTrack.enabled;
      }
    }
  };

  useEffect(() => {
    return () => {
      hangup();
    };
  }, [hangup]);

  return {
    state,
    isInitiator,
    localStream,
    remoteStream,
    startCall,
    answerCall,
    sendSignal,
    hangup,
    toggleVideo,
    toggleAudio,
  };
};
