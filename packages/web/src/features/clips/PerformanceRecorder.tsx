import type { Clip, Shot } from '@rideo/shared';
import { Circle, RotateCcw, Square, Video } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Dialog } from '../../components/ui';
import { rememberUpload } from '../../engine/media-files';
import { prepareMedia } from '../../engine/prepare';
import { api } from '../../lib/api';
import { useProject } from '../../store/project';
import { reportError } from '../../store/ui';

type Phase =
  | 'asking'
  | 'ready'
  | 'countdown'
  | 'recording'
  | 'recorded'
  | 'uploading'
  | 'denied'
  | 'unsupported';

/** What the browser records, best first. */
const TYPES = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4'];

/**
 * Record a performance (docs/design/performance.md#recording-in-the-studio): the camera and microphone, a 3-2-1
 * countdown, recording up to the shot's length, then the recording becomes the shot's performance.
 */
export function PerformanceRecorder({
  open,
  onClose,
  clip,
  shot,
}: {
  open: boolean;
  onClose: () => void;
  clip: Clip;
  shot: Shot;
}) {
  const projectId = useProject((s) => s.projectId);
  const [phase, setPhase] = useState<Phase>('asking');
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [count, setCount] = useState(3);
  const [elapsed, setElapsed] = useState(0);
  const [take, setTake] = useState<{ blob: Blob; url: string; seconds: number } | null>(null);
  const live = useRef<HTMLVideoElement>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const limit = shot.durationSec;

  // The camera and microphone while the dialog is open, released when it closes
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    let s: MediaStream | null = null;
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      setPhase('unsupported');
      return;
    }
    setPhase('asking');
    navigator.mediaDevices
      .getUserMedia({
        video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: true,
      })
      .then((m) => {
        if (cancelled) {
          for (const t of m.getTracks()) t.stop();
          return;
        }
        s = m;
        setStream(m);
        setPhase('ready');
      })
      .catch(() => !cancelled && setPhase('denied'));
    return () => {
      cancelled = true;
      if (recorder.current?.state === 'recording') recorder.current.stop();
      recorder.current = null;
      for (const t of s?.getTracks() ?? []) t.stop();
      setStream(null);
      setTake((t) => {
        if (t) URL.revokeObjectURL(t.url);
        return null;
      });
    };
  }, [open]);

  useEffect(() => {
    if (live.current && stream) live.current.srcObject = stream;
  }, [stream, phase]);

  const record = useCallback(() => {
    if (!stream) return;
    const type = TYPES.find((t) => MediaRecorder.isTypeSupported(t));
    const rec = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
    const chunks: Blob[] = [];
    const started = Date.now();
    rec.ondataavailable = (e) => {
      if (e.data.size) chunks.push(e.data);
    };
    rec.onstop = () => {
      const blob = new Blob(chunks, { type: (rec.mimeType || 'video/webm').split(';')[0] });
      setTake({ blob, url: URL.createObjectURL(blob), seconds: (Date.now() - started) / 1000 });
      setPhase('recorded');
    };
    rec.start(250);
    recorder.current = rec;
    setElapsed(0);
    setPhase('recording');
  }, [stream]);

  // 3, 2, 1, then recording
  useEffect(() => {
    if (phase !== 'countdown') return;
    if (count === 0) {
      record();
      return;
    }
    const t = setTimeout(() => setCount((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [phase, count, record]);

  // The recording stops at the shot's length
  useEffect(() => {
    if (phase !== 'recording') return;
    const started = Date.now();
    const t = setInterval(() => {
      const s = (Date.now() - started) / 1000;
      setElapsed(s);
      if (s >= limit && recorder.current?.state === 'recording') recorder.current.stop();
    }, 100);
    return () => clearInterval(t);
  }, [phase, limit]);

  const again = () => {
    if (take) URL.revokeObjectURL(take.url);
    setTake(null);
    setPhase('ready');
  };

  const use = async () => {
    if (!take || !projectId) return;
    setPhase('uploading');
    try {
      const ext = take.blob.type.includes('mp4') ? 'mp4' : 'webm';
      const file = new File([take.blob], `performance-c${clip.index + 1}-s${shot.index + 1}.${ext}`, {
        type: take.blob.type,
      });
      const prepared = await prepareMedia(file, { poster: true }).catch(() => ({
        probe: null,
        poster: null,
      }));
      // Recorders write no length in the file's header: the recording's own clock gives it
      const probe = prepared.probe
        ? { ...prepared.probe, durationSec: prepared.probe.durationSec || take.seconds }
        : null;
      const resource = await api.upload(projectId, file, {
        role: 'reference',
        probe,
        poster: prepared.poster,
      });
      rememberUpload(resource.media, file);
      await api.updateShot(projectId, clip.id, shot.id, {
        motionReference: { resourceId: resource.id, mode: 'performance' },
      });
      onClose();
    } catch (err) {
      reportError(err);
      setPhase('recorded');
    }
  };

  const footer =
    phase === 'recorded' || phase === 'uploading' ? (
      <>
        <Button icon={<RotateCcw className="size-4" />} onClick={again} disabled={phase === 'uploading'}>
          Record again
        </Button>
        <Button variant="primary" loading={phase === 'uploading'} onClick={use} data-testid="performance-use">
          Use this performance
        </Button>
      </>
    ) : phase === 'recording' ? (
      <Button
        variant="primary"
        icon={<Square className="size-4" />}
        onClick={() => recorder.current?.stop()}
        data-testid="performance-stop"
      >
        Stop
      </Button>
    ) : (
      <Button
        variant="primary"
        icon={<Circle className="size-4" />}
        disabled={phase !== 'ready'}
        onClick={() => {
          setCount(3);
          setPhase('countdown');
        }}
        data-testid="performance-record"
      >
        Record
      </Button>
    );

  return (
    <Dialog open={open} onClose={onClose} title="Record a performance" footer={footer}>
      <div className="space-y-3" data-testid="performance-recorder" data-phase={phase}>
        <p className="text-[13px] text-muted">
          Act the shot: your expressions, lips, head and body and their timing drive the characters, up to{' '}
          {limit} s. Your voice becomes the take's sound.
        </p>
        <div className="relative overflow-hidden rounded-[var(--radius-control)] bg-black">
          {phase === 'recorded' || phase === 'uploading' ? (
            // biome-ignore lint/a11y/useMediaCaption: the director's own recording, played back before use
            <video
              src={take?.url}
              controls
              playsInline
              className="aspect-video w-full"
              data-testid="performance-playback"
            />
          ) : (
            <video
              ref={live}
              autoPlay
              muted
              playsInline
              className="aspect-video w-full -scale-x-100 object-cover"
              data-testid="performance-live"
            />
          )}
          {phase === 'countdown' ? (
            <span
              className="absolute inset-0 flex items-center justify-center text-6xl font-semibold text-white"
              data-testid="performance-countdown"
            >
              {count}
            </span>
          ) : null}
          {phase === 'recording' ? (
            <span className="absolute top-2 left-2 inline-flex items-center gap-1.5 rounded-full bg-black/60 px-2 py-0.5 text-[12px] text-white">
              <span className="size-2 rounded-full bg-danger" /> {elapsed.toFixed(1)} / {limit} s
            </span>
          ) : null}
          {phase === 'asking' || phase === 'denied' || phase === 'unsupported' ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 p-4 text-center text-[13px] text-white">
              <Video className="size-6" />
              {phase === 'asking'
                ? 'Allow the camera and microphone to record.'
                : phase === 'denied'
                  ? 'The camera or microphone is blocked: allow them for this site in the browser, then open this again.'
                  : 'This browser cannot record video.'}
            </div>
          ) : null}
        </div>
      </div>
    </Dialog>
  );
}
