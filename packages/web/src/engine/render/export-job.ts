import {
  AUDIO_ROLES,
  type AudioRole,
  chunkGraph,
  ExportRenderParamsSchema,
  type ExportRenderResult,
  type MediaRef,
  planAudioWindows,
  planChunks,
  renderInputs,
  renderSize,
  soundtrackPiece,
  stemPiece,
  type Timeline,
  totalFrames,
  withBrand,
  withDisclosure,
} from '@rideo/shared';
import { detectCaps } from '../../features/editor/engine/capabilities';
import { gpuRenderer } from '../../features/editor/engine/gpu-choice';
import { MediaPool } from '../../features/editor/engine/media-pool';
import { api } from '../../lib/api';
import { recordTiming } from '../../lib/telemetry';
import { webCodecsCanDecode } from '../codecs';
import type { EditorJobContext } from '../context';
import { ensureVideoFont } from '../fonts';
import { inputName, mediaBlob } from '../media-files';
import { chooseEngine, partName } from './engine-choice';
import { renderChunkFfmpeg, renderSoundtrack } from './ffmpeg-engine';
import { renderChunkWebCodecs } from './webcodecs-engine';

/**
 * `export.render` (docs/design/editor.md#rendering): plan the chunks, render and upload each one that is not
 * staged yet (a resumed job skips them), then the soundtrack's windows the same way. Each graph loads only the media
 * it reads, and its output is uploaded as bytes (docs/design/editor.md#memory). The server's `export.finish` joins
 * the soundtrack and watermarks the result.
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
  const windows = planAudioWindows(timeline);
  const fps = timeline.fps;
  const total = totalFrames(timeline);
  // The soundtrack's share of the progress, after the frames
  const audioShare = Math.ceil(total / 20);
  let framesDone = 0;
  const report = (frames: number, message: string) =>
    ctx.progress(framesDone + frames, total + audioShare, message);
  // The media one graph reads, loaded for it alone
  const load = (label: string) => async (media: MediaRef[]) => {
    const inputs: Record<string, Blob> = {};
    for (const [i, m] of media.entries()) {
      report(0, `${label}: loading media ${i + 1}/${media.length}`);
      inputs[inputName(m)] = await mediaBlob(ctx.projectId, m, ctx.signal);
    }
    return inputs;
  };
  const pool = engine === 'webcodecs' ? new MediaPool(ctx.projectId, size) : null;
  // WebCodecs renders composite on the GPU when this browser has one (docs/design/engine-performance.md)
  const gpu = engine === 'webcodecs' ? await gpuRenderer() : null;
  let compositor: 'webgpu' | 'canvas' | null = engine === 'webcodecs' ? (gpu ? 'webgpu' : 'canvas') : null;
  const parts: string[] = [];
  try {
    if (engine === 'webcodecs') await ensureVideoFont();
    for (const chunk of chunks) {
      const chunkStarted = performance.now();
      const name = partName(chunk.index, engine, ext);
      parts.push(name);
      if (ctx.job.staged.includes(name)) {
        framesDone += chunk.frames;
        continue;
      }
      const label = `chunk ${chunk.index + 1}/${chunks.length} (${engine})`;
      // Only the sources this chunk shows stay open (docs/design/editor.md#memory)
      pool?.retain(
        new Set(
          chunkGraph(timeline, chunk, {
            quality: params.quality,
            inputPath: (m) => m.path,
            textPath: String,
          }).media.map((m) => m.hash),
        ),
      );
      const blob =
        engine === 'ffmpeg'
          ? await renderChunkFfmpeg({
              timeline,
              chunk,
              quality: params.quality,
              load: load(label),
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
      recordTiming('export_chunk', (performance.now() - chunkStarted) / 1000);
    }
    // The soundtrack (and stems) a window at a time (docs/design/editor.md#soundtrack)
    framesDone = total;
    for (const w of windows) {
      const files = [
        soundtrackPiece(w.index),
        ...(params.stems ? AUDIO_ROLES.map((r) => stemPiece(r, w.index)) : []),
      ];
      if (files.every((f) => ctx.job.staged.includes(f))) continue;
      const label = `${params.stems ? 'soundtrack and stems' : 'soundtrack'}${windows.length > 1 ? ` ${w.index + 1}/${windows.length}` : ''}`;
      report(Math.floor((audioShare * w.index) / windows.length), label);
      const audio = await renderSoundtrack({
        timeline,
        window: w,
        stems: params.stems,
        load: load(label),
        signal: ctx.signal,
      });
      await ctx.upload(soundtrackPiece(w.index), audio.soundtrack);
      if (audio.stems)
        for (const role of AUDIO_ROLES) await ctx.upload(stemPiece(role, w.index), audio.stems[role]);
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
    soundtrack: windows.map((w) => soundtrackPiece(w.index)),
    stems: params.stems
      ? (Object.fromEntries(
          AUDIO_ROLES.map((role) => [role, windows.map((w) => stemPiece(role, w.index))]),
        ) as Record<AudioRole, string[]>)
      : null,
  };
}
