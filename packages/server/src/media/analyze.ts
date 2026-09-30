import type { TimeRange } from '@rideo/shared';
import type { Ffmpeg, ProbeResult } from './ffmpeg';

export interface MediaAnalysis {
  scenes: TimeRange[];
  silences: TimeRange[];
  blackSegments: TimeRange[];
  loudnessLufs: number | null;
}

const num = (s: string | undefined) => (s === undefined ? Number.NaN : Number.parseFloat(s));

/** One ffmpeg pass: scene changes (select+showinfo), black (blackdetect), silence and loudness (ebur128). */
export async function analyzeMedia(
  ff: Ffmpeg,
  input: string,
  probe: ProbeResult,
  opts: { sceneThreshold?: number; signal?: AbortSignal } = {},
): Promise<MediaAnalysis> {
  const duration = probe.durationSec;
  const args = ['-i', input];
  if (probe.hasVideo) {
    args.push(
      '-vf',
      `scale=320:-2,blackdetect=d=0.3:pix_th=0.10,select='gt(scene\\,${opts.sceneThreshold ?? 0.3})',showinfo`,
    );
  } else {
    args.push('-vn');
  }
  if (probe.hasAudio) args.push('-af', 'silencedetect=noise=-35dB:d=0.6,ebur128=framelog=verbose');
  else args.push('-an');
  args.push('-f', 'null', '-');
  const log = await ff.run(args, { signal: opts.signal, logLevel: 'info' });

  const cuts: number[] = [];
  const blacks: TimeRange[] = [];
  const silences: TimeRange[] = [];
  let silenceStart: number | null = null;
  let loudness: number | null = null;
  let inSummary = false;
  for (const line of log.split('\n')) {
    if (line.includes('Parsed_showinfo') && line.includes('pts_time:')) {
      const t = num(/pts_time:\s*([\d.]+)/.exec(line)?.[1]);
      if (Number.isFinite(t) && t > 0.2) cuts.push(t);
    } else if (line.includes('black_start:')) {
      const s = num(/black_start:\s*([\d.]+)/.exec(line)?.[1]);
      const e = num(/black_end:\s*([\d.]+)/.exec(line)?.[1]);
      if (Number.isFinite(s) && Number.isFinite(e)) blacks.push({ start: s, end: e });
    } else if (line.includes('silence_start:')) {
      silenceStart = num(/silence_start:\s*(-?[\d.]+)/.exec(line)?.[1]);
    } else if (line.includes('silence_end:')) {
      const e = num(/silence_end:\s*([\d.]+)/.exec(line)?.[1]);
      if (silenceStart !== null && Number.isFinite(e))
        silences.push({ start: Math.max(0, silenceStart), end: e });
      silenceStart = null;
    } else if (line.includes('Summary:')) {
      inSummary = true;
    } else if (inSummary && /^\s*I:\s*(-?[\d.]+) LUFS/.test(line)) {
      loudness = num(/I:\s*(-?[\d.]+)/.exec(line)?.[1]);
      inSummary = false;
    }
  }
  if (silenceStart !== null && duration > silenceStart)
    silences.push({ start: Math.max(0, silenceStart), end: duration });

  const boundaries = [0, ...cuts.filter((t) => t < duration - 0.2).sort((a, b) => a - b), duration];
  const scenes: TimeRange[] = [];
  for (let i = 0; i < boundaries.length - 1; i++) {
    const start = boundaries[i]!;
    const end = boundaries[i + 1]!;
    if (end - start < 0.5 && scenes.length) scenes[scenes.length - 1]!.end = end;
    else scenes.push({ start: round(start), end: round(end) });
  }
  if (!scenes.length && duration > 0) scenes.push({ start: 0, end: round(duration) });
  return {
    scenes,
    silences: silences.map((r) => ({ start: round(r.start), end: round(r.end) })),
    blackSegments: blacks.map((r) => ({ start: round(r.start), end: round(r.end) })),
    loudnessLufs: loudness !== null && Number.isFinite(loudness) && loudness > -70 ? loudness : null,
  };
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}
