import { type AudioItem, isStillMedia, itemDuration, sourceTimeAt, type VideoItem } from '@rideo/shared';
import { useEffect, useRef, useState } from 'react';
import type { MediaPool } from './engine/media-pool';
import { drawPeaks, thumbnailAt, waveformPeaks } from './engine/peaks';

/** The visible pixels of an item block, at most this wide (keeps long items cheap). */
const MAX_PX = 2400;

/**
 * A video item's filmstrip: thumbnails at the lane's height across the item, from the source times they show
 * (docs/design/editor.md#waveforms-and-filmstrips).
 */
export function Filmstrip({
  pool,
  item,
  zoom,
  height,
}: {
  pool: MediaPool | null;
  item: VideoItem;
  zoom: number;
  height: number;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [ready, setReady] = useState(false);
  const media = item.source.media;
  const width = Math.min(MAX_PX, Math.max(8, Math.round(itemDuration(item) * zoom || 8)));
  const key = `${media.hash}|${item.in}|${item.out}|${item.speed}|${zoom}|${JSON.stringify(item.ramp ?? null)}`;
  useEffect(() => {
    const canvas = ref.current;
    if (!pool || !canvas) return;
    let alive = true;
    setReady(false);
    const aspect = media.width && media.height ? media.width / media.height : 16 / 9;
    const tile = Math.max(8, Math.round(height * aspect));
    const count = Math.max(1, Math.min(40, Math.ceil(width / tile)));
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, width, height);
    void (async () => {
      for (let k = 0; k < count && alive; k++) {
        const x = k * tile;
        const t = isStillMedia(media)
          ? 0
          : sourceTimeAt(item, item.start + Math.min(x + tile / 2, width) / zoom);
        const img = await thumbnailAt(pool, media, t).catch(() => null);
        if (!alive || !img) continue;
        ctx.drawImage(img, x, 0, tile, height);
      }
      if (alive) setReady(true);
    })();
    return () => {
      alive = false;
    };
  }, [pool, key, width, height]);
  return (
    <canvas
      ref={ref}
      width={width}
      height={height}
      className="pointer-events-none absolute inset-0 h-full opacity-60"
      style={{ width }}
      data-testid="filmstrip"
      data-ready={ready}
      aria-hidden
    />
  );
}

/** A sound's waveform across its item. */
export function Waveform({
  pool,
  item,
  zoom,
  height,
}: {
  pool: MediaPool | null;
  item: VideoItem | AudioItem;
  zoom: number;
  height: number;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [ready, setReady] = useState(false);
  const media = item.source.media;
  const span = itemDuration(item);
  const width = Math.min(MAX_PX, Math.max(8, Math.round(span * zoom)));
  useEffect(() => {
    const canvas = ref.current;
    if (!pool || !canvas || media.hasAudio === false) return;
    let alive = true;
    setReady(false);
    void waveformPeaks(pool, media)
      .then((peaks) => {
        const ctx = canvas.getContext('2d');
        if (!alive || !peaks || !ctx) return;
        ctx.fillStyle = getComputedStyle(canvas).color || '#9aa2b4';
        drawPeaks(ctx, peaks, item.in, item.out, width, height);
        setReady(true);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [pool, media.hash, item.in, item.out, width, height]);
  if (media.hasAudio === false) return null;
  return (
    <canvas
      ref={ref}
      width={width}
      height={height}
      className="pointer-events-none absolute bottom-0 left-0 text-text/60"
      style={{ width, height }}
      data-testid="waveform"
      data-ready={ready}
      aria-hidden
    />
  );
}
