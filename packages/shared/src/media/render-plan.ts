import { duckEnvelope, duckExpression } from '../audio/mix';
import { textFrames } from '../captions';
import { cropFilter } from '../finishing';
import type { MediaRef } from '../schemas/common';
import type { ExportQuality } from '../schemas/job';
import { AUDIO_ROLES, type AudioRole, type TextItem, type Timeline } from '../schemas/timeline';
import { isAnimated, isIdentity, linearExpression, opacityAt, propertyCurve } from '../timeline/keyframes';
import { sourceAtItemTime } from '../timeline/ops';
import {
  audioSegments,
  isStillMedia,
  overlaySegments,
  textItems,
  timelineDuration,
  type VideoSegment,
  videoSegments,
} from '../timeline/query';
import { sliceTimeMap, timeMapOf } from '../timeline/ramp';

/**
 * The render plan (docs/design/editor.md#rendering): the film is cut into frame-aligned chunks that never split
 * a transition or a fade; each chunk is one ffmpeg graph over input-seeked sources, and the soundtrack is one
 * graph for the whole film. The browser runs these graphs in ffmpeg.wasm; the server's reference worker runs
 * them with native ffmpeg.
 */

export interface RenderChunk {
  index: number;
  /** Timeline seconds (frame-aligned). */
  start: number;
  end: number;
  frames: number;
}

export interface RenderSize {
  width: number;
  height: number;
}

const n = (v: number) => (Math.round(v * 1000) / 1000).toString();
const even = (v: number) => Math.max(2, v - (v % 2));
const EPS = 1e-6;
/** Inputs are seeked this far before the first needed frame; the graph trims exactly. */
const SEEK_MARGIN = 1;

const XFADE: Record<string, string> = { crossfade: 'fade', wipe: 'wipeleft', dip_to_black: 'fadeblack' };

/** Output size: the project size (even), capped at 720p for drafts. */
export function renderSize(t: Timeline, quality: ExportQuality): RenderSize {
  let width = even(t.width);
  let height = even(t.height);
  if (quality === 'draft' && height > 720) {
    width = even(Math.round((width * 720) / height));
    height = 720;
  }
  return { width, height };
}

/** Frames of the whole render (at least half a second). */
export function totalFrames(t: Timeline): number {
  return Math.max(1, Math.round(Math.max(0.5, timelineDuration(t)) * t.fps));
}

/** Timeline intervals a chunk boundary may not fall into (open intervals, seconds). */
function forbiddenZones(segs: readonly VideoSegment[]): [number, number][] {
  const zones: [number, number][] = [];
  segs.forEach((s, k) => {
    const prev = segs[k - 1];
    if (s.transitionIn && prev) zones.push([s.start, prev.end]);
    if (s.fadeIn > 0) zones.push([s.start, s.start + s.fadeIn]);
    if (s.fadeOut > 0) zones.push([s.end - s.fadeOut, s.end]);
  });
  return zones;
}

export function planChunks(t: Timeline, opts: { targetSec?: number } = {}): RenderChunk[] {
  const fps = t.fps;
  const total = totalFrames(t);
  const segs = videoSegments(t);
  const zones = forbiddenZones(segs);
  const allowed = (frame: number) => {
    const time = frame / fps;
    return !zones.some(([a, b]) => a + EPS < time && time < b - EPS);
  };
  const cuts = segs
    .filter((s, k) => k > 0 && !s.transitionIn)
    .map((s) => Math.round(s.start * fps))
    .filter((f) => f > 0 && f < total && allowed(f));
  const target = Math.max(1, Math.round((opts.targetSec ?? 30) * fps));
  const chunks: RenderChunk[] = [];
  let from = 0;
  while (from < total) {
    let to: number;
    if (total - from <= Math.round(target * 1.5)) to = total;
    else {
      const desired = from + target;
      const lo = from + Math.ceil(target / 2);
      const hi = from + Math.floor(target * 1.5);
      const near = cuts.filter((f) => f >= lo && f <= hi);
      if (near.length)
        to = near.reduce((best, f) => (Math.abs(f - desired) < Math.abs(best - desired) ? f : best));
      else {
        to = desired;
        while (to < total && !allowed(to)) to++;
      }
    }
    to = Math.min(total, Math.max(to, from + 1));
    chunks.push({ index: chunks.length, start: from / fps, end: to / fps, frames: to - from });
    from = to;
  }
  return chunks;
}

