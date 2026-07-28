import { useEffect, useRef } from 'react';
import type { CallStatus, IncomingCall } from '../hooks/useWebRTC';
import type { CallMediaKind } from '../types/chat';

interface CallPanelProps {
  status: CallStatus;
  mediaKind: CallMediaKind;
  peerName: string;
  localStream: MediaStream | null;
  remoteStream: MediaStream | null;
  incomingCall: IncomingCall | null;
  isMuted: boolean;
  isCameraOff: boolean;
  onAccept: () => void;
  onReject: () => void;
  onHangUp: () => void;
  onToggleMute: () => void;
  onToggleCamera: () => void;
}

const statusLabel: Record<CallStatus, string> = {
  idle: '',
  dialing: 'Ringing…',
  ringing: 'Incoming call',
  connecting: 'Connecting…',
  active: 'Connected',
  ended: 'Call ended',
  error: 'Call failed',
};

/** Attaches a MediaStream to a video element without re-rendering on change. */
const useStreamRef = (stream: MediaStream | null) => {
  const ref = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const element = ref.current;
    if (!element) {
      return;
    }

    element.srcObject = stream;

    return () => {
      element.srcObject = null;
    };
  }, [stream]);

  return ref;
};

export const CallPanel = ({
  status,
  mediaKind,
  peerName,
  localStream,
  remoteStream,
  incomingCall,
  isMuted,
  isCameraOff,
  onAccept,
  onReject,
  onHangUp,
  onToggleMute,
  onToggleCamera,
}: CallPanelProps) => {
  const localVideoRef = useStreamRef(localStream);
  const remoteVideoRef = useStreamRef(remoteStream);

  if (status === 'idle' || status === 'ended') {
    return null;
  }

  const isRinging = status === 'ringing' && incomingCall !== null;
  const showVideo = mediaKind === 'video';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 px-4 backdrop-blur-sm">
      <div className="w-full max-w-4xl overflow-hidden rounded-3xl border border-[#f3c58855] bg-[#130f0b] shadow-[0_25px_90px_-30px_rgba(242,173,91,0.5)]">
        <header className="flex items-center justify-between border-b border-[#f3c58833] bg-[#2a1f1496] px-6 py-4">
          <div>
            <p className="text-[10px] font-bold uppercase tracking-[0.25em] text-[#ffc274]">
              {showVideo ? 'Video call' : 'Voice call'}
            </p>
            <h2 className="font-display mt-1 text-2xl font-extrabold tracking-tight text-[#fff2de]">
              {peerName}
            </h2>
          </div>
          <div className="flex items-center gap-2 rounded-full border border-[#f3c58844] bg-[#170f09bd] px-4 py-2 text-[11px] font-bold uppercase tracking-widest text-[#e1c5a0]">
            <span
              className={`h-2 w-2 rounded-full ${
                status === 'active'
                  ? 'bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.8)]'
                  : status === 'error'
                    ? 'bg-red-400'
                    : 'animate-pulse bg-amber-400'
              }`}
            />
            {statusLabel[status]}
          </div>
        </header>

        <div className="relative bg-black">
          {showVideo ? (
            <>
              <video
                ref={remoteVideoRef}
                autoPlay
                playsInline
                className="aspect-video w-full bg-[#0b0907] object-cover"
              />
              {!remoteStream ? (
                <div className="absolute inset-0 flex items-center justify-center">
                  <div className="flex flex-col items-center gap-3 text-[#d6b893]">
                    <div className="flex h-20 w-20 items-center justify-center rounded-full border border-[#f3c58844] bg-[#22180f] text-2xl font-bold text-[#f8cf91]">
                      {peerName.slice(0, 1).toUpperCase()}
                    </div>
                    <span className="text-sm uppercase tracking-widest">
                      {statusLabel[status]}
                    </span>
                  </div>
                </div>
              ) : null}

              {localStream ? (
                <video
                  ref={localVideoRef}
                  autoPlay
                  playsInline
                  muted
                  className="absolute bottom-4 right-4 h-32 w-48 rounded-2xl border border-[#f3c58855] object-cover shadow-lg"
                />
              ) : null}
            </>
          ) : (
            <div className="flex h-64 flex-col items-center justify-center gap-4 bg-[#0b0907]">
              <div className="flex h-24 w-24 items-center justify-center rounded-full border border-[#f3c58844] bg-[#22180f] text-3xl font-bold text-[#f8cf91]">
                {peerName.slice(0, 1).toUpperCase()}
              </div>
              <span className="text-sm uppercase tracking-widest text-[#d6b893]">
                {statusLabel[status]}
              </span>
              {/* Audio-only still needs an element to play the remote track. */}
              <video ref={remoteVideoRef} autoPlay playsInline className="hidden" />
            </div>
          )}
        </div>

        <footer className="flex flex-wrap items-center justify-center gap-3 border-t border-[#f3c58833] bg-[#1a130dc4] px-6 py-5">
          {isRinging ? (
            <>
              <button
                type="button"
                onClick={onAccept}
                className="rounded-full bg-gradient-to-r from-emerald-400 to-emerald-600 px-8 py-3 text-sm font-bold text-[#06251a] shadow-lg transition-all hover:scale-105 active:scale-95"
              >
                Accept
              </button>
              <button
                type="button"
                onClick={onReject}
                className="rounded-full bg-gradient-to-r from-red-400 to-red-600 px-8 py-3 text-sm font-bold text-[#2b0908] shadow-lg transition-all hover:scale-105 active:scale-95"
              >
                Decline
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={onToggleMute}
                aria-pressed={isMuted}
                className={`rounded-full border px-6 py-3 text-xs font-bold uppercase tracking-widest transition-all hover:scale-105 active:scale-95 ${
                  isMuted
                    ? 'border-red-400/50 bg-red-500/20 text-red-200'
                    : 'border-[#f3c58844] bg-[#291d13b3] text-[#e6c89f]'
                }`}
              >
                {isMuted ? 'Unmute' : 'Mute'}
              </button>

              {showVideo ? (
                <button
                  type="button"
                  onClick={onToggleCamera}
                  aria-pressed={isCameraOff}
                  className={`rounded-full border px-6 py-3 text-xs font-bold uppercase tracking-widest transition-all hover:scale-105 active:scale-95 ${
                    isCameraOff
                      ? 'border-red-400/50 bg-red-500/20 text-red-200'
                      : 'border-[#f3c58844] bg-[#291d13b3] text-[#e6c89f]'
                  }`}
                >
                  {isCameraOff ? 'Camera on' : 'Camera off'}
                </button>
              ) : null}

              <button
                type="button"
                onClick={onHangUp}
                className="rounded-full bg-gradient-to-r from-red-400 to-red-600 px-8 py-3 text-sm font-bold text-[#2b0908] shadow-lg transition-all hover:scale-105 active:scale-95"
              >
                {status === 'error' ? 'Close' : 'Hang up'}
              </button>
            </>
          )}
        </footer>
      </div>
    </div>
  );
};
