import type { Ffmpeg } from './ffmpeg';

/** Composes several reference images into one labelled-by-position cast sheet (side by side). */
export async function makeCastSheet(
  ff: Ffmpeg,
  images: string[],
  out: string,
  height = 512,
  signal?: AbortSignal,
): Promise<string> {
  if (images.length === 1) {
    await ff.run(['-i', images[0]!, '-vf', `scale=-2:${height}`, out], { signal });
    return out;
  }
  const inputs = images.flatMap((p) => ['-i', p]);
  const scaled = images.map((_, i) => `[${i}:v]scale=-2:${height},setsar=1[s${i}]`).join(';');
  const stack = `${images.map((_, i) => `[s${i}]`).join('')}hstack=inputs=${images.length}[out]`;
  await ff.run([...inputs, '-filter_complex', `${scaled};${stack}`, '-map', '[out]', '-frames:v', '1', out], {
    signal,
  });
  return out;
}
