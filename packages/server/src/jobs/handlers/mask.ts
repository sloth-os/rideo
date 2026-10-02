import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ItemMask, VideoItem } from '@rideo/shared';
import { notFound } from '../../errors';
import type { JobContext } from '../queue';
import { docsFor, gatewayOptions, type HandlerDeps } from './common';

/** Seconds of source around the item the matte also covers, so small trims keep it. */
const MARGIN = 1;

/**
 * `mask.generate` (docs/design/editor.md#segmentation-masks-remove-the-background): the item's source range, cut on
 * the server, goes to the segmentation model; its matte (normalized to grayscale H.264) becomes the item's mask in one
 * `set_mask` commit.
 */
export async function maskGenerate(deps: HandlerDeps, ctx: JobContext) {
  const { itemId, subject, invert, model } = ctx.job.params as {
    itemId: string;
    subject: string;
    invert: boolean;
    model: string;
  };
  const projectId = ctx.job.projectId;
  const docs = await docsFor(deps, ctx);
  const item = docs.timeline?.tracks
    .filter((t) => t.kind === 'video')
    .flatMap((t) => t.items)
    .find((i) => i.id === itemId) as VideoItem | undefined;
  if (!item) throw notFound(`video item ${itemId}`);
  const media = item.source.media;
  const from = Math.max(0, item.in - MARGIN);
  const to =
    media.durationSec !== undefined ? Math.min(media.durationSec, item.out + MARGIN) : item.out + MARGIN;
  try {
    return await deps.media.withTmpDir(async (dir) => {
      ctx.progress(0, 3, 'cutting the source range');
      const local = await deps.media.localPath(projectId, media);
      const range = join(dir, 'range.mp4');
      await deps.ff.run(
        [
          '-ss',
          String(from),
          '-t',
          String(to - from),
          '-i',
          local,
          '-an',
          '-c:v',
          'libx264',
          '-preset',
          'veryfast',
          '-crf',
          '18',
          '-pix_fmt',
          'yuv420p',
          range,
        ],
        { signal: ctx.signal },
      );
      ctx.progress(1, 3, `asking ${model} for a matte of ${subject}`);
      const task = await deps.gateway.generateVideo(
        {
          model,
          input: [
            {
              type: 'text',
              text: `Segment ${subject}: return a matte, white where ${subject} is and black elsewhere, frame for frame.`,
            },
            {
              type: 'video',
              uri: `data:video/mp4;base64,${(await readFile(range)).toString('base64')}`,
              role: 'reference_video',
            },
          ],
          parameters: { include_audio: false },
        },
        gatewayOptions(ctx, 'video', 'mask'),
      );
      const raw = join(dir, 'matte-raw.mp4');
      await deps.media.downloadTo(task.outputs![0]!.uri, raw, ctx.signal);
      // The matte's luma is the alpha: grayscale, the size and length of the range
      const matte = join(dir, 'matte.mp4');
      await deps.ff.run(
        [
          '-i',
          raw,
          '-t',
          String(to - from),
          '-vf',
          `scale=${media.width ?? -2}:${media.height ?? -2},format=gray,format=yuv420p`,
          '-an',
          '-c:v',
          'libx264',
          '-preset',
          'veryfast',
          '-crf',
          '12',
          matte,
        ],
        { signal: ctx.signal },
      );
      ctx.progress(2, 3, 'storing the matte');
      const stored = await deps.media.putFile(projectId, matte, {
        kind: 'masks',
        name: `${item.label ?? 'item'}-matte`,
        mime: 'video/mp4',
      });
      const mask: ItemMask = { media: stored, offset: from, subject, invert, model: task.model ?? model };
      await deps.services.edit.applyOps(ctx.actor, projectId, [{ op: 'set_mask', itemId, mask }]);
      deps.metrics.masks.inc({ outcome: 'ok' });
      deps.log.info({ projectId, jobId: ctx.job.id, itemId, model, seconds: to - from }, 'matte applied');
      return { itemId, mask: stored.path, model: mask.model };
    });
  } catch (err) {
    deps.metrics.masks.inc({ outcome: 'failed' });
    throw err;
  }
}
