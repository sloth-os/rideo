import { join } from 'node:path';
import {
  AUDIO_ROLES,
  type AudioRole,
  type ExportLoudness,
  type LoudnessTarget,
  loudnormFilter,
  parseLoudnorm,
  SILENCE_LUFS,
} from '@rideo/shared';
import { AppError } from '../errors';
import type { Metrics } from '../metrics';
import type { Ffmpeg } from './ffmpeg';

const lossless = ['-ar', '48000', '-ac', '2', '-c:a', 'pcm_s24le'];
const round2 = (v: number) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : null);

/**
 * Loudness normalization of a rendered soundtrack and its stems (docs/design/post-audio.md#loudness): a measuring
 * `loudnorm` pass, then a linear pass with the measured values. Stems get the mix's gain so they still sum to it.
 * Returns 24-bit WAV files to encode and publish.
 */
export async function normalizeSoundtrack(
  deps: { ff: Ffmpeg; metrics?: Metrics },
  input: {
    soundtrack: string;
    stems: Record<AudioRole, string> | null;
    target: LoudnessTarget;
    dir: string;
    signal?: AbortSignal;
  },
): Promise<{ audio: string; loudness: ExportLoudness; stems: Record<AudioRole, string> | null }> {
  const audio = join(input.dir, 'soundtrack-final.wav');
  const off = (mode: ExportLoudness['mode'], inputLufs: number | null = null): ExportLoudness => ({
    target: input.target,
    mode,
    integratedLufs: null,
    truePeakDb: null,
    lra: null,
    inputLufs,
  });
  let loudness: ExportLoudness;
  let gainDb = 0;
  try {
    if (input.target === 'off') {
      await deps.ff.run(['-i', input.soundtrack, ...lossless, audio], { signal: input.signal });
      loudness = off('off');
    } else {
      const measured = parseLoudnorm(
        await deps.ff.run(['-i', input.soundtrack, '-af', loudnormFilter(input.target), '-f', 'null', '-'], {
          signal: input.signal,
          logLevel: 'info',
        }),
      );
      if (!measured) throw new AppError('media_error', 'the loudness measurement printed no statistics');
      if (!(measured.inputI > SILENCE_LUFS)) {
        await deps.ff.run(['-i', input.soundtrack, ...lossless, audio], { signal: input.signal });
        loudness = off('silent', round2(measured.inputI));
      } else {
        const applied = parseLoudnorm(
          await deps.ff.run(
            ['-i', input.soundtrack, '-af', loudnormFilter(input.target, measured), ...lossless, audio],
            { signal: input.signal, logLevel: 'info' },
          ),
        );
        if (!applied) throw new AppError('media_error', 'the loudness normalization printed no statistics');
        gainDb = applied.outputI - measured.inputI;
        loudness = {
          target: input.target,
          mode: applied.type ?? 'dynamic',
          integratedLufs: round2(applied.outputI),
          truePeakDb: round2(applied.outputTp),
          lra: round2(applied.outputLra),
          inputLufs: round2(measured.inputI),
        };
      }
    }
    let stems: Record<AudioRole, string> | null = null;
    if (input.stems) {
      stems = {} as Record<AudioRole, string>;
      for (const role of AUDIO_ROLES) {
        const out = join(input.dir, `stem-${role}.wav`);
        const gain = Number.isFinite(gainDb) ? Math.round(gainDb * 100) / 100 : 0;
        await deps.ff.run(['-i', input.stems[role], '-af', `volume=${gain}dB`, ...lossless, out], {
          signal: input.signal,
        });
        stems[role] = out;
      }
    }
    deps.metrics?.postAudio.inc({ op: 'loudness', outcome: loudness.mode });
    return { audio, loudness, stems };
  } catch (err) {
    deps.metrics?.postAudio.inc({ op: 'loudness', outcome: 'error' });
    throw err;
  }
}
