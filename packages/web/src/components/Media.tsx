import type { MediaRef } from '@rideo/shared';
import { Film, ImageOff, Loader2, Play } from 'lucide-react';
import { useEffect, useState } from 'react';
import { playbackProxy } from '../engine/local-proxy';
import { mediaUrl } from '../lib/api';
import { cx } from './ui';

export function MediaImage({
  projectId,
  media,
  alt,
  className,
}: {
  projectId: string;
  media: Pick<MediaRef, 'path'> | null | undefined;
  alt: string;
  className?: string;
}) {
  if (!media) {
    return (
      <div className={cx('flex items-center justify-center bg-surface-2 text-muted', className)}>
        <ImageOff className="size-5" />
      </div>
    );
  }
  return (
    <img
      src={mediaUrl(projectId, media.path)}
      alt={alt}
      loading="lazy"
      className={cx('bg-surface-2 object-cover', className)}
    />
  );
}

/**
 * Plays the original. When this browser cannot, it shows the poster and builds a local proxy with ffmpeg.wasm
 * once the user presses play (docs/design/editor.md#playback-compatibility-local-proxies).
 */
export function MediaVideo({
  projectId,
  media,
  className,
  controls = true,
  autoPlay,
}: {
  projectId: string;
  media: MediaRef | null | undefined;
  className?: string;
  controls?: boolean;
  autoPlay?: boolean;
}) {
  const [proxyUrl, setProxyUrl] = useState<string | null>(null);
  const [state, setState] = useState<'original' | 'unplayable' | 'building' | 'proxy' | 'failed'>('original');
  useEffect(() => {
    setProxyUrl(null);
    setState('original');
  }, [media?.hash]);
  useEffect(() => () => void (proxyUrl && URL.revokeObjectURL(proxyUrl)), [proxyUrl]);
  if (!media) {
    return (
      <div className={cx('flex items-center justify-center bg-surface-2 text-muted', className)}>
        <Film className="size-5" />
      </div>
    );
  }
  const poster = media.poster ? mediaUrl(projectId, media.poster.path) : undefined;
  const prepare = () => {
    setState('building');
    playbackProxy(projectId, media)
      .then((blob) => {
        setProxyUrl(URL.createObjectURL(blob));
        setState('proxy');
      })
      .catch(() => setState('failed'));
  };
  if (state === 'unplayable' || state === 'building' || state === 'failed') {
    return (
      <div className={cx('relative bg-black', className)} data-playback={state}>
        {poster ? <img src={poster} alt="" className="size-full object-contain" /> : null}
        <button
          type="button"
          onClick={prepare}
          disabled={state === 'building'}
          className="absolute inset-0 flex items-center justify-center gap-2 bg-black/50 text-[12px] text-white"
          data-testid="prepare-playback"
        >
          {state === 'building' ? (
            <>
              <Loader2 className="size-4 animate-spin" /> Preparing playback in this browser…
            </>
          ) : (
            <>
              <Play className="size-5" /> {state === 'failed' ? 'Retry' : 'Play'}
            </>
          )}
        </button>
      </div>
    );
  }
  return (
    <div className={cx('relative', className)} data-playback={state}>
      <video
        src={proxyUrl ?? mediaUrl(projectId, media.path)}
        poster={poster}
        controls={controls}
        autoPlay={autoPlay || state === 'proxy'}
        muted={autoPlay}
        playsInline
        preload="metadata"
        onError={() => state === 'original' && setState('unplayable')}
        className="size-full bg-black object-contain"
      />
    </div>
  );
}
