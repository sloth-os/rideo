import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Ffmpeg } from '../../src/media/ffmpeg';
import { Metrics } from '../../src/metrics';
import { Layout } from '../../src/storage/layout';
import { MemoryBackend } from '../../src/storage/memory';
import { WatermarkService } from '../../src/watermark/service';

const ff = new Ffmpeg({
  ffmpegPath: process.env.RIDEO_FFMPEG_PATH ?? 'ffmpeg',
  ffprobePath: process.env.RIDEO_FFPROBE_PATH ?? 'ffprobe',
});
let dir: string;
let wm: WatermarkService;
let source: string;
let marked: string;
let id: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rideo-wm-'));
  wm = new WatermarkService({
    ff,
    storage: new MemoryBackend(),
    layout: new Layout('/rideo'),
    metrics: new Metrics(),
    dataDir: dir,
    key: 'test-watermark-key',
    oldKeys: [],
    strength: 16,
    brand: { name: 'Rideo', owner: 'Test Studio', url: 'https://example.test' },
  });
  await wm.init();
  source = join(dir, 'source.mp4');
  // A textured moving test pattern with film grain plus a tone, standing in for generated footage.
  await ff.run([
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=640x360:rate=24:duration=4',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:duration=4',
    '-vf',
    'noise=alls=10:allf=t+u,format=yuv420p',
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '18',
    '-c:a',
    'aac',
    '-shortest',
    source,
  ]);
  id = await wm.allocateId();
  marked = join(dir, 'marked.mp4');
  const res = await wm.embedVideo(source, marked, { id, title: 'Test clip' });
  expect(res.frames).toBe(96);
  expect(res.psnr).toBeGreaterThan(42);
  await wm.register({
    id,
    projectId: 'prj_0000000000test00',
    asset: { kind: 'take', id: 'tak_0000000000test00' },
    media: null,
    embed: {
      width: 640,
      height: 360,
      strength: 16,
      pair: [
        [2, 1],
        [1, 2],
      ],
    },
  });
}, 120_000);

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function variant(name: string, args: string[]): Promise<string> {
  const out = join(dir, name);
  await ff.run(['-i', marked, ...args, out]);
  return out;
}

describe('invisible watermark with real codecs', () => {
  it('detects the id and provenance, keeps audio and writes metadata', async () => {
    const r = await wm.detectVideo(marked);
    expect(r.found).toBe(true);
    expect(r.id).toBe(id);
    expect(r.provenance?.brand.owner).toBe('Test Studio');
    expect(r.metadata.comment).toBe(`rideo-wm:v1:${id}`);
    expect((await ff.probe(marked)).hasAudio).toBe(true);
  });

  it('does not detect anything in the unmarked source', async () => {
    const r = await wm.detectVideo(source);
    expect(r.found).toBe(false);
    expect(r.meanMargin).toBeLessThan(2.5);
  });

  it.each([
    ['x264 crf 23', 'crf23.mp4', ['-c:v', 'libx264', '-crf', '23', '-preset', 'veryfast']],
    ['x264 crf 28', 'crf28.mp4', ['-c:v', 'libx264', '-crf', '28', '-preset', 'veryfast']],
    [
      'vp9 proxy settings',
      'proxy.webm',
      ['-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8', '-crf', '38', '-b:v', '0', '-an'],
    ],
    ['2 s excerpt', 'trim.mp4', ['-ss', '1', '-t', '2', '-c:v', 'libx264', '-crf', '20']],
    ['metadata stripped', 'strip.mp4', ['-map_metadata', '-1', '-c:v', 'libx264', '-crf', '20']],
    ['down/up scale', 'rescale.mp4', ['-vf', 'scale=320:180,scale=640:360', '-c:v', 'libx264', '-crf', '20']],
    ['downscaled copy', 'small.mp4', ['-vf', 'scale=320:180', '-c:v', 'libx264', '-crf', '18']],
  ])('survives %s', async (_label, name, args) => {
    const r = await wm.detectVideo(await variant(name, args as string[]));
    expect(r.found, `mean margin ${r.meanMargin.toFixed(2)}`).toBe(true);
    expect(r.id).toBe(id);
  });
});
