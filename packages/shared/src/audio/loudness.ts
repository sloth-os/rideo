import type { LoudnessTarget } from '../schemas/job';

/** Loudness targets (docs/design/post-audio.md#loudness). LRA only bounds linear normalization (ffmpeg's max). */
export const LOUDNESS_TARGETS: Record<
  Exclude<LoudnessTarget, 'off'>,
  { integrated: number; truePeak: number; lra: number; label: string }
> = {
  streaming: { integrated: -14, truePeak: -1, lra: 20, label: 'Streaming (−14 LUFS)' },
  broadcast: { integrated: -23, truePeak: -1, lra: 20, label: 'Broadcast, EBU R128 (−23 LUFS)' },
};

/** Below this the soundtrack is treated as silent and left as it is. */
export const SILENCE_LUFS = -70;

export interface LoudnormStats {
  inputI: number;
  inputTp: number;
  inputLra: number;
  inputThresh: number;
  outputI: number;
  outputTp: number;
  outputLra: number;
  targetOffset: number;
  type: 'linear' | 'dynamic' | null;
}

const num = (v: unknown) => {
  const x = Number(v);
  return Number.isFinite(x) ? x : Number.NEGATIVE_INFINITY;
};

/** The JSON block `loudnorm=print_format=json` writes at the end of a run (null when absent). */
export function parseLoudnorm(log: string): LoudnormStats | null {
  const start = log.lastIndexOf('"input_i"');
  if (start < 0) return null;
  const open = log.lastIndexOf('{', start);
  const close = log.indexOf('}', start);
  if (open < 0 || close < 0) return null;
  let raw: Record<string, string>;
  try {
    raw = JSON.parse(log.slice(open, close + 1));
  } catch {
    return null;
  }
  const type = raw.normalization_type;
  return {
    inputI: num(raw.input_i),
    inputTp: num(raw.input_tp),
    inputLra: num(raw.input_lra),
    inputThresh: num(raw.input_thresh),
    outputI: num(raw.output_i),
    outputTp: num(raw.output_tp),
    outputLra: num(raw.output_lra),
    targetOffset: Number.isFinite(Number(raw.target_offset)) ? Number(raw.target_offset) : 0,
    type: type === 'linear' || type === 'dynamic' ? type : null,
  };
}

/**
 * The `loudnorm` filter: the measuring pass without `measured`, the linear normalization with the first pass's
 * values. Both print their statistics as JSON.
 */
export function loudnormFilter(target: Exclude<LoudnessTarget, 'off'>, measured?: LoudnormStats): string {
  const t = LOUDNESS_TARGETS[target];
  const base = `loudnorm=I=${t.integrated}:TP=${t.truePeak}:LRA=${t.lra}`;
  if (!measured) return `${base}:print_format=json`;
  return (
    `${base}:measured_I=${measured.inputI}:measured_TP=${measured.inputTp}:measured_LRA=${measured.inputLra}` +
    `:measured_thresh=${measured.inputThresh}:offset=${measured.targetOffset}:linear=true:print_format=json`
  );
}
