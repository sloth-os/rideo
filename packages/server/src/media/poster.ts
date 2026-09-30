import type { Ffmpeg } from './ffmpeg';

/** A JPEG poster frame of a generated take (browsers make posters of their own uploads). */
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
