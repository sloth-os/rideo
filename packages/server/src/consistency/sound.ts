import { readFile } from 'node:fs/promises';
import {
  type Character,
  type ConsistencyReport,
  type Shot,
  SoundCheckOutputSchema,
  type SoundReport,
  soundVerdict,
  voicePhrase,
  withSound,
} from '@rideo/shared';
import type { LlmTasks } from '../ai/tasks';
import type { Ffmpeg } from '../media/ffmpeg';
import type { Metrics } from '../metrics';

/**
 * The sound check of the gate (docs/design/continuity.md#quality-checks-in-the-gate): the audio-visual model watches a
 * take with its sound, and `soundVerdict` compares what it heard with the shot's lines.
 */

export type SoundVerdict = { passed: boolean; sound: SoundReport; issues: string[] };

/** The take as the audio-visual model gets it: 360p H.264 with mono AAC, a few hundred kilobytes for a shot. */
export async function takeClip(
  ff: Ffmpeg,
  video: string,
  out: string,
  signal?: AbortSignal,
): Promise<Buffer> {
  await ff.run(
    [
      '-i',
      video,
      '-vf',
      'scale=-2:360',
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '30',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-b:a',
      '64k',
      '-ac',
      '1',
      '-movflags',
      '+faststart',
      out,
    ],
    { signal },
  );
  return readFile(out);
}

/** The lines a take should speak: the shot's voiced lines with their speakers' names. */
export function spokenLines(
  shot: Shot,
  characters: Record<string, Character>,
): { character: string; line: string }[] {
  return shot.dialogue.flatMap((d) =>
    d.characterId && d.line.trim()
      ? [{ character: characters[d.characterId]?.name ?? 'Someone', line: d.line }]
      : [],
  );
}

/** A take without a sound track speaks none of its lines. */
export function silentTakeVerdict(lines: { character: string; line: string }[]): SoundVerdict {
  const v = soundVerdict({ lines, heard: SoundCheckOutputSchema.parse({}), musicAllowed: true, cast: [] });
  return { ...v, issues: ['the take has no sound, so its lines are not heard', ...v.issues] };
}

/**
 * What the take sounds like, or null when the check could not be made (no verdict holds a take back: the call failed
 * or the model's answer was unusable).
 */
export async function checkSound(input: {
  llm: LlmTasks;
  ff: Ffmpeg;
  /** The raw take (with its sound track). */
  video: string;
  /** Where the small copy for the model is written. */
  clip: string;
  shot: Shot;
  characters: Record<string, Character>;
  place: string;
  /** The take should speak the shot's lines (dialogue mode `off` with sound, or `native`). */
  voiced: boolean;
  /** Takes may carry music. */
  musicAllowed: boolean;
  metrics?: Metrics;
  log?: { info: (o: unknown, m?: string) => void; warn: (o: unknown, m?: string) => void };
  signal?: AbortSignal;
}): Promise<SoundVerdict | null> {
  const lines = input.voiced ? spokenLines(input.shot, input.characters) : [];
  const cast = input.shot.characterIds.flatMap((id) => (input.characters[id] ? [input.characters[id]!] : []));
  const voiceOf = (who: string) => {
    const c = cast.find((x) => x.name === who) ?? Object.values(input.characters).find((x) => x.name === who);
    return c ? voicePhrase(c) : 'a natural voice';
  };
  try {
    const video = await takeClip(input.ff, input.video, input.clip, input.signal);
    const heard = await input.llm.checkSound(
      {
        shot: {
          description: input.shot.description,
          action: input.shot.action,
          place: input.place,
          durationSec: input.shot.durationSec,
        },
        lines: lines.map((l) => ({ ...l, voice: voiceOf(l.character) })),
        cast: cast.map((c) => ({ name: c.name, voice: voicePhrase(c) })),
        music: input.musicAllowed,
      },
      video,
      input.signal,
    );
    const verdict = soundVerdict({
      lines,
      heard,
      musicAllowed: input.musicAllowed,
      cast: Object.values(input.characters).map((c) => c.name),
    });
    input.metrics?.qualityChecks.inc({ check: 'sound', result: verdict.passed ? 'passed' : 'failed' });
    return verdict;
  } catch (err) {
    if (input.signal?.aborted) throw err;
    input.metrics?.qualityChecks.inc({ check: 'sound', result: 'error' });
    input.log?.warn(
      { err: (err as Error).message.slice(0, 500) },
      'sound check failed; the take is not held back',
    );
    return null;
  }
}

/** The report with the sound check merged into its quality (unchanged without a verdict). */
export function withSoundVerdict(report: ConsistencyReport, verdict: SoundVerdict | null): ConsistencyReport {
  return verdict ? { ...report, quality: withSound(report.quality, verdict) } : report;
}
