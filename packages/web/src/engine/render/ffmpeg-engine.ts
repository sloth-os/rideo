import {
  AUDIO_ROLES,
  type AudioRole,
  type AudioWindow,
  chunkEncodeArgs,
  chunkGraph,
  type ExportQuality,
  type MediaRef,
  type RenderChunk,
  soundtrackEncodeArgs,
  soundtrackGraph,
  stemOutputArgs,
  type Timeline,
} from '@rideo/shared';
import { FONT_PATH, ffmpeg } from '../ffmpeg';
import { inputName } from '../media-files';

const inputPath = (m: { hash: string; path: string }) => `/in/${inputName(m)}`;

/** Loads the media files a graph reads, as its inputs by name (docs/design/editor.md#memory). */
export type LoadInputs = (media: MediaRef[]) => Promise<Record<string, Blob>>;

/** One chunk with the shared filtergraph → H.264 in MP4 (an intermediate; the server re-encodes). */
export async function renderChunkFfmpeg(opts: {
  timeline: Timeline;
  chunk: RenderChunk;
  quality: ExportQuality;
  load: LoadInputs;
  signal?: AbortSignal;
  onTime?: (sec: number) => void;
}): Promise<Uint8Array> {
  const g = chunkGraph(opts.timeline, opts.chunk, {
    quality: opts.quality,
    inputPath,
    fontFile: FONT_PATH,
    textPath: (i) => `/text/t${i}.txt`,
  });
  const out = '/out/part.mp4';
  const r = await ffmpeg.run([...g.args, ...chunkEncodeArgs(opts.quality), out], {
    inputs: await opts.load(g.media),
    files: Object.fromEntries(g.textFiles.map((f) => [f.path, f.content])),
    outputs: [out],
    signal: opts.signal,
    onTime: opts.onTime,
  });
  return r.outputs[out]!;
}

/**
 * One window of the soundtrack, lossless (both engines use it), and with `stems` the dialogue, music and effects
 * stems from the same run (docs/design/editor.md#soundtrack). The server joins the windows, normalizes the loudness
 * and encodes.
 */
export async function renderSoundtrack(opts: {
  timeline: Timeline;
  window: AudioWindow;
  load: LoadInputs;
  stems?: boolean;
  signal?: AbortSignal;
  onTime?: (sec: number) => void;
}): Promise<{ soundtrack: Uint8Array; stems: Record<AudioRole, Uint8Array> | null }> {
  const s = soundtrackGraph(opts.timeline, { inputPath, stems: opts.stems, window: opts.window });
  const out = '/out/soundtrack.flac';
  const stemPath = (role: AudioRole) => `/out/stem-${role}.flac`;
  const outputs = [out, ...(s.stems ? AUDIO_ROLES.map(stemPath) : [])];
  const r = await ffmpeg.run([...s.args, ...soundtrackEncodeArgs(), out, ...stemOutputArgs(s, stemPath)], {
    inputs: await opts.load(s.media),
    outputs,
    signal: opts.signal,
    onTime: opts.onTime,
  });
  return {
    soundtrack: r.outputs[out]!,
    stems: s.stems
      ? (Object.fromEntries(AUDIO_ROLES.map((role) => [role, r.outputs[stemPath(role)]!])) as Record<
          AudioRole,
          Uint8Array
        >)
      : null,
  };
}
