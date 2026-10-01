import {
  activeAt,
  type Effects,
  type TextItem,
  type Timeline,
  textPad,
  textSize,
  type VideoItem,
} from '@rideo/shared';
import type { CanvasSink, WrappedCanvas } from 'mediabunny';
import { VIDEO_FONT } from '../../../engine/fonts';
import type { MediaPool } from './media-pool';

type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** Sequential frame reader over a mediabunny iterator (decodes each packet once during playback/export). */
export class FrameCursor {
  private readonly it: AsyncGenerator<WrappedCanvas, void, unknown>;
  private current: WrappedCanvas | null = null;
  private next: WrappedCanvas | null = null;
  private done = false;

  constructor(sink: CanvasSink, start: number) {
    this.it = sink.canvases(Math.max(0, start));
  }

  async frameAt(t: number): Promise<WrappedCanvas['canvas'] | null> {
    if (!this.current && !this.done) {
      const r = await this.it.next();
      if (r.done) this.done = true;
      else this.current = r.value;
    }
    while (!this.done) {
      if (!this.next) {
        const r = await this.it.next();
        if (r.done) {
          this.done = true;
          break;
        }
        this.next = r.value;
      }
      if (this.next.timestamp <= t + 1e-4) {
        this.current = this.next;
        this.next = null;
      } else break;
    }
    return this.current?.canvas ?? null;
  }

  dispose(): void {
    void this.it.return(undefined);
  }
}

export function cssFilter(e?: Effects): string {
  if (!e) return 'none';
  const parts: string[] = [];
  if (e.brightness !== undefined && e.brightness !== 0) parts.push(`brightness(${1 + e.brightness})`);
  if (e.contrast !== undefined && e.contrast !== 1) parts.push(`contrast(${e.contrast})`);
  if (e.saturation !== undefined && e.saturation !== 1) parts.push(`saturate(${e.saturation})`);
  return parts.length ? parts.join(' ') : 'none';
}

function drawContain(
  ctx: Ctx2D,
  img: CanvasImageSource & { width: number; height: number },
  w: number,
  h: number,
): void {
  const scale = Math.min(w / img.width, h / img.height);
  const dw = img.width * scale;
  const dh = img.height * scale;
  ctx.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh);
}

export function drawText(ctx: Ctx2D, item: TextItem, w: number, h: number): void {
  // Same size, padding and placement as the ffmpeg engine's drawtext (shared render plan).
  const size = textSize(item, h);
  const pad = textPad(item, h);
  ctx.save();
  // The bundled DejaVu Sans, the font the ffmpeg engine's drawtext uses (engine/fonts.ts)
  ctx.font = `${size}px "${VIDEO_FONT}", sans-serif`;
  ctx.textBaseline = 'middle';
  const metrics = ctx.measureText(item.text);
  const label = item.style.preset === 'label';
  const pos = item.style.position ?? (item.style.preset === 'title' ? 'center' : 'bottom');
  const y = label
    ? pos === 'top'
      ? h * 0.04 + size / 2
      : h - h * 0.04 - size / 2
    : item.style.preset === 'lower_third'
      ? h * 0.72 + size / 2
      : pos === 'top'
        ? h * 0.08 + size / 2
        : pos === 'center'
          ? h / 2
          : h - h * 0.08 - size / 2;
  const align = item.style.align ?? (label ? 'right' : 'center');
  const x =
    align === 'left' ? w * 0.03 : align === 'right' ? w - w * 0.03 - metrics.width : (w - metrics.width) / 2;
  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  ctx.fillRect(x - pad, y - size / 2 - pad, metrics.width + pad * 2, size + pad * 2);
  ctx.fillStyle = item.style.color ?? '#ffffff';
  ctx.textAlign = 'left';
  ctx.fillText(item.text, x, y);
  ctx.restore();
}

/**
 * Draws the timeline at a time using the shared `activeAt` query, so the browser preview/export and the
 * server render agree on every frame (docs/design/editor.md#queries-shared-used-by-preview-and-render).
 */
export class Compositor {
  private readonly cursors = new Map<string, FrameCursor>();

  constructor(
    private readonly pool: MediaPool,
    private timeline: Timeline,
  ) {}

  setTimeline(t: Timeline): void {
    this.timeline = t;
    this.resetCursors();
  }

  resetCursors(): void {
    for (const c of this.cursors.values()) c.dispose();
    this.cursors.clear();
  }

  private async frame(
    item: VideoItem,
    sourceTime: number,
    sequential: boolean,
  ): Promise<WrappedCanvas['canvas'] | null> {
    const entry = await this.pool.get(item.source.media);
    if (!entry.video) return null;
    if (!sequential) return (await entry.video.getCanvas(sourceTime))?.canvas ?? null;
    let cursor = this.cursors.get(item.id);
    if (!cursor) {
      cursor = new FrameCursor(entry.video, sourceTime);
      this.cursors.set(item.id, cursor);
    }
    return cursor.frameAt(sourceTime);
  }

  /** Renders one frame. `sequential` = playback/export (iterators); otherwise random access (scrubbing). */
  async render(ctx: Ctx2D, time: number, w: number, h: number, sequential: boolean): Promise<void> {
    const state = activeAt(this.timeline, time);
    const frames = await Promise.all(state.video.map((l) => this.frame(l.item, l.sourceTime, sequential)));
    if (sequential) {
      const live = new Set(state.video.map((l) => l.item.id));
      for (const [id, c] of this.cursors) {
        if (!live.has(id)) {
          c.dispose();
          this.cursors.delete(id);
        }
      }
    }
    ctx.save();
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, h);
    state.video.forEach((layer, i) => {
      const img = frames[i];
      if (!img) return;
      ctx.save();
      ctx.globalAlpha = layer.opacity;
      ctx.filter = cssFilter(layer.effects);
      if (layer.wipe !== undefined) {
        ctx.beginPath();
        ctx.rect(0, 0, w * layer.wipe, h);
        ctx.clip();
      }
      drawContain(ctx, img as CanvasImageSource & { width: number; height: number }, w, h);
      ctx.filter = 'none';
      if (layer.dim < 1) {
        ctx.globalAlpha = layer.opacity * (1 - layer.dim);
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, w, h);
      }
      ctx.restore();
    });
    for (const t of state.text) drawText(ctx, t, w, h);
    ctx.restore();
  }

  dispose(): void {
    this.resetCursors();
  }
}
