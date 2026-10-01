import {
  AUDIO_ROLES,
  type AudioRole,
  chunkEncodeArgs,
  chunkGraph,
  type ExportQuality,
  type RenderChunk,
  SOUNDTRACK_FILE,
  soundtrackEncodeArgs,
  soundtrackGraph,
  stemFile,
  stemOutputArgs,
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

/**
 * The whole film's soundtrack, lossless (both engines use it), and with `stems` the dialogue, music and effects
 * stems from the same run (docs/design/post-audio.md#stems). The server normalizes loudness and encodes.
 */
export async function renderSoundtrack(opts: {
  timeline: Timeline;
  inputs: Record<string, Blob>;
  stems?: boolean;
  signal?: AbortSignal;
  onTime?: (sec: number) => void;
}): Promise<{ soundtrack: Blob; stems: Record<AudioRole, Blob> | null }> {
  const s = soundtrackGraph(opts.timeline, { inputPath, stems: opts.stems });
  const out = `/out/${SOUNDTRACK_FILE}`;
  const stemPath = (role: AudioRole) => `/out/${stemFile(role)}`;
  const outputs = [out, ...(s.stems ? AUDIO_ROLES.map(stemPath) : [])];
  const r = await ffmpeg.run([...s.args, ...soundtrackEncodeArgs(), out, ...stemOutputArgs(s, stemPath)], {
    inputs: opts.inputs,
    outputs,
    signal: opts.signal,
    onTime: opts.onTime,
  });
  const blob = (path: string) => new Blob([r.outputs[path]! as BlobPart], { type: 'audio/flac' });
  return {
    soundtrack: blob(out),
    stems: s.stems
      ? (Object.fromEntries(AUDIO_ROLES.map((role) => [role, blob(stemPath(role))])) as Record<
          AudioRole,
          Blob
        >)
      : null,
  };
}
