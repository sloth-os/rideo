import { existsSync } from 'node:fs';
import {
  audioSegments,
  type Export,
  type TextItem,
  type Timeline,
  textItems,
  timelineDuration,
  videoSegments,
} from '@rideo/shared';

const FONT_CANDIDATES = [
  '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
  '/usr/share/fonts/dejavu/DejaVuSans.ttf',
  '/usr/share/fonts/TTF/DejaVuSans.ttf',
  '/Library/Fonts/Arial.ttf',
  '/System/Library/Fonts/Supplemental/Arial.ttf',
];

export function resolveFont(configured?: string): string | undefined {
  if (configured && existsSync(configured)) return configured;
  return FONT_CANDIDATES.find((p) => existsSync(p));
}

export const QUALITY: Record<Export['quality'], { preset: string; crf: number; maxHeight?: number }> = {
  draft: { preset: 'veryfast', crf: 26, maxHeight: 720 },
  standard: { preset: 'medium', crf: 20 },
  high: { preset: 'slow', crf: 17 },
};

const XFADE: Record<string, string> = { crossfade: 'fade', wipe: 'wipeleft', dip_to_black: 'fadeblack' };

const n = (v: number) => (Math.round(v * 1000) / 1000).toString();
const even = (v: number) => Math.max(2, v - (v % 2));

