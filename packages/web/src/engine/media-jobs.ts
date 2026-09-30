import {
  AnalysisSignalsParamsSchema,
  type AnalysisSignalsResult,
  analysisCommand,
  docPath,
  MediaProcessParamsSchema,
  type MediaProcessResult,
  parseAnalysisLog,
  type Resource,
  speechCommand,
  thumbnailCommand,
  thumbnailPicks,
} from '@rideo/shared';
import { api } from '../lib/api';
import { type EditorJobContext, EditorJobError } from './context';
import { ffmpeg } from './ffmpeg';
import { mediaBlob } from './media-files';
import { prepareMedia } from './prepare';

async function resourceOf(ctx: EditorJobContext, resourceId: string): Promise<Resource> {
  return api.doc<Resource>(ctx.projectId, docPath.resource(resourceId));
}

/** `media.process`: probe + poster of an imported resource. */
export async function mediaProcessJob(ctx: EditorJobContext): Promise<MediaProcessResult> {
  const { resourceId } = MediaProcessParamsSchema.parse(ctx.job.params);
  const resource = await resourceOf(ctx, resourceId);
  ctx.progress(0.1, 1, `downloading ${resource.name}`);
  const blob = await mediaBlob(ctx.projectId, resource.media, ctx.signal);
  ctx.progress(0.5, 1, 'probing');
  const { probe, poster } = await prepareMedia(blob, { signal: ctx.signal });
  if (!probe) throw new EditorJobError('unsupported_media', `ffmpeg does not recognize ${resource.name}`);
  if (poster) await ctx.upload('poster.jpg', poster);
  return { probe, ...(poster ? { poster: 'poster.jpg' } : {}) };
}

/** `analysis.signals`: scenes, black, silences, loudness, scene thumbnails and speech audio (docs/design/editor.md#footage-analysis). */
export async function analysisSignalsJob(ctx: EditorJobContext): Promise<AnalysisSignalsResult> {
  const params = AnalysisSignalsParamsSchema.parse(ctx.job.params);
  const resource = await resourceOf(ctx, params.resourceId);
  ctx.progress(0.02, 1, `downloading ${resource.name}`);
  const src = await mediaBlob(ctx.projectId, resource.media, ctx.signal);
  const { probe } = await prepareMedia(src, { signal: ctx.signal, poster: false });
  if (!probe) throw new EditorJobError('unsupported_media', `ffmpeg does not recognize ${resource.name}`);
  const duration = Math.max(0.1, probe.durationSec);
  const run = await ffmpeg.run(analysisCommand('/in/src', probe), {
    inputs: { src },
    signal: ctx.signal,
    onTime: (t) =>
      ctx.progress(0.05 + 0.75 * Math.min(1, t / duration), 1, 'detecting scenes, silences and black frames'),
  });
  const signals = parseAnalysisLog(run.log, probe.durationSec);
  const thumbnails: AnalysisSignalsResult['thumbnails'] = [];
  const picks = thumbnailPicks(signals.scenes, params.maxThumbnails);
  for (const [i, pick] of picks.entries()) {
    ctx.progress(0.8 + (0.12 * i) / Math.max(1, picks.length), 1, 'scene thumbnails');
    const out = '/out/thumb.jpg';
    const r = await ffmpeg.run(thumbnailCommand('/in/src', pick.at, out), {
      inputs: { src },
      outputs: [out],
      signal: ctx.signal,
    });
    const name = `thumb-${pick.sceneIndex}.jpg`;
    await ctx.upload(name, new Blob([r.outputs[out]! as BlobPart], { type: 'image/jpeg' }));
    thumbnails.push({ ...pick, file: name });
  }
  let speech: string | undefined;
  if (params.speech && probe.hasAudio) {
    ctx.progress(0.93, 1, 'speech track');
    const out = '/out/speech.mp3';
    const r = await ffmpeg.run(speechCommand('/in/src', out), {
      inputs: { src },
      outputs: [out],
      signal: ctx.signal,
    });
    await ctx.upload('speech.mp3', new Blob([r.outputs[out]! as BlobPart], { type: 'audio/mpeg' }));
    speech = 'speech.mp3';
  }
  return { probe, signals, thumbnails, ...(speech ? { speech } : {}) };
}
