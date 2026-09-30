import {
  ExportRenderParamsSchema,
  type ExportRenderResult,
  planChunks,
  renderInputs,
  renderSize,
  type Timeline,
  totalFrames,
} from '@rideo/shared';
import { detectCaps } from '../../features/editor/engine/capabilities';
import { MediaPool } from '../../features/editor/engine/media-pool';
import { api } from '../../lib/api';
import { webCodecsCanDecode } from '../codecs';
import type { EditorJobContext } from '../context';
import { ensureVideoFont } from '../fonts';
import { inputName, mediaBlob } from '../media-files';
import { chooseEngine, partName } from './engine-choice';
import { renderChunkFfmpeg, renderSoundtrack } from './ffmpeg-engine';
import { renderChunkWebCodecs } from './webcodecs-engine';

/**
 * `export.render` (docs/design/editor.md#rendering): plan the chunks, render and upload each one that is not
 * staged yet (a resumed job skips them), then the soundtrack. The server's `export.finish` watermarks the result.
 */
export async function exportRenderJob(ctx: EditorJobContext): Promise<ExportRenderResult> {
  const params = ExportRenderParamsSchema.parse(ctx.job.params);
  const timeline = params.timelineCommit
    ? await api.doc<Timeline>(ctx.projectId, 'timeline.json', params.timelineCommit)
    : await api.timeline(ctx.projectId);
  const size = renderSize(timeline, params.quality);
  const sources = renderInputs(timeline);
  const caps = await detectCaps(size.width, size.height);
  const engine = await chooseEngine(params.engine, caps, sources, webCodecsCanDecode);
  const ext = engine === 'ffmpeg' ? 'mp4' : (caps.container ?? 'mp4');
  const chunks = planChunks(timeline, { targetSec: params.chunkSec });
  const fps = timeline.fps;
  const total = totalFrames(timeline);
  let framesDone = 0;
  const report = (frames: number, message: string) =>
    ctx.progress(framesDone + frames, total + Math.ceil(total / 20), message);

  const inputs: Record<string, Blob> = {};
  const loadInputs = async () => {
    for (const [i, m] of sources.entries()) {
      if (inputs[inputName(m)]) continue;
      ctx.progress(0, total, `loading media ${i + 1}/${sources.length}`);
      inputs[inputName(m)] = await mediaBlob(ctx.projectId, m, ctx.signal);
    }
  };
  const pool = engine === 'webcodecs' ? new MediaPool(ctx.projectId, size) : null;
  const parts: string[] = [];
  try {
    if (engine === 'ffmpeg') await loadInputs();
    else await ensureVideoFont();
    for (const chunk of chunks) {
      const name = partName(chunk.index, engine, ext);
      parts.push(name);
      if (ctx.job.staged.includes(name)) {
        framesDone += chunk.frames;
        continue;
      }
      const label = `chunk ${chunk.index + 1}/${chunks.length} (${engine})`;
      const blob =
        engine === 'ffmpeg'
          ? await renderChunkFfmpeg({
              timeline,
              chunk,
              quality: params.quality,
              inputs,
              signal: ctx.signal,
              onTime: (t) => report(Math.min(chunk.frames, Math.round(t * fps)), label),
            })
          : await renderChunkWebCodecs({
              timeline,
              chunk,
              size,
              caps,
              pool: pool!,
              signal: ctx.signal,
              onFrame: (f) => report(f, label),
            });
      await ctx.upload(name, blob);
      framesDone += chunk.frames;
      report(0, label);
    }
    if (!ctx.job.staged.includes('soundtrack.m4a')) {
      await loadInputs();
      report(0, 'soundtrack');
      await ctx.upload('soundtrack.m4a', await renderSoundtrack({ timeline, inputs, signal: ctx.signal }));
    }
  } finally {
    pool?.dispose();
  }
  return {
    engine,
    codec: engine === 'ffmpeg' ? 'h264' : caps.video!,
    ...size,
    fps,
    durationSec: total / fps,
    parts,
    soundtrack: 'soundtrack.m4a',
  };
}
