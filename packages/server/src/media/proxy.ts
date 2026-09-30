import type { Ffmpeg } from './ffmpeg';

/** Browser-safe VP9/Opus WebM preview proxy, ≤ 640 px wide, keyframe every 2 s (docs/design/editor.md#proxy-media). */
export async function makeProxy(
  ff: Ffmpeg,
  input: string,
  out: string,
  opts: { fps?: number; hasAudio: boolean; signal?: AbortSignal },
): Promise<string> {
  const gop = Math.max(12, Math.round((opts.fps ?? 24) * 2));
  await ff.run(
    [
      '-i',
      input,
      '-map',
      '0:v:0',
      ...(opts.hasAudio ? ['-map', '0:a:0?'] : []),
      '-vf',
      "scale='min(640,iw)':-2",
      '-c:v',
      'libvpx-vp9',
      '-deadline',
      'realtime',
      '-cpu-used',
      '8',
      '-row-mt',
      '1',
      '-crf',
      '38',
      '-b:v',
      '0',
      '-g',
      String(gop),
      ...(opts.hasAudio ? ['-c:a', 'libopus', '-b:a', '64k'] : ['-an']),
      '-f',
      'webm',
      out,
    ],
    { signal: opts.signal },
  );
  return out;
}

export async function makePoster(
  ff: Ffmpeg,
  input: string,
  atSec: number,
  out: string,
  signal?: AbortSignal,
): Promise<string> {
  await ff.run(
    [
      '-ss',
      Math.max(0, atSec).toFixed(3),
      '-i',
      input,
      '-frames:v',
      '1',
      '-vf',
      "scale='min(480,iw)':-2",
      '-q:v',
      '4',
      out,
    ],
    { signal },
  );
  return out;
}