export interface GraphInput {
  /** Path of a media file in the executing file system. */
  inputPath: (media: MediaRef) => string;
}

export interface ChunkGraph {
  /** Input options + `-filter_complex` + `-map [vout]`; append encoder options and the output path. */
  args: string[];
  /** Text files the graph reads, written before running: drawtext texts and `sendcmd` opacity commands. */
  textFiles: { path: string; content: string }[];
  frames: number;
  size: RenderSize;
}

export interface ChunkGraphOptions extends GraphInput {
  quality: ExportQuality;
  /** Path of the TTF used by drawtext (bundled DejaVu Sans). */
  fontFile?: string;
  /** Where the `i`-th drawn text (a text item, or a word frame of an animated caption) is written. */
  textPath: (i: number) => string;
}

function textY(item: TextItem): string {
  const pos = item.style.position ?? (item.style.preset === 'title' ? 'center' : 'bottom');
  if (item.style.preset === 'label') return pos === 'top' ? 'h*0.04' : 'h-text_h-h*0.04';
  if (item.style.preset === 'lower_third') return 'h*0.72';
  if (pos === 'top') return 'h*0.08';
  if (pos === 'center') return '(h-text_h)/2';
  return 'h-text_h-h*0.08';
}

/** Horizontal placement: centred, or a corner with a 3% margin (the `label` preset; docs/design/editor.md). */
function textX(item: TextItem): string {
  const align = item.style.align ?? (item.style.preset === 'label' ? 'right' : 'center');
  if (align === 'left') return 'w*0.03';
  if (align === 'right') return 'w-text_w-w*0.03';
  return '(w-text_w)/2';
}

/** Font size in pixels; shared with the WebCodecs compositor's `drawText`. */
export function textSize(item: TextItem, height: number): number {
  if (item.style.size) return item.style.size;
  // One word at a time is read at a glance: large (docs/design/localization.md#captions-and-word-timing).
  if (item.style.animate === 'pop') return Math.round(height / 12);
  const divisor = { title: 10, lower_third: 18, caption: 22, label: 32 }[item.style.preset];
  return Math.round(height / divisor);
}

/** Padding of the text box in pixels (smaller for corner labels). */
export function textPad(item: TextItem, height: number): number {
  return Math.max(1, Math.round(height / (item.style.preset === 'label' ? 100 : 60)));
}

