import {
  chunkEncodeArgs,
  chunkGraph,
  type ExportQuality,
  type RenderChunk,
  soundtrackEncodeArgs,
  soundtrackGraph,
  type Timeline,
} from '@rideo/shared';
import { FONT_PATH, ffmpeg } from '../ffmpeg';
import { inputName } from '../media-files';

const inputPath = (m: { hash: string; path: string }) => `/in/${inputName(m)}`;

/** One chunk with the shared filtergraph → H.264 in MP4 (an intermediate; the server re-encodes). */
export async function renderChunkFfmpeg(opts: {
  timeline: Timeline;
  chunk: RenderChunk;
  quality: ExportQuality;
  inputs: Record<string, Blob>;
  signal?: AbortSignal;
  onTime?: (sec: number) => void;
}): Promise<Blob> {
  const g = chunkGraph(opts.timeline, opts.chunk, {
    quality: opts.quality,
    inputPath,
    fontFile: FONT_PATH,
    textPath: (i) => `/text/t${i}.txt`,
  });
  const out = '/out/part.mp4';
  const r = await ffmpeg.run([...g.args, ...chunkEncodeArgs(opts.quality), out], {
    inputs: opts.inputs,
    files: Object.fromEntries(g.textFiles.map((f) => [f.path, f.content])),
    outputs: [out],
    signal: opts.signal,
    onTime: opts.onTime,
  });
  return new Blob([r.outputs[out]! as BlobPart], { type: 'video/mp4' });
}

/** The whole film's soundtrack → AAC (both engines use it). */
export async function renderSoundtrack(opts: {
  timeline: Timeline;
  inputs: Record<string, Blob>;
  signal?: AbortSignal;
  onTime?: (sec: number) => void;
}): Promise<Blob> {
  const s = soundtrackGraph(opts.timeline, { inputPath });
  const out = '/out/soundtrack.m4a';
  const r = await ffmpeg.run([...s.args, ...soundtrackEncodeArgs(), out], {
    inputs: opts.inputs,
    outputs: [out],
    signal: opts.signal,
    onTime: opts.onTime,
  });
  return new Blob([r.outputs[out]! as BlobPart], { type: 'audio/mp4' });
}
