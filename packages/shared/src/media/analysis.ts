import type { TimeRange } from '../schemas/common';
import type { AnalysisSignals } from '../schemas/editor';

const num = (s: string | undefined) => (s === undefined ? Number.NaN : Number.parseFloat(s));
const round = (v: number) => Math.round(v * 1000) / 1000;

/**
 * Turns the log of `analysisCommand` into signals. Scene cuts come from showinfo lines (frames that passed the
 * scene filter); loudness is the last `Summary:` block (FFmpeg 5 also prints an empty one when the graph is
 * reconfigured). Scenes shorter than 0.5 s merge into the previous scene.
 */
export function parseAnalysisLog(log: string | readonly string[], durationSec: number): AnalysisSignals {
  const lines = typeof log === 'string' ? log.split('\n') : log;
  const cuts: number[] = [];
  const blacks: TimeRange[] = [];
  const silences: TimeRange[] = [];
  let silenceStart: number | null = null;
  let loudness: number | null = null;
  let inSummary = false;
  for (const line of lines) {
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
    } else if (inSummary && /^(?:\w+: )?\s*I:\s*(-?[\d.]+) LUFS/.test(line)) {
      loudness = num(/I:\s*(-?[\d.]+)/.exec(line)?.[1]);
      inSummary = false;
    }
  }
  if (silenceStart !== null && durationSec > silenceStart)
    silences.push({ start: Math.max(0, silenceStart), end: durationSec });

  const boundaries = [0, ...cuts.filter((t) => t < durationSec - 0.2).sort((a, b) => a - b), durationSec];
  const scenes: TimeRange[] = [];
  for (let i = 0; i < boundaries.length - 1; i++) {
    const start = boundaries[i]!;
    const end = boundaries[i + 1]!;
    if (end - start < 0.5 && scenes.length) scenes[scenes.length - 1]!.end = round(end);
    else if (end > start) scenes.push({ start: round(start), end: round(end) });
  }
  if (!scenes.length && durationSec > 0) scenes.push({ start: 0, end: round(durationSec) });
  return {
    scenes,
    silences: silences.map((r) => ({ start: round(r.start), end: round(r.end) })),
    blackSegments: blacks.map((r) => ({ start: round(r.start), end: round(r.end) })),
    loudness:
      loudness !== null && Number.isFinite(loudness) && loudness > -70 ? { integratedLufs: loudness } : null,
  };
}

/** Which scenes get a thumbnail (at most `max`, spread evenly) and where (the scene's midpoint). */
export function thumbnailPicks(
  scenes: readonly TimeRange[],
  max: number,
): { sceneIndex: number; at: number }[] {
  if (max <= 0 || scenes.length === 0) return [];
  const idx =
    scenes.length <= max
      ? scenes.map((_, i) => i)
      : Array.from({ length: max }, (_, i) => Math.floor((i * scenes.length) / max));
  return [...new Set(idx)].map((i) => ({
    sceneIndex: i,
    at: round((scenes[i]!.start + scenes[i]!.end) / 2),
  }));
}
