import type { MediaRef } from '@rideo/shared';
import { Film, ImageOff } from 'lucide-react';
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

/** Plays the browser-safe proxy when available (docs/design/editor.md#proxy-media). */
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
  if (!media) {
    return (
      <div className={cx('flex items-center justify-center bg-surface-2 text-muted', className)}>
        <Film className="size-5" />
      </div>
    );
  }
  const src = media.proxy ? mediaUrl(projectId, media.proxy.path) : mediaUrl(projectId, media.path);
  return (
    <video
      src={src}
      poster={media.poster ? mediaUrl(projectId, media.poster.path) : undefined}
      controls={controls}
      autoPlay={autoPlay}
      muted={autoPlay}
      playsInline
      preload="metadata"
      className={cx('bg-black object-contain', className)}
    />
  );
}
