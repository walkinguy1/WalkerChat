import { useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import {
  Mic,
  MicOff,
  Phone,
  PhoneOff,
  Video as VideoIcon,
  VideoOff,
} from 'lucide-react';
import { Avatar } from './ui/Avatar';
import { formatDuration } from '../lib/format';
import type { CallStatus, IncomingCall } from '../hooks/useWebRTC';
import type { CallMediaKind } from '../types/chat';

interface CallOverlayProps {
  status: CallStatus;
  mediaKind: CallMediaKind;
  peerName: string;
  peerInitials?: string;
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

/**
 * Counts up from the moment the call reaches 'active'.
 *
 * Derives from a start timestamp rather than incrementing, so a throttled
 * background tab does not make the call look shorter than it was.
 */
const useCallTimer = (isActive: boolean) => {
  const [seconds, setSeconds] = useState(0);

  useEffect(() => {
    if (!isActive) {
      return;
    }

    const startedAt = Date.now();
    const interval = window.setInterval(
      () => setSeconds(Math.floor((Date.now() - startedAt) / 1000)),
      500,
    );
    return () => window.clearInterval(interval);
  }, [isActive]);

  // Reading through isActive avoids having to reset the state on teardown.
  return isActive ? seconds : 0;
};

interface ControlProps {
  label: string;
  onClick: () => void;
  active?: boolean;
  tone?: 'neutral' | 'danger' | 'accept';
  children: React.ReactNode;
}

const CallControl = ({
  label,
  onClick,
  active = false,
  tone = 'neutral',
  children,
}: ControlProps) => (
  <button
    type="button"
    onClick={onClick}
    title={label}
    aria-label={label}
    aria-pressed={tone === 'neutral' ? active : undefined}
    className={clsx(
      'flex h-[3.25rem] w-[3.25rem] items-center justify-center rounded-full transition-all duration-150 active:scale-95',
      tone === 'danger' && 'bg-danger text-white hover:brightness-110',
      tone === 'accept' && 'bg-signal text-white hover:brightness-110',
      tone === 'neutral' &&
        (active
          ? 'bg-white text-black hover:bg-white/90'
          : 'bg-white/15 text-white hover:bg-white/25'),
    )}
  >
    {children}
  </button>
);

export const CallOverlay = ({
  status,
  mediaKind,
  peerName,
  peerInitials,
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
}: CallOverlayProps) => {
  const localVideoRef = useStreamRef(localStream);
  const remoteVideoRef = useStreamRef(remoteStream);
  const elapsedSeconds = useCallTimer(status === 'active');

  if (status === 'idle' || status === 'ended') {
    return null;
  }

  const isRinging = status === 'ringing' && incomingCall !== null;
  const showVideo = mediaKind === 'video';
  const hasRemoteVideo = showVideo && Boolean(remoteStream);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`${showVideo ? 'Video' : 'Voice'} call with ${peerName}`}
      className="fixed inset-0 z-50 flex animate-fade items-center justify-center bg-black/75 p-0 backdrop-blur-md sm:p-6"
    >
      <div className="relative flex h-full w-full flex-col overflow-hidden bg-[#0b0c10] shadow-pop sm:h-auto sm:max-h-[min(90vh,44rem)] sm:max-w-3xl sm:rounded-panel">
        {/* Stage */}
        <div className="relative min-h-0 flex-1 sm:aspect-video sm:flex-none">
          <video
            ref={remoteVideoRef}
            autoPlay
            playsInline
            className={clsx(
              'h-full w-full bg-[#0b0c10] object-cover',
              !hasRemoteVideo && 'invisible absolute',
            )}
          />

          {!hasRemoteVideo ? (
            <div className="flex h-full min-h-[22rem] w-full flex-col items-center justify-center gap-5 bg-[radial-gradient(ellipse_at_top,#1c1f2b_0%,#0b0c10_70%)]">
              <span className="relative flex">
                {status !== 'active' ? (
                  <span
                    aria-hidden="true"
                    className="absolute inset-0 animate-ping rounded-full bg-white/10"
                  />
                ) : null}
                <Avatar name={peerName} initials={peerInitials} size="xl" />
              </span>
              <div className="text-center">
                <p className="text-lg font-semibold text-white">{peerName}</p>
                <p className="mt-1 text-[13px] text-white/55">
                  {status === 'active' ? formatDuration(elapsedSeconds) : statusLabel[status]}
                </p>
              </div>
            </div>
          ) : null}

          {/* Status chip only when the remote video is filling the stage. */}
          {hasRemoteVideo ? (
            <div className="absolute top-4 left-4 flex items-center gap-2 rounded-full bg-black/55 px-3 py-1.5 text-[12px] font-medium text-white backdrop-blur-sm">
              <span
                className={clsx(
                  'h-2 w-2 rounded-full',
                  status === 'active' ? 'bg-signal' : 'animate-pulse bg-warn',
                )}
              />
              {status === 'active' ? formatDuration(elapsedSeconds) : statusLabel[status]}
            </div>
          ) : null}

          {/* Self-view */}
          {showVideo && localStream ? (
            <div className="absolute right-4 bottom-4 overflow-hidden rounded-xl border border-white/15 shadow-lg">
              <video
                ref={localVideoRef}
                autoPlay
                playsInline
                muted
                className={clsx(
                  'h-28 w-[7.5rem] bg-black object-cover sm:h-32 sm:w-44',
                  isCameraOff && 'opacity-0',
                )}
              />
              {isCameraOff ? (
                <span className="absolute inset-0 flex items-center justify-center bg-[#15171f]">
                  <VideoOff className="h-5 w-5 text-white/50" aria-hidden="true" />
                </span>
              ) : null}
            </div>
          ) : null}
        </div>

        {/* Controls */}
        <div className="flex flex-shrink-0 items-center justify-center gap-3 border-t border-white/10 bg-[#0f1117] px-6 py-5 pb-[max(1.25rem,env(safe-area-inset-bottom))]">
          {isRinging ? (
            <>
              <CallControl label="Decline call" tone="danger" onClick={onReject}>
                <PhoneOff className="h-5 w-5" aria-hidden="true" />
              </CallControl>
              <CallControl label="Accept call" tone="accept" onClick={onAccept}>
                <Phone className="h-5 w-5" aria-hidden="true" />
              </CallControl>
            </>
          ) : (
            <>
              <CallControl
                label={isMuted ? 'Unmute microphone' : 'Mute microphone'}
                active={isMuted}
                onClick={onToggleMute}
              >
                {isMuted ? (
                  <MicOff className="h-5 w-5" aria-hidden="true" />
                ) : (
                  <Mic className="h-5 w-5" aria-hidden="true" />
                )}
              </CallControl>

              {showVideo ? (
                <CallControl
                  label={isCameraOff ? 'Turn camera on' : 'Turn camera off'}
                  active={isCameraOff}
                  onClick={onToggleCamera}
                >
                  {isCameraOff ? (
                    <VideoOff className="h-5 w-5" aria-hidden="true" />
                  ) : (
                    <VideoIcon className="h-5 w-5" aria-hidden="true" />
                  )}
                </CallControl>
              ) : null}

              <CallControl
                label={status === 'error' ? 'Close' : 'Hang up'}
                tone="danger"
                onClick={onHangUp}
              >
                <PhoneOff className="h-5 w-5" aria-hidden="true" />
              </CallControl>
            </>
          )}
        </div>
      </div>
    </div>
  );
};
