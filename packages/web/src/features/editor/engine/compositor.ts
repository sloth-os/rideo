import {
  type ActiveState,
  activeAt,
  applyAdjustments,
  applyCube,
  applyKey,
  circleStops,
  cropWindow,
  type Effects,
  hasAdjustments,
  isShapedPicture,
  isStillMedia,
  type MediaRef,
  SLIDE_TYPES,
  type SlideType,
  slideOffsets,
  type TextItem,
  type Timeline,
  type TransitionType,
  textPad,
  textSize,
  type VideoItem,
  type VideoLayer,
  wipeEdge,
} from '@rideo/shared';
import type { CanvasSink, WrappedCanvas } from 'mediabunny';
import { VIDEO_FONT } from '../../../engine/fonts';
import type { GpuRenderer } from './gpu';
import {
  type CompositorKind,
  containPlacement,
  flipUv,
  type GpuDraw,
  type GpuPicture,
  slideClip,
  uvOf,
  vignetteOf,
} from './gpu-plan';
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

/** Line height of multi-line text, as drawtext stacks lines (DejaVu Sans: ascent + descent ≈ 1.17 em). */
const LINE_HEIGHT = 1.17;

export function drawText(ctx: Ctx2D, item: TextItem, w: number, h: number): void {
  // Same size, padding, box and placement as the ffmpeg engine's drawtext (shared render plan).
  const size = textSize(item, h);
  const pad = textPad(item, h);
  ctx.save();
  // A brand font (docs/design/brand-kits.md), else the bundled DejaVu Sans that drawtext uses (engine/fonts.ts)
  const family = item.style.font ? `"${item.style.font.family}", "${VIDEO_FONT}"` : `"${VIDEO_FONT}"`;
  ctx.font = `${size}px ${family}, sans-serif`;
  ctx.textBaseline = 'middle';
  const lines = item.text.split('\n');
  const widths = lines.map((l) => ctx.measureText(l).width);
  const blockW = Math.max(...widths);
  const lineH = size * LINE_HEIGHT;
  const blockH = size + (lines.length - 1) * lineH;
  const label = item.style.preset === 'label';
  const pos = item.style.position ?? (item.style.preset === 'title' ? 'center' : 'bottom');
  const top = label
    ? pos === 'top'
      ? h * 0.04
      : h - h * 0.04 - blockH
    : item.style.preset === 'lower_third'
      ? h * 0.72
      : pos === 'top'
        ? h * 0.08
        : pos === 'center'
          ? (h - blockH) / 2
          : h - blockH - h * 0.08;
  const align = item.style.align ?? (label ? 'right' : 'center');
  const x = align === 'left' ? w * 0.03 : align === 'right' ? w - w * 0.03 - blockW : (w - blockW) / 2;
  if (item.style.box !== null) {
    const [r, g, b] = hexRgb(item.style.box ?? '#000000');
    ctx.fillStyle = `rgba(${r},${g},${b},${item.style.boxOpacity ?? 0.45})`;
    ctx.fillRect(x - pad, top - pad, blockW + pad * 2, blockH + pad * 2);
  }
  ctx.fillStyle = item.style.color ?? '#ffffff';
  ctx.textAlign = 'left';
  for (const [i, l] of lines.entries()) ctx.fillText(l, x, top + size / 2 + i * lineH);
  ctx.restore();
}

