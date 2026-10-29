import { readFile, stat } from 'node:fs/promises';
import {
  absentCast,
  type Character,
  type ConsistencyReport,
  compactIdentity,
  type Shot,
  type TakeWatch,
  takeWatchOf,
  watchVerdict,
  withWatch,
} from '@rideo/shared';
import type { LlmTasks } from '../ai/tasks';
import type { Ffmpeg } from '../media/ffmpeg';
import type { Metrics } from '../metrics';

/**
 * The whole-take watch of the gate (docs/design/ai-review.md#takes-watched-whole): the vision model watches a take
 * from its first frame to its last, with the shot as planned and the cast's references.
 */

/** The largest take sent inline (models take base64 video under 10 MB, docs/design/ai-gateway.md). */
const WATCH_MAX_BYTES = 7 * 1024 * 1024;

export type WatchResult = { watch: TakeWatch; issues: string[] };

/** The take as the watcher gets it: 480p H.264 without sound (the listener hears it), a few hundred kilobytes. */
export async function watchClip(
  ff: Ffmpeg,
  video: string,
  out: string,
  signal?: AbortSignal,
): Promise<Buffer> {
  const encode = (height: number, crf: number) =>
    ff.run(
      [
        '-i',
        video,
        '-vf',
        `scale=-2:${height}`,
        '-an',
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        '-crf',
        String(crf),
        '-pix_fmt',
        'yuv420p',
        '-movflags',
        '+faststart',
        out,
      ],
      { signal },
    );
  await encode(480, 28);
  if ((await stat(out)).size > WATCH_MAX_BYTES) await encode(360, 34);
  return readFile(out);
}

/**
 * What the take looks like watched whole, or null when it could not be watched (no model takes video, the call failed
 * or the answer was unusable): a watch that did not happen holds nothing back.
 */
export async function watchTake(input: {
  llm: LlmTasks;
  ff: Ffmpeg;
  /** The take's video file. */
  video: string;
  /** Where the small copy for the model is written. */
  clip: string;
  shot: Shot;
  /** The shot's characters, in order, and the cast's first reference of each (PNG). */
  characters: Character[];
  references: Map<string, Buffer[]>;
  /** The clip's cast who are not in this shot, by name. */
  offscreen: string[];
  allCharacters: Record<string, Character>;
  place: string;
  castOnly: boolean;
  durationSec: number;
  qualityThreshold: number;
  metrics?: Metrics;
  log?: { info: (o: unknown, m?: string) => void; warn: (o: unknown, m?: string) => void };
  signal?: AbortSignal;
}): Promise<WatchResult | null> {
  if (!input.llm.watcher) return null;
  try {
    const video = await watchClip(input.ff, input.video, input.clip, input.signal);
    const camera = [
      input.shot.camera.framing.replace(/_/g, ' '),
      input.shot.camera.move?.replace(/_/g, ' ') ?? input.shot.camera.movement.replace(/_/g, ' '),
      input.shot.camera.lensMm ? `${input.shot.camera.lensMm} mm` : '',
    ]
      .filter(Boolean)
      .join(', ');
    const { out, via, model } = await input.llm.watchTake(
      {
        shot: {
          description: input.shot.description,
          action: input.shot.action,
          camera,
          durationSec: input.shot.durationSec,
          place: input.place,
          endState: input.shot.endState,
        },
        cast: input.characters.map((c) => ({ name: c.name, look: compactIdentity(c, input.shot) })),
        absent: absentCast(input.offscreen, input.allCharacters),
        castOnly: input.castOnly,
        watching: 'video',
        durationSec: input.durationSec,
      },
      input.characters.flatMap((c) => {
        const ref = input.references.get(c.id)?.[0];
        return ref ? [{ name: c.name, data: ref }] : [];
      }),
      video,
      input.signal,
    );
    const watch = takeWatchOf(out, {
      model,
      via,
      qualityThreshold: input.qualityThreshold,
      at: new Date().toISOString(),
    });
    input.metrics?.takeWatches.inc({ model: via, result: watch.passed ? 'passed' : 'failed' });
    input.metrics?.takeWatchScore.observe({}, watch.overall);
    input.metrics?.qualityChecks.inc({ check: 'watch', result: watch.passed ? 'passed' : 'failed' });
    return { watch, issues: watchVerdict(out, input.qualityThreshold).issues };
  } catch (err) {
    if (input.signal?.aborted) throw err;
    input.metrics?.takeWatches.inc({ model: input.llm.watcher ?? 'none', result: 'error' });
    input.metrics?.qualityChecks.inc({ check: 'watch', result: 'error' });
    input.log?.warn(
      { err: (err as Error).message.slice(0, 500) },
      'whole-take watch failed; the take is not held back',
    );
    return null;
  }
}

/** The report with the whole-take watch merged into its quality (unchanged without a watch). */
export function withWatchResult(report: ConsistencyReport, result: WatchResult | null): ConsistencyReport {
  return result ? { ...report, quality: withWatch(report.quality, result.watch, result.issues) } : report;
}
