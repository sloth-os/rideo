import { type Probe, parseProbe, posterCommand, probeCommand } from '@rideo/shared';
import { ffmpeg } from './ffmpeg';

/**
 * Probe and poster of a media file with ffmpeg.wasm (docs/design/editor.md#media-preparation-uploads).
 * `probe` is null when ffmpeg does not recognize the file.
 */
export async function prepareMedia(
  file: Blob,
  opts: { signal?: AbortSignal; poster?: boolean } = {},
): Promise<{ probe: Probe | null; poster: Blob | null }> {
  const r = await ffmpeg.run(probeCommand('/in/src'), {
    inputs: { src: file },
    allowFailure: true,
    signal: opts.signal,
  });
  const probe = parseProbe(r.log);
  if (!probe?.hasVideo || opts.poster === false) return { probe, poster: null };
  const out = '/out/poster.jpg';
  const p = await ffmpeg.run(posterCommand('/in/src', out, probe), {
    inputs: { src: file },
    outputs: [out],
    signal: opts.signal,
  });
  return { probe, poster: new Blob([p.outputs[out]! as BlobPart], { type: 'image/jpeg' }) };
}
