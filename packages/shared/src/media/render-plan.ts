import type { MediaRef } from '../schemas/common';
import type { ExportQuality } from '../schemas/job';
import type { TextItem, Timeline } from '../schemas/timeline';
import {
  audioSegments,
  isStillMedia,
  textItems,
  timelineDuration,
  type VideoSegment,
  videoSegments,
} from '../timeline/query';

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
  /** Files the drawtext filters read (write them before running). */
  textFiles: { path: string; content: string }[];
  frames: number;
  size: RenderSize;
}

export interface ChunkGraphOptions extends GraphInput {
  quality: ExportQuality;
  /** Path of the TTF used by drawtext (bundled DejaVu Sans). */
  fontFile?: string;
  /** Where the text of text item `i` is written. */
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

/** The video graph of one chunk (video only; the soundtrack is separate). */
export function chunkGraph(t: Timeline, chunk: RenderChunk, opts: ChunkGraphOptions): ChunkGraph {
  const { width, height } = renderSize(t, opts.quality);
  const fps = t.fps;
  const len = chunk.frames / fps;
  const all = videoSegments(t);
  const inChunk = all
    .map((s, k) => ({ s, prev: all[k - 1] }))
    .filter(({ s }) => s.start < chunk.end - EPS && s.end > chunk.start + EPS);
  const args: string[] = [];
  const filters: string[] = [];
  const local = inChunk.map(({ s, prev }, k) => {
    const from = Math.max(s.start, chunk.start);
    const to = Math.min(s.end, chunk.end);
    const srcIn = Math.min(s.out, s.in + (from - s.start) * s.speed);
    const srcOut = Math.min(s.out, s.in + (to - s.start) * s.speed);
    const d = to - from;
    let head: string;
    if (isStillMedia(s.media)) {
      // A still (storyboard frame): loop the image for the segment's part of the chunk.
      args.push('-loop', '1', '-framerate', String(fps), '-t', n(d + 0.25), '-i', opts.inputPath(s.media));
      head = `[${k}:v]trim=start=0:end=${n(d)},setpts=PTS-STARTPTS,`;
    } else {
      // Seek a second early and trim exactly: input seeking alone drops the frame that sits on the seek point.
      const seek = Math.max(0, srcIn - SEEK_MARGIN);
      args.push('-ss', n(seek), '-t', n(srcOut - seek + 0.25), '-i', opts.inputPath(s.media));
      head = `[${k}:v]trim=start=${n(srcIn - seek)}:end=${n(srcOut - seek)},setpts=(PTS-STARTPTS)/${n(s.speed)},`;
    }
    let chain =
      head +
      `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black,` +
      // settb: concat outputs AV_TIME_BASE, and xfade needs both inputs on the same timebase
      `setsar=1,fps=${fps},format=yuv420p,settb=AVTB`;
    const e = s.effects;
    if (e && (e.brightness !== undefined || e.contrast !== undefined || e.saturation !== undefined)) {
      chain += `,eq=brightness=${n(e.brightness ?? 0)}:contrast=${n(e.contrast ?? 1)}:saturation=${n(e.saturation ?? 1)}`;
    }
    const whole = { start: Math.abs(from - s.start) < EPS, end: Math.abs(to - s.end) < EPS };
    if (s.fadeIn > 0 && whole.start) chain += `,fade=t=in:st=0:d=${n(Math.min(s.fadeIn, d))}`;
    if (s.fadeOut > 0 && whole.end)
      chain += `,fade=t=out:st=${n(Math.max(0, d - s.fadeOut))}:d=${n(Math.min(s.fadeOut, d))}`;
    filters.push(`${chain}[v${k}]`);
    const transition = k > 0 && s.transitionIn && prev && whole.start ? s.transitionIn : null;
    return { from, to, d, transition };
  });
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
  const textFiles: ChunkGraph['textFiles'] = [];
  textItems(t).forEach((item, i) => {
    const a = Math.max(0, item.start - chunk.start);
    const b = Math.min(len, item.start + item.duration - chunk.start);
    if (b <= a + EPS) return;
    const path = opts.textPath(i);
    textFiles.push({ path, content: item.text });
    const font = opts.fontFile ? `fontfile='${escapeFilterValue(opts.fontFile)}':` : '';
    const color = item.style.color ?? '#ffffff';
    filters.push(
      `[${acc}]drawtext=${font}textfile='${escapeFilterValue(path)}':fontsize=${textSize(item, height)}:fontcolor=${color}:` +
        `x=${textX(item)}:y=${textY(item)}:box=1:boxcolor=black@0.45:boxborderw=${textPad(item, height)}:` +
        `enable='between(t\\,${n(a)}\\,${n(b)})'[t${i}]`,
    );
    acc = `t${i}`;
  });
  // Exactly `frames` frames: pad two clones (rounding can leave a chunk a frame short), renumber the timestamps
  // by frame index (an fps filter here would drop the last frame at EOF), and cut by frame count.
  filters.push(
    `[${acc}]tpad=stop_mode=clone:stop=2,setpts=N/(${fps}*TB),trim=end_frame=${chunk.frames},format=yuv420p[vout]`,
  );
  return {
    args: [...args, '-filter_complex', filters.join(';'), '-map', '[vout]'],
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

/** The soundtrack of the whole film (as long as the video: `totalFrames / fps`). */
export function soundtrackGraph(t: Timeline, opts: GraphInput): { args: string[]; durationSec: number } {
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
  if (audio.length === 0) af.push(`anullsrc=r=48000:cl=stereo,atrim=0:${n(len)}[aout]`);
  else if (audio.length === 1) af.push(`[a0]apad,atrim=0:${n(len)}[aout]`);
  else
    af.push(
      `${audio.map((_, k) => `[a${k}]`).join('')}amix=inputs=${audio.length}:normalize=0:dropout_transition=0,apad,atrim=0:${n(len)}[aout]`,
    );
  return { args: [...args, '-filter_complex', af.join(';'), '-map', '[aout]'], durationSec: len };
}

export function soundtrackEncodeArgs(): string[] {
  return ['-vn', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000'];
}

/** Every distinct media file a render reads. */
export function renderInputs(t: Timeline): MediaRef[] {
  const seen = new Map<string, MediaRef>();
  for (const s of videoSegments(t)) seen.set(s.media.hash, s.media);
  for (const a of audioSegments(t)) if (a.media.hasAudio !== false) seen.set(a.media.hash, a.media);
  return [...seen.values()];
}
