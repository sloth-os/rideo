import {
  activeAt,
  applyCube,
  cropWindow,
  type Effects,
  isStillMedia,
  type MediaRef,
  type TextItem,
  type Timeline,
  textPad,
  textSize,
  type VideoItem,
  type VideoLayer,
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

type Frame = CanvasImageSource & { width: number; height: number };
type Scratch = OffscreenCanvas;

/** The picture fitted into the frame (contain), as the ffmpeg graph's `fittedSize`. */
function fittedRect(media: MediaRef, crop: boolean, w: number, h: number) {
  if (crop || !media.width || !media.height) return { x: 0, y: 0, w, h };
  const k = Math.min(w / media.width, h / media.height);
  const fw = Math.max(2, Math.round((media.width * k) / 2) * 2);
  const fh = Math.max(2, Math.round((media.height * k) / 2) * 2);
  return { x: (w - fw) / 2, y: (h - fh) / 2, w: fw, h: fh };
}

/** Whether a layer needs the shaped path: a transform, an overlay, a LUT or a mask. */
function shaped(layer: VideoLayer): boolean {
  return !!layer.transform || !!layer.overlay || !!layer.item.lut || !!layer.item.mask;
}

/**
 * Draws the timeline at a time using the shared `activeAt` query, so the browser preview/export and the
 * server render agree on every frame (docs/design/editor.md#queries-shared-used-by-preview-and-render).
 */
export class Compositor {
  private readonly cursors = new Map<string, FrameCursor>();
  private readonly scratch: { picture: Scratch | null; matte: Scratch | null } = {
    picture: null,
    matte: null,
  };

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
    media: MediaRef = item.source.media,
    key: string = item.id,
  ): Promise<WrappedCanvas['canvas'] | ImageBitmap | null> {
    if (isStillMedia(media)) return this.pool.image(media);
    const entry = await this.pool.get(media);
    if (!entry.video) return null;
    if (!sequential) return (await entry.video.getCanvas(sourceTime))?.canvas ?? null;
    let cursor = this.cursors.get(key);
    if (!cursor) {
      cursor = new FrameCursor(entry.video, sourceTime);
      this.cursors.set(key, cursor);
    }
    return cursor.frameAt(sourceTime);
  }

  /** The matte frame of a masked layer, inside the matte's range (docs/design/editor.md#segmentation-masks-remove-the-background). */
  private async matte(layer: VideoLayer, sequential: boolean) {
    const mask = layer.item.mask;
    if (!mask || isStillMedia(layer.item.source.media)) return null;
    const t = layer.sourceTime - mask.offset;
    if (t < -1e-6 || (mask.media.durationSec !== undefined && t > mask.media.durationSec + 0.05)) return null;
    return this.frame(layer.item, Math.max(0, t), sequential, mask.media, `${layer.item.id}#mask`);
  }

  private canvas(which: 'picture' | 'matte', w: number, h: number): OffscreenCanvasRenderingContext2D {
    let c = this.scratch[which];
    if (!c || c.width !== w || c.height !== h) {
      c = new OffscreenCanvas(w, h);
      this.scratch[which] = c;
    }
    const ctx = c.getContext('2d', { willReadFrequently: true })!;
    ctx.clearRect(0, 0, w, h);
    return ctx;
  }

  /**
   * A transformed, overlaid, graded or masked picture: fitted, graded with its LUT, its color effects, the matte's
   * luma as alpha, then placed with its transform (the ffmpeg graph's order).
   */
  private async drawShaped(
    ctx: Ctx2D,
    layer: VideoLayer,
    img: Frame,
    sequential: boolean,
    w: number,
    h: number,
  ): Promise<void> {
    const item = layer.item;
    const crop = !!item.crop;
    const r = fittedRect(item.source.media, crop, w, h);
    const pic = this.canvas('picture', r.w, r.h);
    pic.filter = cssFilter(layer.effects);
    if (crop && item.crop) {
      const win = cropWindow(img, w / h, item.crop.focus, layer.sourceTime);
      pic.drawImage(img, win.x, win.y, win.width, win.height, 0, 0, r.w, r.h);
    } else if (isStillMedia(item.source.media)) pic.drawImage(img, 0, 0, r.w, r.h);
    else pic.drawImage(img, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
    pic.filter = 'none';
    const lut = item.lut ? await this.pool.lut(item.lut.media).catch(() => null) : null;
    const matte = await this.matte(layer, sequential);
    if (lut || matte) {
      const data = pic.getImageData(0, 0, r.w, r.h);
      if (lut && item.lut) applyCube(lut, data.data, item.lut.intensity);
      if (matte) {
        const m = this.canvas('matte', r.w, r.h);
        m.drawImage(matte as Frame, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
        const md = m.getImageData(0, 0, r.w, r.h).data;
        const px = data.data;
        for (let i = 0; i < px.length; i += 4) {
          const luma = 0.299 * md[i]! + 0.587 * md[i + 1]! + 0.114 * md[i + 2]!;
          px[i + 3] = (px[i + 3]! * (item.mask!.invert ? 255 - luma : luma)) / 255;
        }
      }
      pic.putImageData(data, 0, 0);
    }
    const tr = layer.transform ?? { x: 0.5, y: 0.5, scale: 1, rotation: 0, opacity: 1 };
    ctx.save();
    ctx.globalAlpha = layer.overlay ? tr.opacity : tr.opacity * layer.opacity;
    ctx.translate(tr.x * w, tr.y * h);
    if (tr.rotation) ctx.rotate((tr.rotation * Math.PI) / 180);
    ctx.drawImage(
      this.scratch.picture!,
      (-r.w * tr.scale) / 2,
      (-r.h * tr.scale) / 2,
      r.w * tr.scale,
      r.h * tr.scale,
    );
    ctx.restore();
  }

  /** Renders one frame. `sequential` = playback/export (iterators); otherwise random access (scrubbing). */
  async render(ctx: Ctx2D, time: number, w: number, h: number, sequential: boolean): Promise<void> {
    const state = activeAt(this.timeline, time);
    const frames = await Promise.all(state.video.map((l) => this.frame(l.item, l.sourceTime, sequential)));
    if (sequential) {
      const live = new Set(state.video.flatMap((l) => [l.item.id, `${l.item.id}#mask`]));
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
    for (const [i, layer] of state.video.entries()) {
      const img = frames[i];
      if (!img) continue;
      if (shaped(layer)) {
        // Over black (a primary picture) or over the tracks below (an overlay), as the ffmpeg graph composites them
        await this.drawShaped(ctx, layer, img as Frame, sequential, w, h);
        if (!layer.overlay && layer.dim < 1) {
          ctx.save();
          ctx.globalAlpha = layer.opacity * (1 - layer.dim);
          ctx.fillStyle = '#000';
          ctx.fillRect(0, 0, w, h);
          ctx.restore();
        }
        continue;
      }
      ctx.save();
      ctx.globalAlpha = layer.opacity;
      ctx.filter = cssFilter(layer.effects);
      if (layer.wipe !== undefined) {
        ctx.beginPath();
        ctx.rect(0, 0, w * layer.wipe, h);
        ctx.clip();
      }
      const frame = img as CanvasImageSource & { width: number; height: number };
      if (layer.item.crop) {
        // Reframed around the subject, the same window as the ffmpeg crop (docs/design/finishing.md).
        const r = cropWindow(frame, w / h, layer.item.crop.focus, layer.sourceTime);
        ctx.drawImage(frame, r.x, r.y, r.width, r.height, 0, 0, w, h);
      } else drawContain(ctx, frame, w, h);
      ctx.filter = 'none';
      if (layer.dim < 1) {
        ctx.globalAlpha = layer.opacity * (1 - layer.dim);
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, w, h);
      }
      ctx.restore();
    }
    for (const t of state.text) drawText(ctx, t, w, h);
    ctx.restore();
  }

  dispose(): void {
    this.resetCursors();
  }
}
