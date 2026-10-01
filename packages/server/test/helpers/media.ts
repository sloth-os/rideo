import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseProbe, probeCommand, type Resource } from '@rideo/shared';
import { Ffmpeg } from '../../src/media/ffmpeg';
import type { Stack } from './stack';

export const ff = new Ffmpeg({
  ffmpegPath: process.env.RIDEO_FFMPEG_PATH ?? 'ffmpeg',
  ffprobePath: process.env.RIDEO_FFPROBE_PATH ?? 'ffprobe',
});

/** 9 s of footage: 4 s pattern with a tone, 1 s black, 4 s fractal; audio has a 2.5 s silence at 4–6.5 s. */
export async function makeFootage(dir: string): Promise<string> {
  const out = join(dir, 'footage.mp4');
  await ff.run([
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=320x180:rate=24:duration=4',
    '-f',
    'lavfi',
    '-i',
    'color=c=black:size=320x180:rate=24:duration=1',
    '-f',
    'lavfi',
    '-i',
    'mandelbrot=size=320x180:rate=24',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=500:duration=4',
    '-f',
    'lavfi',
    '-i',
    'anullsrc=r=44100:cl=mono',
    '-filter_complex',
    '[2:v]trim=duration=4,setpts=PTS-STARTPTS[m];[0:v][1:v][m]concat=n=3:v=1:a=0,format=yuv420p[v];[3:a]atrim=duration=4[s1];[4:a]atrim=duration=2.5[sil];[3:a]atrim=duration=2.5,asetpts=PTS-STARTPTS[s2];[s1][sil][s2]concat=n=3:v=0:a=1[a]',
    '-map',
    '[v]',
    '-map',
    '[a]',
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-c:a',
    'aac',
    '-shortest',
    out,
  ]);
  return out;
}

/**
 * Uploads a file the way the studio does: audio and video are probed "in the browser" with the shared commands, so
 * the resource is ready without an editor job.
 */
export async function uploadReady(
  stack: Stack,
  projectId: string,
  file: string,
  opts: { mime: string; name: string; role?: string },
): Promise<Resource> {
  const form = new FormData();
  const meta: Record<string, unknown> = opts.role ? { role: opts.role } : {};
  if (!opts.mime.startsWith('image/')) {
    const banner = spawnSync(process.env.RIDEO_FFMPEG_PATH ?? 'ffmpeg', ['-y', ...probeCommand(file)], {
      encoding: 'utf8',
    }).stderr;
    meta.probe = parseProbe(banner);
  }
  if (Object.keys(meta).length) form.set('meta', JSON.stringify(meta));
  form.set('file', new Blob([await readFile(file)], { type: opts.mime }), opts.name);
  return stack.api<Resource>('POST', `/projects/${projectId}/uploads`, form);
}

/** A PNG still (a solid colour with a test pattern), for frame controls. */
export async function makeStill(dir: string, name = 'still.png', color = 'teal'): Promise<string> {
  const out = join(dir, name);
  await ff.run(['-f', 'lavfi', '-i', `color=c=${color}:size=320x180`, '-frames:v', '1', out]);
  return out;
}