/** Escapes a value for use inside an ffmpeg filter option. */
export function escapeFilterValue(v: string): string {
  return v
    .replace(/\\/g, '\\\\')
    .replace(/:/g, '\\:')
    .replace(/'/g, "\\'")
    .replace(/,/g, '\\,')
    .replace(/;/g, ';');
}

/** Where a segment's part of a chunk comes from: timeline and source ranges (ramp-aware). */
function partOf(s: VideoSegment, from: number, to: number) {
  const clamp = (v: number) => Math.min(s.out, Math.max(s.in, v));
  return {
    from,
    to,
    d: to - from,
    srcIn: clamp(sourceAtItemTime(s.item, from - s.start)),
    srcOut: clamp(sourceAtItemTime(s.item, to - s.start)),
  };
}

/** The size a picture takes when fitted into the frame (contain), even. */
function fittedSize(media: MediaRef, crop: boolean, width: number, height: number): { w: number; h: number } {
  if (crop || !media.width || !media.height) return { w: width, h: height };
  const k = Math.min(width / media.width, height / media.height);
  return { w: even(Math.round(media.width * k)), h: even(Math.round(media.height * k)) };
}

interface ChainContext {
  args: string[];
  filters: string[];
  files: { path: string; content: string }[];
  opts: ChunkGraphOptions;
  fps: number;
  width: number;
  height: number;
  /** A unique label suffix. */
  label: (base: string) => string;
}

/**
 * One segment's part as a stream (docs/design/editor.md#video-graph-per-chunk): input seeking, exact trim, its speed
 * or ramp, the fit (letterboxed, or fitted without padding when `fitted` for compositing), the LUT, color effects and
 * the mask. Returns the label of the stream and whether it carries alpha.
 */
function segmentStream(
  c: ChainContext,
  s: VideoSegment,
  part: ReturnType<typeof partOf>,
  mode: 'letterbox' | 'fitted',
): { label: string; alpha: boolean } {
  const { fps, width, height } = c;
  const still = isStillMedia(s.media);
  const k = c.args.filter((a) => a === '-i').length;
  let head: string;
  if (still) {
    // A still (storyboard frame): loop the image for the segment's part of the chunk.
    c.args.push(
      '-loop',
      '1',
      '-framerate',
      String(fps),
      '-t',
      n(part.d + 0.25),
      '-i',
      c.opts.inputPath(s.media),
    );
    head = `[${k}:v]trim=start=0:end=${n(part.d)},setpts=PTS-STARTPTS,`;
  } else {
    // Seek a second early and trim exactly: input seeking alone drops the frame that sits on the seek point.
    const seek = Math.max(0, part.srcIn - SEEK_MARGIN);
    c.args.push('-ss', n(seek), '-t', n(part.srcOut - seek + 0.25), '-i', c.opts.inputPath(s.media));
    head = `[${k}:v]trim=start=${n(part.srcIn - seek)}:end=${n(part.srcOut - seek)},${timing(s, part)},`;
  }
  const fitted = fittedSize(s.media, !!s.crop, width, height);
  const fit = s.crop
    ? `${cropFilter(s.crop, width / height, still ? 0 : part.srcIn, still ? 1 : s.speed)},scale=${width}:${height},`
    : mode === 'letterbox'
      ? `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black,`
      : `scale=${fitted.w}:${fitted.h},`;
  // settb: concat outputs AV_TIME_BASE, and xfade needs both inputs on the same timebase
  let label = c.label('s');
  c.filters.push(`${head}${fit}setsar=1,fps=${fps},format=yuv420p,settb=AVTB[${label}]`);
  // LUT, mixed with the original below full intensity (docs/design/editor.md#luts)
  const lut = s.item.lut;
  if (lut) {
    const file = `lut3d=file='${escapeFilterValue(c.opts.inputPath(lut.media))}':interp=trilinear`;
    const out = c.label('l');
    if (lut.intensity >= 0.999) c.filters.push(`[${label}]${file}[${out}]`);
    else {
      const [a, b, l] = [c.label('la'), c.label('lb'), c.label('ll')];
      c.filters.push(
        `[${label}]split=2[${a}][${b}]`,
        `[${b}]${file}[${l}]`,
        `[${l}][${a}]blend=all_mode=normal:all_opacity=${n(lut.intensity)}[${out}]`,
      );
    }
    label = out;
  }
  const e = s.effects;
  if (e && (e.brightness !== undefined || e.contrast !== undefined || e.saturation !== undefined)) {
    const out = c.label('e');
    c.filters.push(
      `[${label}]eq=brightness=${n(e.brightness ?? 0)}:contrast=${n(e.contrast ?? 1)}:saturation=${n(e.saturation ?? 1)}[${out}]`,
    );
    label = out;
  }
  // The matte as alpha, seeked and timed like the picture, inside its own range
  const mask = s.item.mask;
  const matteEnd = mask ? mask.offset + (mask.media.durationSec ?? Number.POSITIVE_INFINITY) : 0;
  if (mask && !still && part.srcIn >= mask.offset - EPS && part.srcOut <= matteEnd + 0.05) {
    const m = c.args.filter((a) => a === '-i').length;
    const mIn = part.srcIn - mask.offset;
    const mOut = part.srcOut - mask.offset;
    const seek = Math.max(0, mIn - SEEK_MARGIN);
    c.args.push('-ss', n(seek), '-t', n(mOut - seek + 0.25), '-i', c.opts.inputPath(mask.media));
    const [matte, out] = [c.label('m'), c.label('a')];
    const mfit = s.crop
      ? `${cropFilter(s.crop, width / height, part.srcIn, s.speed)},scale=${width}:${height},`
      : mode === 'letterbox'
        ? `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black,`
        : `scale=${fitted.w}:${fitted.h},`;
    c.filters.push(
      `[${m}:v]trim=start=${n(mIn - seek)}:end=${n(mOut - seek)},${timing(s, part)},${mfit}setsar=1,fps=${fps},format=gray${mask.invert ? ',negate' : ''}[${matte}]`,
      `[${label}][${matte}]alphamerge[${out}]`,
    );
    return { label: out, alpha: true };
  }
  return { label, alpha: false };
}

/** `setpts` for a constant speed, or the ramp's time map inverted (source → item time) as an expression. */
function timing(s: VideoSegment, part: ReturnType<typeof partOf>): string {
  if (!s.item.ramp) return `setpts=(PTS-STARTPTS)/${n(s.speed)}`;
  const slice = sliceTimeMap(timeMapOf(s.item), part.from - s.start, part.to - s.start);
  const inverse = slice.map(([l, src]) => [src, l] as [number, number]);
  return `setpts='(${linearExpression(inverse, '(T-STARTT)')})/TB'`;
}

/**
 * Transform steps of a picture in chunk time (docs/design/editor.md#multitrack-transforms-and-keyframes): scale,
 * rotation and opacity; returns the stream and the overlay position expressions.
 */
function transformStream(
  c: ChainContext,
  s: VideoSegment,
  input: string,
  shift: number,
  fades: boolean,
  part: ReturnType<typeof partOf>,
): { label: string; x: string; y: string } {
  const tr = s.item.transform;
  const fitted = fittedSize(s.media, !!s.crop, c.width, c.height);
  const steps: string[] = ['format=rgba'];
  const scaleCurve = propertyCurve(tr, 'scale');
  if (scaleCurve && isAnimated(tr, 'scale')) {
    const e = linearExpression(scaleCurve, 't', shift);
    steps.push(
      `scale=w='max(2\\,trunc(${fitted.w}*(${e})/2)*2)':h='max(2\\,trunc(${fitted.h}*(${e})/2)*2)':eval=frame`,
    );
  } else if (scaleCurve && Math.abs(scaleCurve[0]![1] - 1) > 1e-6) {
    const k = scaleCurve[0]![1];
    steps.push(
      `scale=${Math.max(2, even(Math.round(fitted.w * k)))}:${Math.max(2, even(Math.round(fitted.h * k)))}`,
    );
  }
  const rotCurve = propertyCurve(tr, 'rotation');
  if (rotCurve?.some(([, v]) => Math.abs(v) > 1e-6)) {
    const maxScale = Math.max(1, ...(scaleCurve ?? [[0, 1]]).map(([, v]) => v));
    const side = even(Math.ceil(Math.hypot(fitted.w * maxScale, fitted.h * maxScale)) + 2);
    steps.push(`rotate=a='(${linearExpression(rotCurve, 't', shift)})*PI/180':c=none:ow=${side}:oh=${side}`);
  }
  // Opacity: constant, or a command per frame while it changes (keyframes, and an overlay's fades)
  const duration = s.end - s.start;
  const fadeOf = fades ? { fadeIn: s.fadeIn, fadeOut: s.fadeOut } : {};
  const frames = Math.max(1, Math.round(part.d * c.fps));
  // Frame i of the part is at item time (part.from − start) + i/fps
  const values = Array.from({ length: frames }, (_, i) =>
    opacityAt(tr, fadeOf, duration, Math.min(duration, part.from - s.start + i / c.fps)),
  );
  const first = values[0]!;
  if (values.every((v) => Math.abs(v - first) < 1e-3)) {
    if (first < 0.999) steps.push(`colorchannelmixer=aa=${n(first)}`);
  } else {
    const name = c.label('op');
    const path = c.opts.textPath(c.files.length);
    const t0 = part.from - s.start - shift;
    let last = Number.NaN;
    const lines: string[] = [];
    values.forEach((v, i) => {
      if (Math.abs(v - last) < 1e-3) return;
      lines.push(`${n(t0 + i / c.fps)} colorchannelmixer@${name} aa ${n(v)};`);
      last = v;
    });
    c.files.push({ path, content: `${lines.join('\n')}\n` });
    steps.push(`sendcmd=f='${escapeFilterValue(path)}'`, `colorchannelmixer@${name}=aa=${n(first)}`);
  }
  const out = c.label('t');
  c.filters.push(`[${input}]${steps.join(',')}[${out}]`);
  const xCurve = propertyCurve(tr, 'x') ?? [[0, 0.5]];
  const yCurve = propertyCurve(tr, 'y') ?? [[0, 0.5]];
  return {
    label: out,
    x: `'W*(${linearExpression(xCurve, 't', shift)})-w/2'`,
    y: `'H*(${linearExpression(yCurve, 't', shift)})-h/2'`,
  };
}

/** The video graph of one chunk (video only; the soundtrack is separate). */
export function chunkGraph(t: Timeline, chunk: RenderChunk, opts: ChunkGraphOptions): ChunkGraph {
  const { width, height } = renderSize(t, opts.quality);
  const fps = t.fps;
  const len = chunk.frames / fps;
  const all = videoSegments(t);
  const inChunk = all
    .map((s, k) => ({ s, prev: all[k - 1] }))
    .filter(({ s }) => s.start < chunk.end - EPS && s.end > chunk.start + EPS);
  let next = 0;
  const c: ChainContext = {
    args: [],
    filters: [],
    files: [],
    opts,
    fps,
    width,
    height,
    label: (base) => `${base}${next++}`,
  };
  const local = inChunk.map(({ s, prev }, k) => {
    const part = partOf(s, Math.max(s.start, chunk.start), Math.min(s.end, chunk.end));
    const shaped = !isIdentity(s.item.transform) || !!s.item.mask;
    const stream = segmentStream(c, s, part, shaped ? 'fitted' : 'letterbox');
    let chain = `[${stream.label}]`;
    if (shaped) {
      // A transformed or masked primary picture, over black at the output size; `t` is the part's time here.
      const shift = part.from - s.start;
      const tr = transformStream(c, s, stream.label, shift, false, part);
      const bg = c.label('bg');
      const over = c.label('ov');
      c.filters.push(
        `color=c=black:s=${width}x${height}:r=${fps}:d=${n(part.d)},format=yuv420p,settb=AVTB[${bg}]`,
        `[${bg}][${tr.label}]overlay=x=${tr.x}:y=${tr.y}:eval=frame:format=auto:shortest=1,format=yuv420p,settb=AVTB[${over}]`,
      );
      chain = `[${over}]`;
    }
    const whole = { start: Math.abs(part.from - s.start) < EPS, end: Math.abs(part.to - s.end) < EPS };
    const fades: string[] = [];
    if (s.fadeIn > 0 && whole.start) fades.push(`fade=t=in:st=0:d=${n(Math.min(s.fadeIn, part.d))}`);
    if (s.fadeOut > 0 && whole.end)
      fades.push(`fade=t=out:st=${n(Math.max(0, part.d - s.fadeOut))}:d=${n(Math.min(s.fadeOut, part.d))}`);
    c.filters.push(`${chain}${fades.length ? fades.join(',') : 'null'}[v${k}]`);
    const transition = k > 0 && s.transitionIn && prev && whole.start ? s.transitionIn : null;
    return { from: part.from, to: part.to, d: part.d, transition };
  });
  const filters = c.filters;
  let acc = 'v0';
  let accDur = local[0]?.d ?? 0;
  for (let k = 1; k < local.length; k++) {
    const cur = local[k]!;
    const out = `x${k}`;
    if (cur.transition) {
      const overlap = Math.max(0, local[k - 1]!.to - cur.from);
      const D = Math.min(overlap > EPS ? overlap : cur.transition.duration, accDur, cur.d);
      const offset = Math.max(0, accDur - D);
      filters.push(
        `[${acc}][v${k}]xfade=transition=${XFADE[cur.transition.type] ?? 'fade'}:duration=${n(D)}:offset=${n(offset)}[${out}]`,
      );
      accDur = offset + cur.d;
    } else {
      filters.push(`[${acc}][v${k}]concat=n=2:v=1:a=0[${out}]`);
      accDur += cur.d;
    }
    acc = out;
  }
  if (!local.length) {
    filters.push(`color=c=black:s=${width}x${height}:r=${fps}:d=${n(len)},format=yuv420p,settb=AVTB[base]`);
    acc = 'base';
    accDur = len;
  }
  if (len - accDur > 1 / fps / 2) {
    // tpad counts frames (stop=N): its stop_duration needs a frame rate that concat/xfade outputs lack
    filters.push(
      `[${acc}]tpad=stop_mode=add:stop=${Math.ceil((len - accDur) * fps) + 1}:color=black[padded]`,
    );
    acc = 'padded';
  }
  // Overlay tracks, bottom first, over the picture; `t` is chunk time (docs/design/editor.md#multitrack-transforms-and-keyframes)
  for (const { segments } of overlaySegments(t)) {
    for (const s of segments) {
      if (!(s.start < chunk.end - EPS && s.end > chunk.start + EPS)) continue;
      const part = partOf(s, Math.max(s.start, chunk.start), Math.min(s.end, chunk.end));
      const stream = segmentStream(c, s, part, 'fitted');
      const offset = part.from - chunk.start;
      const placed = c.label('p');
      filters.push(`[${stream.label}]setpts=PTS-STARTPTS+${n(offset)}/TB[${placed}]`);
      const tr = transformStream(c, s, placed, chunk.start - s.start, true, part);
      const out = c.label('o');
      filters.push(
        `[${acc}][${tr.label}]overlay=x=${tr.x}:y=${tr.y}:eval=frame:eof_action=pass:format=auto:` +
          `enable='between(t\\,${n(offset)}\\,${n(offset + part.d)})',format=yuv420p[${out}]`,
      );
      acc = out;
    }
  }
  const textFiles: ChunkGraph['textFiles'] = c.files;
  let drawn = textFiles.length;
  for (const item of textItems(t)) {
    // One drawtext per frame of the item: the whole text, or each word of an animated caption.
    for (const frame of textFrames(item)) {
      const a = Math.max(0, item.start + frame.start - chunk.start);
      const b = Math.min(len, item.start + frame.end - chunk.start);
      if (b <= a + EPS) continue;
      const k = drawn++;
      const path = opts.textPath(k);
      textFiles.push({ path, content: frame.text });
      // A brand font is a render input (docs/design/brand-kits.md); else the bundled DejaVu Sans
      const fontPath = item.style.font ? opts.inputPath(item.style.font.media) : opts.fontFile;
      const font = fontPath ? `fontfile='${escapeFilterValue(fontPath)}':` : '';
      const color = item.style.color ?? '#ffffff';
      const box =
        item.style.box === null
          ? 'box=0'
          : `box=1:boxcolor=${item.style.box ?? 'black'}@${n(item.style.boxOpacity ?? 0.45)}:boxborderw=${textPad(item, height)}`;
      filters.push(
        `[${acc}]drawtext=${font}textfile='${escapeFilterValue(path)}':fontsize=${textSize(item, height)}:fontcolor=${color}:` +
          `x=${textX(item)}:y=${textY(item)}:${box}:` +
          `enable='between(t\\,${n(a)}\\,${n(b)})'[t${k}]`,
      );
      acc = `t${k}`;
    }
  }
  // Exactly `frames` frames: pad two clones (rounding can leave a chunk a frame short), renumber the timestamps
  // by frame index (an fps filter here would drop the last frame at EOF), and cut by frame count.
  filters.push(
    `[${acc}]tpad=stop_mode=clone:stop=2,setpts=N/(${fps}*TB),trim=end_frame=${chunk.frames},format=yuv420p[vout]`,
  );
  return {
    args: [...c.args, '-filter_complex', filters.join(';'), '-map', '[vout]'],
    textFiles,
    frames: chunk.frames,
    size: { width, height },
  };
}

/** Encoder options of a chunk rendered by the ffmpeg engine (an intermediate: the server re-encodes). */
export function chunkEncodeArgs(quality: ExportQuality): string[] {
  const crf = { draft: 18, standard: 16, high: 14 }[quality];
  return [
    '-an',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-crf',
    String(crf),
    '-pix_fmt',
    'yuv420p',
    '-movflags',
    '+faststart',
  ];
}

export function atempoChain(speed: number): string {
  if (Math.abs(speed - 1) < 1e-6) return '';
  const parts: string[] = [];
  let s = speed;
  while (s < 0.5) {
    parts.push('atempo=0.5');
    s /= 0.5;
  }
  parts.push(`atempo=${n(s)}`);
  return `${parts.join(',')},`;
}

export interface SoundtrackGraph {
  /** Inputs, `-filter_complex` and `-map [aout]`: append the encoder options and the mix's output path. */
  args: string[];
  durationSec: number;
  /** With `stems`: the label of each stem's output, mapped to its own file (`stemOutputArgs`). */
  stems: Record<AudioRole, string> | null;
}

/**
 * The soundtrack of the whole film (as long as the video: `totalFrames / fps`). Each stem is mixed on its own bus,
 * the music bus is ducked under speech, and the buses are summed (docs/design/post-audio.md#stems).
 */
export function soundtrackGraph(t: Timeline, opts: GraphInput & { stems?: boolean }): SoundtrackGraph {
  const len = totalFrames(t) / t.fps;
  const audio = audioSegments(t).filter((a) => a.media.hasAudio !== false);
  const args: string[] = [];
  const af: string[] = [];
  audio.forEach((a, k) => {
    const seek = Math.max(0, a.in - SEEK_MARGIN);
    args.push('-ss', n(seek), '-t', n(a.out - seek + 0.1), '-i', opts.inputPath(a.media));
    const d = (a.out - a.in) / a.speed;
    const delay = Math.max(0, Math.round(a.start * 1000));
    let chain = `[${k}:a]atrim=start=${n(a.in - seek)}:end=${n(a.out - seek)},asetpts=PTS-STARTPTS,${atempoChain(a.speed)}aformat=sample_rates=48000:channel_layouts=stereo,volume=${n(a.volume)}`;
    if (a.fadeIn > 0) chain += `,afade=t=in:st=0:d=${n(Math.min(a.fadeIn, d))}`;
    if (a.fadeOut > 0)
      chain += `,afade=t=out:st=${n(Math.max(0, d - a.fadeOut))}:d=${n(Math.min(a.fadeOut, d))}`;
    chain += `,adelay=${delay}|${delay}[a${k}]`;
    af.push(chain);
  });
  const silence = `anullsrc=r=48000:cl=stereo,atrim=0:${n(len)}`;
  const duck = duckEnvelope(t);
  const buses: string[] = [];
  const stems: Partial<Record<AudioRole, string>> = {};
  for (const role of AUDIO_ROLES) {
    const ks = audio.flatMap((a, k) => (a.role === role ? [k] : []));
    if (!ks.length) {
      if (opts.stems) {
        af.push(`${silence}[stem_${role}]`);
        stems[role] = `stem_${role}`;
      }
      continue;
    }
    let chain =
      ks.length === 1
        ? `[a${ks[0]}]apad,atrim=0:${n(len)}`
        : `${ks.map((k) => `[a${k}]`).join('')}amix=inputs=${ks.length}:normalize=0:dropout_transition=0,apad,atrim=0:${n(len)}`;
    // 10 ms frames: `eval=frame` steps the gain once per frame, so the ramps stay smooth.
    if (role === 'music' && duck)
      chain += `,asetnsamples=n=480:p=0,volume='${duckExpression(duck)}':eval=frame`;
    if (opts.stems) {
      af.push(`${chain},asplit=2[bus_${role}][stem_${role}]`);
      stems[role] = `stem_${role}`;
    } else af.push(`${chain}[bus_${role}]`);
    buses.push(`bus_${role}`);
  }
  if (buses.length === 0) af.push(`${silence}[aout]`);
  else if (buses.length === 1) af.push(`[${buses[0]}]anull[aout]`);
  else
    af.push(
      `${buses.map((b) => `[${b}]`).join('')}amix=inputs=${buses.length}:normalize=0:dropout_transition=0[aout]`,
    );
  return {
    args: [...args, '-filter_complex', af.join(';'), '-map', '[aout]'],
    durationSec: len,
    stems: opts.stems ? (stems as Record<AudioRole, string>) : null,
  };
}

/**
 * The staged soundtrack and stems are lossless: `export.finish` normalizes their loudness and encodes the
 * deliverables (docs/design/post-audio.md#loudness).
 */
export function soundtrackEncodeArgs(): string[] {
  return ['-vn', '-c:a', 'flac', '-sample_fmt', 's16', '-ar', '48000'];
}

export const SOUNDTRACK_FILE = 'soundtrack.flac';
export const stemFile = (role: AudioRole) => `stem-${role}.flac`;

/** The outputs of the stems after the mix's: `-map [stem_role] <encoder> <path>` for each stem. */
export function stemOutputArgs(g: SoundtrackGraph, path: (role: AudioRole) => string): string[] {
  if (!g.stems) return [];
  return AUDIO_ROLES.flatMap((role) => [
    '-map',
    `[${g.stems![role]}]`,
    ...soundtrackEncodeArgs(),
    path(role),
  ]);
}

/** Every distinct media file a render reads. */
export function renderInputs(t: Timeline): MediaRef[] {
  const seen = new Map<string, MediaRef>();
  for (const s of [...videoSegments(t), ...overlaySegments(t).flatMap((o) => o.segments)]) {
    seen.set(s.media.hash, s.media);
    if (s.item.lut) seen.set(s.item.lut.media.hash, s.item.lut.media);
    if (s.item.mask) seen.set(s.item.mask.media.hash, s.item.mask.media);
  }
  for (const item of textItems(t))
    if (item.style.font) seen.set(item.style.font.media.hash, item.style.font.media);
  for (const a of audioSegments(t)) if (a.media.hasAudio !== false) seen.set(a.media.hash, a.media);
  return [...seen.values()];
}