/** Escapes a value for use inside an ffmpeg filter option. */
export function escapeFilterValue(v: string): string {
  return v
    .replace(/\\/g, '\\\\')
    .replace(/:/g, '\\:')
    .replace(/'/g, "\\'")
    .replace(/,/g, '\\,')
    .replace(/;/g, '\\;');
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

export interface RenderPlan {
  width: number;
  height: number;
  fps: number;
  durationSec: number;
  totalFrames: number;
  /** ffmpeg args that write raw yuv420p frames to stdout. */
  videoArgs: string[];
  /** ffmpeg args that render the mixed soundtrack to `audioOut`. */
  audioArgs: (audioOut: string) => string[];
  /** Text files the drawtext filters read (write before running). */
  textFiles: { path: string; content: string }[];
}

export interface RenderPlanInput {
  timeline: Timeline;
  /** Local file per media hash. */
  inputs: Map<string, string>;
  quality: Export['quality'];
  textDir: string;
  fontFile?: string;
}

function textY(item: TextItem): string {
  const pos = item.style.position ?? (item.style.preset === 'title' ? 'center' : 'bottom');
  if (item.style.preset === 'lower_third') return 'h*0.72';
  if (pos === 'top') return 'h*0.08';
  if (pos === 'center') return '(h-text_h)/2';
  return 'h-text_h-h*0.08';
}

function textSize(item: TextItem, height: number): number {
  if (item.style.size) return item.style.size;
  return Math.round(
    height / (item.style.preset === 'title' ? 10 : item.style.preset === 'lower_third' ? 18 : 22),
  );
}

/** Timeline → one ffmpeg video filtergraph + one audio mix (docs/design/editor.md#server-render-ffmpeg). */
export function buildRenderPlan(input: RenderPlanInput): RenderPlan {
  const t = input.timeline;
  const q = QUALITY[input.quality];
  let width = even(t.width);
  let height = even(t.height);
  if (q.maxHeight && height > q.maxHeight) {
    width = even(Math.round((width * q.maxHeight) / height));
    height = q.maxHeight;
  }
  const fps = t.fps;
  const duration = Math.max(0.5, timelineDuration(t));
  const segs = videoSegments(t);
  const vArgs: string[] = [];
  const filters: string[] = [];
  const pathOf = (hash: string) => {
    const p = input.inputs.get(hash);
    if (!p) throw new Error(`no local file for media ${hash.slice(0, 12)}`);
    return p;
  };
  for (const s of segs) vArgs.push('-i', pathOf(s.media.hash));
  const durations = segs.map((s) => (s.out - s.in) / s.speed);
  segs.forEach((s, k) => {
    const d = durations[k]!;
    let chain =
      `[${k}:v]trim=start=${n(s.in)}:end=${n(s.out)},setpts=(PTS-STARTPTS)/${n(s.speed)},` +
      `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black,` +
      // settb: concat outputs AV_TIME_BASE, and xfade needs both inputs on the same timebase
      `setsar=1,fps=${fps},format=yuv420p,settb=AVTB`;
    const e = s.effects;
    if (e && (e.brightness !== undefined || e.contrast !== undefined || e.saturation !== undefined)) {
      chain += `,eq=brightness=${n(e.brightness ?? 0)}:contrast=${n(e.contrast ?? 1)}:saturation=${n(e.saturation ?? 1)}`;
    }
    if (s.fadeIn > 0) chain += `,fade=t=in:st=0:d=${n(Math.min(s.fadeIn, d))}`;
    if (s.fadeOut > 0)
      chain += `,fade=t=out:st=${n(Math.max(0, d - s.fadeOut))}:d=${n(Math.min(s.fadeOut, d))}`;
    filters.push(`${chain}[v${k}]`);
  });
  let acc = 'v0';
  let accDur = durations[0] ?? 0;
  for (let k = 1; k < segs.length; k++) {
    const s = segs[k]!;
    const out = `x${k}`;
    if (s.transitionIn) {
      const D = Math.min(s.transitionIn.duration, accDur, durations[k]!);
      const offset = Math.max(0, accDur - D);
      filters.push(
        `[${acc}][v${k}]xfade=transition=${XFADE[s.transitionIn.type] ?? 'fade'}:duration=${n(D)}:offset=${n(offset)}[${out}]`,
      );
      accDur = offset + durations[k]!;
    } else {
      filters.push(`[${acc}][v${k}]concat=n=2:v=1:a=0[${out}]`);
      accDur += durations[k]!;
    }
    acc = out;
  }
  if (!segs.length) {
    filters.push(`color=c=black:s=${width}x${height}:r=${fps}:d=${n(duration)},format=yuv420p[base]`);
    acc = 'base';
    accDur = duration;
  }
  if (duration - accDur > 1 / fps) {
    filters.push(`[${acc}]tpad=stop_mode=add:stop_duration=${n(duration - accDur)}:color=black[padded]`);
    acc = 'padded';
  }
  const textFiles: RenderPlan['textFiles'] = [];
  textItems(t).forEach((item, i) => {
    const path = `${input.textDir}/text-${i}.txt`;
    textFiles.push({ path, content: item.text });
    const font = input.fontFile ? `fontfile='${escapeFilterValue(input.fontFile)}':` : '';
    const color = item.style.color ?? '#ffffff';
    filters.push(
      `[${acc}]drawtext=${font}textfile='${escapeFilterValue(path)}':fontsize=${textSize(item, height)}:fontcolor=${color}:` +
        `x=(w-text_w)/2:y=${textY(item)}:box=1:boxcolor=black@0.45:boxborderw=${Math.round(height / 60)}:` +
        `enable='between(t\\,${n(item.start)}\\,${n(item.start + item.duration)})'[t${i}]`,
    );
    acc = `t${i}`;
  });
  // fps: snap AV_TIME_BASE timestamps back onto the frame grid so the trim yields exactly totalFrames
  filters.push(`[${acc}]fps=${fps},trim=duration=${n(duration)},format=yuv420p[vout]`);
  const videoArgs = [
    ...vArgs,
    '-filter_complex',
    filters.join(';'),
    '-map',
    '[vout]',
    '-f',
    'rawvideo',
    '-pix_fmt',
    'yuv420p',
    '-',
  ];

  const audio = audioSegments(t).filter((a) => a.media.hasAudio !== false && input.inputs.has(a.media.hash));
  const audioArgs = (audioOut: string): string[] => {
    const args: string[] = [];
    const af: string[] = [];
    for (const a of audio) args.push('-i', pathOf(a.media.hash));
    audio.forEach((a, k) => {
      const d = (a.out - a.in) / a.speed;
      const delay = Math.max(0, Math.round(a.start * 1000));
      let chain = `[${k}:a]atrim=start=${n(a.in)}:end=${n(a.out)},asetpts=PTS-STARTPTS,${atempoChain(a.speed)}aformat=sample_rates=48000:channel_layouts=stereo,volume=${n(a.volume)}`;
      if (a.fadeIn > 0) chain += `,afade=t=in:st=0:d=${n(Math.min(a.fadeIn, d))}`;
      if (a.fadeOut > 0)
        chain += `,afade=t=out:st=${n(Math.max(0, d - a.fadeOut))}:d=${n(Math.min(a.fadeOut, d))}`;
      chain += `,adelay=${delay}|${delay}[a${k}]`;
      af.push(chain);
    });
    if (audio.length === 0) af.push(`anullsrc=r=48000:cl=stereo,atrim=0:${n(duration)}[aout]`);
    else if (audio.length === 1) af.push(`[a0]apad,atrim=0:${n(duration)}[aout]`);
    else
      af.push(
        `${audio.map((_, k) => `[a${k}]`).join('')}amix=inputs=${audio.length}:normalize=0:dropout_transition=0,apad,atrim=0:${n(duration)}[aout]`,
      );
    return [
      ...args,
      '-filter_complex',
      af.join(';'),
      '-map',
      '[aout]',
      '-c:a',
      'aac',
      '-b:a',
      '192k',
      audioOut,
    ];
  };
  return {
    width,
    height,
    fps,
    durationSec: duration,
    totalFrames: Math.round(duration * fps),
    videoArgs,
    audioArgs,
    textFiles,
  };
}