function hexRgb(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
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

/**
 * Whether a layer needs the shaped path: a transform, an overlay, a LUT, a mask, a key, a mirror or RGB adjustments
 * (the fitted picture in a scratch, worked on per pixel, then placed).
 */
function shaped(layer: VideoLayer): boolean {
  const item = layer.item;
  return (
    !!layer.transform ||
    !!layer.overlay ||
    !!item.lut ||
    !!item.mask ||
    !!item.key ||
    !!item.flip ||
    hasAdjustments(layer.effects)
  );
}

/**
 * Transitions drawn from whole frames, their letterbox included, as xfade mixes them
 * (docs/design/editing-tools.md#transitions): the dips and the circle (by the canvas, also when WebGPU draws the rest)
 * and the slides.
 */
const WHOLE_FRAME = new Set<TransitionType>(['dip_to_black', 'dip_to_white', 'circle_open', ...SLIDE_TYPES]);
const CANVAS_ONLY = new Set<TransitionType>(['dip_to_black', 'dip_to_white', 'circle_open']);

/** Whether the canvas draws this frame: a dip or a circle is mixed per pixel from whole frames. */
export function needsCanvas(state: ActiveState): boolean {
  return state.video.some((l) => !!l.transition && CANVAS_ONLY.has(l.transition.type));
}

/** Mirrors what is drawn next inside a w × h box at the origin. */
function mirror(ctx: Ctx2D, flip: VideoItem['flip'], w: number, h: number): void {
  if (flip?.x) {
    ctx.translate(w, 0);
    ctx.scale(-1, 1);
  }
  if (flip?.y) {
    ctx.translate(0, h);
    ctx.scale(1, -1);
  }
}

/** Clips to the incoming part of a wipe (right of the edge, as xfade's wipeleft). */
function clipWipe(ctx: Ctx2D, wipe: number | undefined, w: number, h: number): void {
  if (wipe === undefined) return;
  const edge = wipeEdge(wipe, w);
  ctx.beginPath();
  ctx.rect(edge, 0, Math.max(0, w - edge), h);
  ctx.clip();
}

/**
 * Draws the timeline at a time using the shared `activeAt` query, so the browser preview/export and the
 * server render agree on every frame (docs/design/editor.md#queries-shared-used-by-preview-and-render).
 */
export class Compositor {
  private readonly cursors = new Map<string, FrameCursor>();
  private readonly scratch: {
    picture: Scratch | null;
    matte: Scratch | null;
    titles: Scratch | null;
    frame: Scratch | null;
    circle: Scratch | null;
  } = {
    picture: null,
    matte: null,
    titles: null,
    frame: null,
    circle: null,
  };
  private gpu: GpuRenderer | null = null;

  constructor(
    private readonly pool: MediaPool,
    private timeline: Timeline,
  ) {}

  /** Composites on the GPU from now on (docs/design/engine-performance.md#webgpu-compositing); null: the canvas. */
  setGpu(renderer: GpuRenderer | null): void {
    this.gpu = renderer;
  }

  /** What draws the frames. */
  get backend(): CompositorKind {
    return this.gpu && !this.gpu.lost ? 'webgpu' : 'canvas';
  }

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

  private canvas(
    which: 'picture' | 'matte' | 'frame' | 'circle',
    w: number,
    h: number,
  ): OffscreenCanvasRenderingContext2D {
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
   * A transformed, overlaid, graded, keyed or masked picture: fitted (and mirrored), graded with its LUT, its color
   * effects and adjustments, keyed or given the matte's luma as alpha, then placed with its transform (the ffmpeg
   * graph's order).
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
    pic.save();
    mirror(pic, item.flip, r.w, r.h);
    pic.filter = cssFilter(layer.effects);
    if (crop && item.crop) {
      const win = cropWindow(img, w / h, item.crop.focus, layer.sourceTime);
      pic.drawImage(img, win.x, win.y, win.width, win.height, 0, 0, r.w, r.h);
    } else if (isStillMedia(item.source.media)) pic.drawImage(img, 0, 0, r.w, r.h);
    else pic.drawImage(img, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
    pic.restore();
    pic.filter = 'none';
    const lut = item.lut ? await this.pool.lut(item.lut.media).catch(() => null) : null;
    const matte = await this.matte(layer, sequential);
    const adjust = hasAdjustments(layer.effects);
    if (lut || matte || adjust || item.key) {
      const data = pic.getImageData(0, 0, r.w, r.h);
      if (lut && item.lut) applyCube(lut, data.data, item.lut.intensity);
      if (adjust) {
        // The vignette's centre: the frame for a letterboxed primary picture, as ffmpeg sees it; else the picture
        const fitted = layer.overlay || isShapedPicture(item);
        applyAdjustments(
          data.data,
          r.w,
          r.h,
          layer.effects!,
          fitted ? undefined : { x: r.x, y: r.y, width: w, height: h },
        );
      }
      if (item.key) applyKey(data.data, item.key);
      if (matte) {
        const m = this.canvas('matte', r.w, r.h);
        m.save();
        mirror(m, item.flip, r.w, r.h);
        m.drawImage(matte as Frame, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
        m.restore();
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
    if (!layer.overlay) clipWipe(ctx, layer.wipe, w, h);
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

  /** A layer as the canvas draws it over what is below: shaped or letterboxed, then its fade's black. */
  private async drawLayer(
    ctx: Ctx2D,
    layer: VideoLayer,
    img: Frame,
    sequential: boolean,
    w: number,
    h: number,
  ): Promise<void> {
    if (shaped(layer)) {
      // Over black (a primary picture) or over the tracks below (an overlay), as the ffmpeg graph composites them
      await this.drawShaped(ctx, layer, img, sequential, w, h);
      if (!layer.overlay && layer.dim < 1) {
        ctx.save();
        clipWipe(ctx, layer.wipe, w, h);
        ctx.globalAlpha = layer.opacity * (1 - layer.dim);
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, w, h);
        ctx.restore();
      }
      return;
    }
    ctx.save();
    ctx.globalAlpha = layer.opacity;
    ctx.filter = cssFilter(layer.effects);
    clipWipe(ctx, layer.wipe, w, h);
    if (layer.item.crop) {
      // Reframed around the subject, the same window as the ffmpeg crop (docs/design/finishing.md).
      const r = cropWindow(img, w / h, layer.item.crop.focus, layer.sourceTime);
      ctx.drawImage(img, r.x, r.y, r.width, r.height, 0, 0, w, h);
    } else drawContain(ctx, img, w, h);
    ctx.filter = 'none';
    if (layer.dim < 1) {
      ctx.globalAlpha = layer.opacity * (1 - layer.dim);
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, w, h);
    }
    ctx.restore();
  }

  /**
   * A primary layer of a dip, a slide or the circle: its whole frame (letterbox included) in a scratch, then mixed
   * as xfade mixes the two frames (docs/design/editing-tools.md#transitions).
   */
  private async drawWholeFrame(
    ctx: Ctx2D,
    layer: VideoLayer,
    img: Frame,
    sequential: boolean,
    w: number,
    h: number,
  ): Promise<void> {
    const tr = layer.transition!;
    const frame = this.canvas('frame', w, h);
    frame.fillStyle = '#000';
    frame.fillRect(0, 0, w, h);
    await this.drawLayer(frame, { ...layer, opacity: 1, transition: undefined }, img, sequential, w, h);
    const whole = this.scratch.frame!;
    ctx.save();
    if (tr.type === 'dip_to_black' || tr.type === 'dip_to_white') {
      ctx.globalAlpha = layer.opacity;
      ctx.drawImage(whole, 0, 0, w, h);
    } else if (tr.type === 'circle_open' && tr.role === 'in') {
      // The incoming frame inside the soft circle: its alpha from the gradient (destination-in)
      const circle = this.canvas('circle', w, h);
      circle.drawImage(whole, 0, 0, w, h);
      const g = circleStops(w, h, tr.progress);
      const gradient = circle.createRadialGradient(g.cx, g.cy, 0, g.cx, g.cy, g.radius);
      for (const s of g.stops) gradient.addColorStop(s.offset, `rgba(0,0,0,${s.weight})`);
      circle.globalCompositeOperation = 'destination-in';
      circle.fillStyle = gradient;
      circle.fillRect(0, 0, w, h);
      circle.globalCompositeOperation = 'source-over';
      ctx.drawImage(this.scratch.circle!, 0, 0, w, h);
    } else if ((SLIDE_TYPES as readonly string[]).includes(tr.type)) {
      const at = slideOffsets(tr.type as SlideType, tr.progress, w, h)[tr.role];
      ctx.drawImage(whole, at[0], at[1], w, h);
    } else ctx.drawImage(whole, 0, 0, w, h);
    ctx.restore();
  }

  /** Iterators of items no longer on screen are closed (playback/export). */
  private dropCursors(state: ReturnType<typeof activeAt>): void {
    const live = new Set(state.video.flatMap((l) => [l.item.id, `${l.item.id}#mask`]));
    for (const [id, c] of this.cursors) {
      if (!live.has(id)) {
        c.dispose();
        this.cursors.delete(id);
      }
    }
  }

  /** Brand fonts load once per file before their first frame (docs/design/brand-kits.md). */
  private fonts(state: ReturnType<typeof activeAt>): Promise<unknown> {
    return Promise.all(
      state.text.flatMap((t) =>
        t.style.font ? [this.pool.font(t.style.font.media, t.style.font.family)] : [],
      ),
    );
  }

  /** Renders one frame. `sequential` = playback/export (iterators); otherwise random access (scrubbing). */
  async render(ctx: Ctx2D, time: number, w: number, h: number, sequential: boolean): Promise<void> {
    const state = activeAt(this.timeline, time);
    // Dips and the circle are mixed per pixel by the canvas, also when WebGPU draws the other frames
    if (this.gpu && !this.gpu.lost && !needsCanvas(state)) {
      try {
        await this.renderGpu(ctx, state, w, h, sequential);
        return;
      } catch (err) {
        // The canvas draws the rest of the session
        console.warn('WebGPU compositing failed; drawing with the canvas', err);
        this.gpu = null;
      }
    }
    const frames = await Promise.all(state.video.map((l) => this.frame(l.item, l.sourceTime, sequential)));
    if (sequential) this.dropCursors(state);
    ctx.save();
    ctx.globalAlpha = 1;
    // Under the primary pictures: black, or white in a dip to white
    ctx.fillStyle = state.fill ?? '#000';
    ctx.fillRect(0, 0, w, h);
    for (const [i, layer] of state.video.entries()) {
      const img = frames[i] as Frame | null | undefined;
      if (!img) continue;
      if (!layer.overlay && layer.transition && WHOLE_FRAME.has(layer.transition.type))
        await this.drawWholeFrame(ctx, layer, img, sequential, w, h);
      else await this.drawLayer(ctx, layer, img, sequential, w, h);
    }
    await this.fonts(state);
    for (const t of state.text) drawText(ctx, t, w, h);
    ctx.restore();
  }

  /**
   * The same frame on the GPU: each layer a draw with the canvas path's geometry (fitted rectangle, crop window,
   * transform, mirror, slide), effects, LUT, adjustments, key, matte, opacity, dim and wipe; titles drawn by the canvas
   * onto one transparent layer.
   */
  private async renderGpu(
    ctx: Ctx2D,
    state: ActiveState,
    w: number,
    h: number,
    sequential: boolean,
  ): Promise<void> {
    const gpu = this.gpu!;
    const frames = await Promise.all(state.video.map((l) => this.frame(l.item, l.sourceTime, sequential)));
    if (sequential) this.dropCursors(state);
    const draws: GpuDraw[] = [];
    for (const [i, layer] of state.video.entries()) {
      const img = frames[i] as Frame | null;
      if (!img) continue;
      const item = layer.item;
      // A slide moves the whole frame by whole pixels and clips what it draws to it
      const tr = layer.transition;
      const slide =
        !layer.overlay && tr && (SLIDE_TYPES as readonly string[]).includes(tr.type)
          ? slideOffsets(tr.type as SlideType, tr.progress, w, h)[tr.role]
          : null;
      const clip = slide ? slideClip(slide, w, h) : undefined;
      const [dx, dy] = slide ?? [0, 0];
      const wipe = layer.overlay ? undefined : layer.wipe;
      if (shaped(layer)) {
        const crop = !!item.crop;
        const r = fittedRect(item.source.media, crop, w, h);
        const src =
          crop && item.crop
            ? cropWindow(img, w / h, item.crop.focus, layer.sourceTime)
            : isStillMedia(item.source.media)
              ? { x: 0, y: 0, width: img.width, height: img.height }
              : { x: r.x, y: r.y, width: r.w, height: r.h };
        const cube = item.lut ? await this.pool.lut(item.lut.media).catch(() => null) : null;
        const matte = (await this.matte(layer, sequential)) as Frame | null;
        const t = layer.transform ?? { x: 0.5, y: 0.5, scale: 1, rotation: 0, opacity: 1 };
        const fitted = layer.overlay || isShapedPicture(item);
        const picture: GpuPicture = {
          kind: 'picture',
          source: img,
          uv: flipUv(uvOf(src, img), item.flip),
          placement: {
            cx: t.x * w + dx,
            cy: t.y * h + dy,
            w: r.w * t.scale,
            h: r.h * t.scale,
            rotation: t.rotation,
          },
          effects: layer.effects,
          opacity: layer.overlay ? t.opacity : t.opacity * layer.opacity,
          lut: cube && item.lut ? { cube, intensity: item.lut.intensity } : null,
          matte: matte
            ? {
                source: matte,
                uv: flipUv(uvOf({ x: r.x, y: r.y, width: r.w, height: r.h }, matte), item.flip),
                invert: !!item.mask?.invert,
              }
            : null,
          key: item.key ?? null,
          vignette: vignetteOf(
            layer.effects,
            fitted ? { picture: [r.w, r.h] } : { frame: [w, h], origin: [dx, dy] },
          ),
          wipe,
          clip,
        };
        draws.push(picture);
        if (!layer.overlay && layer.dim < 1)
          draws.push({ kind: 'fill', opacity: layer.opacity * (1 - layer.dim), wipe, clip });
        continue;
      }
      // Reframed around the subject (the ffmpeg crop's window), else fitted inside the frame
      const win = item.crop ? cropWindow(img, w / h, item.crop.focus, layer.sourceTime) : null;
      const place = win ? { cx: w / 2, cy: h / 2, w, h, rotation: 0 } : containPlacement(img, w, h);
      draws.push({
        kind: 'picture',
        source: img,
        uv: win ? uvOf(win, img) : [0, 0, 1, 1],
        placement: { ...place, cx: place.cx + dx, cy: place.cy + dy },
        effects: layer.effects,
        opacity: layer.opacity,
        wipe,
        clip,
      });
      if (layer.dim < 1) draws.push({ kind: 'fill', opacity: layer.opacity * (1 - layer.dim), wipe, clip });
    }
    await this.fonts(state);
    let titles: Scratch | null = null;
    if (state.text.length) {
      titles = this.scratch.titles;
      if (!titles || titles.width !== w || titles.height !== h) {
        titles = new OffscreenCanvas(w, h);
        this.scratch.titles = titles;
      }
      const t = titles.getContext('2d')!;
      t.clearRect(0, 0, w, h);
      for (const item of state.text) drawText(t, item, w, h);
    }
    const frame = gpu.render(draws, titles, w, h);
    try {
      ctx.save();
      ctx.globalAlpha = 1;
      ctx.filter = 'none';
      ctx.drawImage(frame, 0, 0, w, h);
      ctx.restore();
    } finally {
      frame.close();
    }
  }

  dispose(): void {
    this.resetCursors();
  }
}
