import {
  AUDIO_ROLES,
  ExportRenderParamsSchema,
  type ExportRenderResult,
  planChunks,
  renderInputs,
  renderSize,
  SOUNDTRACK_FILE,
  stemFile,
  type Timeline,
  totalFrames,
  withBrand,
  withDisclosure,
} from '@rideo/shared';
import { detectCaps } from '../../features/editor/engine/capabilities';
import { gpuRenderer } from '../../features/editor/engine/gpu-choice';
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
  // The disclosure label is drawn into the picture (docs/design/provenance.md#disclosure-label).
  // The cut or the storyboard's animatic (docs/design/storyboard.md#animatic), at the requested commit.
  // ...and the brand bug (docs/design/brand-kits.md#a-projects-brand).
  const timeline = withBrand(
    withDisclosure(
      params.timelineCommit || params.timelinePath !== 'timeline.json'
        ? await api.doc<Timeline>(ctx.projectId, params.timelinePath, params.timelineCommit ?? undefined)
        : await api.timeline(ctx.projectId),
      params.disclosure,
    ),
    params.bug,
    !!params.bug,
  );
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
  // WebCodecs renders composite on the GPU when this browser has one (docs/design/engine-performance.md)
  const gpu = engine === 'webcodecs' ? await gpuRenderer() : null;
  let compositor: 'webgpu' | 'canvas' | null = engine === 'webcodecs' ? (gpu ? 'webgpu' : 'canvas') : null;
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
              gpu,
              signal: ctx.signal,
              onFrame: (f) => report(f, label),
              // a chunk the GPU could not finish was composited by the canvas
              onBackend: (b) => {
                if (b === 'canvas') compositor = 'canvas';
              },
            });
      await ctx.upload(name, blob);
      framesDone += chunk.frames;
      report(0, label);
    }
    const audioFiles = [SOUNDTRACK_FILE, ...(params.stems ? AUDIO_ROLES.map(stemFile) : [])];
    if (!audioFiles.every((f) => ctx.job.staged.includes(f))) {
      await loadInputs();
      report(0, params.stems ? 'soundtrack and stems' : 'soundtrack');
      const audio = await renderSoundtrack({ timeline, inputs, stems: params.stems, signal: ctx.signal });
      await ctx.upload(SOUNDTRACK_FILE, audio.soundtrack);
      if (audio.stems) for (const role of AUDIO_ROLES) await ctx.upload(stemFile(role), audio.stems[role]);
    }
  } finally {
    pool?.dispose();
  }
  return {
    engine,
    compositor,
    codec: engine === 'ffmpeg' ? 'h264' : caps.video!,
    ...size,
    fps,
    durationSec: total / fps,
    parts,
    soundtrack: SOUNDTRACK_FILE,
    stems: params.stems
      ? { dialogue: stemFile('dialogue'), music: stemFile('music'), effects: stemFile('effects') }
      : null,
  };
}
