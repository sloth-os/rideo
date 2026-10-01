import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { type Ffmpeg, MediaError } from './ffmpeg';

/** Single frame at `atSec`, scaled to at most `maxWidth` (PNG). */
export async function extractFrame(
  ff: Ffmpeg,
  input: string,
  atSec: number,
  out: string,
  maxWidth?: number,
  signal?: AbortSignal,
): Promise<string> {
  const vf = maxWidth ? ['-vf', `scale='min(${maxWidth},iw)':-2`] : [];
  await ff.run(['-ss', Math.max(0, atSec).toFixed(3), '-i', input, '-frames:v', '1', ...vf, out], { signal });
  return out;
}

/** The last decodable frame at full resolution (continuity chaining). */
export async function extractLastFrame(
  ff: Ffmpeg,
  input: string,
  durationSec: number,
  fps: number,
  out: string,
  signal?: AbortSignal,
): Promise<string> {
  const back = Math.max(0.05, 2 / Math.max(1, fps));
  const tryRun = (args: string[]) =>
    ff.run(args, { signal }).then(
      () => existsSync(out),
      () => false,
    );
  // The sound can outlast the pictures (dialogue, provider padding): widen the window until a frame is found.
  for (const window of [back, 1, 3]) {
    if (
      await tryRun([
        '-sseof',
        `-${window.toFixed(3)}`,
        '-i',
        input,
        '-map',
        '0:v:0',
        '-update',
        '1',
        '-q:v',
        '1',
        out,
      ])
    )
      return out;
  }
  await ff.run(
    ['-ss', Math.max(0, durationSec - back).toFixed(3), '-i', input, '-map', '0:v:0', '-frames:v', '1', out],
    { signal },
  );
  if (!existsSync(out)) throw new MediaError(`no video frame near the end of ${input}`);
  return out;
}

export const JUDGE_SAMPLE_FRACTIONS = [0.15, 0.5, 0.85];

export async function sampleFrames(
  ff: Ffmpeg,
  input: string,
  durationSec: number,
  dir: string,
  prefix: string,
  opts: { fractions?: number[]; maxWidth?: number; signal?: AbortSignal } = {},
): Promise<string[]> {
  const fractions = opts.fractions ?? JUDGE_SAMPLE_FRACTIONS;
  const out: string[] = [];
  for (const [i, f] of fractions.entries()) {
    const path = join(dir, `${prefix}-${i}.png`);
    await extractFrame(ff, input, durationSec * f, path, opts.maxWidth ?? 512, opts.signal);
    // Past the pictures (the sound can be longer): step back until a frame exists.
    for (let at = durationSec * f - 0.5; !existsSync(path) && at >= 0; at -= 0.5)
      await extractFrame(ff, input, at, path, opts.maxWidth ?? 512, opts.signal);
    if (!existsSync(path)) throw new MediaError(`no video frame in ${input}`);
    out.push(path);
  }
  return out;
}

/** Converts/downscales any image to PNG (judge and gateway inputs). */
export async function toPng(
  ff: Ffmpeg,
  input: string,
  out: string,
  maxSide?: number,
  signal?: AbortSignal,
): Promise<string> {
  const vf = maxSide
    ? ['-vf', `scale='if(gt(iw,ih),min(${maxSide},iw),-2)':'if(gt(iw,ih),-2,min(${maxSide},ih))'`]
    : [];
  await ff.run(['-i', input, '-frames:v', '1', ...vf, out], { signal });
  return out;
}
