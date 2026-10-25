import { parseSceneScores, parseSignalLog, TEMPORAL_SCAN_SCORE } from '@rideo/shared';
import type { Ffmpeg } from './ffmpeg';

/**
 * Scene scores inside one take (docs/design/continuity.md#quality-checks-in-the-gate): a single shot should change
 * smoothly, so a high score is a stray cut, a pop or a morph.
 */
export async function sceneChanges(
  ff: Ffmpeg,
  input: string,
  opts: { threshold?: number; width?: number; signal?: AbortSignal } = {},
): Promise<{ t: number; score: number }[]> {
  const log = await ff.run(
    [
      '-i',
      input,
      '-an',
      '-vf',
      `scale=${opts.width ?? 320}:-2,select='gt(scene,${opts.threshold ?? TEMPORAL_SCAN_SCORE})',metadata=print`,
      '-f',
      'null',
      '-',
    ],
    { signal: opts.signal, logLevel: 'info' },
  );
  return parseSceneScores(log);
}

/**
 * The signal pass over a finished film (docs/design/feedback.md#how-a-film-is-watched): black and frozen stretches,
 * scene changes and long silences, in one decode at 320 px.
 */
export async function exportSignals(
  ff: Ffmpeg,
  input: string,
  durationSec: number,
  opts: { hasAudio: boolean; signal?: AbortSignal },
): Promise<ReturnType<typeof parseSignalLog>> {
  const log = await ff.run(
    [
      '-i',
      input,
      '-vf',
      "scale=320:-2,blackdetect=d=0.5:pix_th=0.10,freezedetect=n=0.003:d=1.5,select='gt(scene,0.4)',metadata=print",
      ...(opts.hasAudio ? ['-af', 'silencedetect=noise=-50dB:d=3'] : ['-an']),
      '-f',
      'null',
      '-',
    ],
    { signal: opts.signal, logLevel: 'info', timeoutMs: 60 * 60_000 },
  );
  return parseSignalLog(log, durationSec);
}
