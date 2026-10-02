import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Resource } from '@rideo/shared';
import type { JobContext } from '../queue';
import type { HandlerDeps } from './common';

/** A performance ready for the model (docs/design/performance.md#a-performance-on-a-shot). */
export interface PreparedPerformance {
  path: string;
  uri: string;
  durationSec: number;
  hasAudio: boolean;
}

/**
 * The performance as the model's reference video: H.264 and AAC at the project's frame rate (recorders write WebM
 * with variable frame rates and no length), trimmed to the take's length.
 */
export async function preparePerformance(
  deps: HandlerDeps,
  ctx: JobContext,
  input: { resource: Resource; maxSec: number; fps: number; dir: string },
): Promise<PreparedPerformance> {
  const local = await deps.media.localPath(ctx.job.projectId, input.resource.media);
  const out = join(input.dir, 'performance.mp4');
  await deps.ff.run(
    [
      '-i',
      local,
      '-t',
      String(input.maxSec),
      '-map',
      '0:v:0',
      '-map',
      '0:a:0?',
      '-r',
      String(input.fps),
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '20',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-b:a',
      '160k',
      '-movflags',
      '+faststart',
      out,
    ],
    { signal: ctx.signal },
  );
  const probe = await deps.ff.probe(out);
  return {
    path: out,
    uri: `data:video/mp4;base64,${(await readFile(out)).toString('base64')}`,
    durationSec: probe.durationSec,
    hasAudio: probe.hasAudio,
  };
}

/** The performer's sound on the take, padded with silence to the picture's length. */
export async function withPerformanceSound(
  deps: HandlerDeps,
  ctx: JobContext,
  input: { video: string; performance: PreparedPerformance; dir: string },
): Promise<string> {
  const out = join(input.dir, 'performed.mp4');
  await deps.ff.run(
    [
      '-i',
      input.video,
      '-i',
      input.performance.path,
      '-filter_complex',
      '[1:a:0]apad[a]',
      '-map',
      '0:v:0',
      '-map',
      '[a]',
      '-c:v',
      'copy',
      '-c:a',
      'aac',
      '-b:a',
      '192k',
      '-shortest',
      out,
    ],
    { signal: ctx.signal },
  );
  return out;
}
