import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectSettingsSchema } from '@rideo/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  audioEncodeArgs,
  finishFilter,
  planEnhance,
  videoEncodeArgs,
} from '../../src/jobs/handlers/finishing';
import { writeTar } from '../../src/media/tar';

/** Finishing (docs/design/finishing.md): enhancement planning, the finishing filter, encoders, the TAR writer. */
let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rideo-finishing-'));
});
afterAll(async () => rm(dir, { recursive: true, force: true }));

const gateway = (models: { id: string; limits: Record<string, unknown> }[]) =>
  ({ gateway: { modelLimits: async () => models } }) as never;
const settings = (enhance = 'auto') => ProjectSettingsSchema.parse({ models: { enhance } });
const HD = { width: 1920, height: 1080, fps: 24 };

describe('enhancement planning', () => {
  const models = [
    { id: 'upscaler', limits: { supports_upscale: true } },
    { id: 'both', limits: { supports_upscale: true, supports_frame_interpolation: true, max_fps: 60 } },
  ];

  it('picks the first model that can do everything asked, or ffmpeg', async () => {
    expect(await planEnhance(gateway(models), settings(), HD, HD)).toEqual({
      upscale: false,
      interpolate: false,
      model: null,
    });
    expect(
      await planEnhance(gateway(models), settings(), HD, { width: 3840, height: 2160, fps: 24 }),
    ).toEqual({
      upscale: true,
      interpolate: false,
      model: 'upscaler',
    });
    expect(
      await planEnhance(gateway(models), settings(), HD, { width: 3840, height: 2160, fps: 48 }),
    ).toMatchObject({
      interpolate: true,
      model: 'both',
    });
    // beyond the model's max_fps, or turned off, or a pinned model without the capability: ffmpeg
    expect((await planEnhance(gateway(models), settings(), HD, { ...HD, fps: 120 })).model).toBeNull();
    expect(
      (await planEnhance(gateway(models), settings('off'), HD, { width: 3840, height: 2160, fps: 24 })).model,
    ).toBeNull();
    expect(
      (await planEnhance(gateway(models), settings('upscaler'), HD, { ...HD, fps: 60 })).model,
    ).toBeNull();
  });

  it('scales with Lanczos and blends frames when ffmpeg enhances', () => {
    const to = { width: 3840, height: 2160, fps: 60 };
    expect(finishFilter(to, { upscale: true, interpolate: true, model: null })).toBe(
      'scale=3840:2160:flags=lanczos,setsar=1,framerate=fps=60,format=yuv420p',
    );
    expect(finishFilter(to, { upscale: true, interpolate: true, model: 'm' })).toBe(
      'scale=3840:2160,setsar=1,fps=60,format=yuv420p',
    );
  });

  it('encodes each delivery format', () => {
    expect(videoEncodeArgs({ format: 'prores', preset: 'broadcast' }, 'standard')).toContain('prores_ks');
    expect(videoEncodeArgs({ format: 'mp4', preset: 'youtube' }, 'high')).toEqual(
      expect.arrayContaining(['libx264', '-profile:v', 'high', '-crf', '17']),
    );
    expect(audioEncodeArgs({ format: 'prores', preset: 'broadcast' })).toEqual([
      '-c:a',
      'pcm_s24le',
      '-ar',
      '48000',
    ]);
    expect(audioEncodeArgs({ format: 'mp4', preset: 'youtube' })).toContain('320k');
  });
});

describe('ustar archives', () => {
  it('writes headers, padded contents and long names split at a slash', async () => {
    const a = join(dir, 'a.txt');
    const b = join(dir, 'b.bin');
    await writeFile(a, 'hello');
    await writeFile(b, Buffer.alloc(700, 7));
    const long = `${'d'.repeat(120)}/frame-000001.png`;
    const out = join(dir, 'x.tar');
    await writeTar(out, [
      { name: 'a.txt', path: a },
      { name: long, path: b },
    ]);
    const tar = await readFile(out);
    // two headers, 512 + 1024 bytes of content, two empty blocks
    expect(tar.length).toBe(512 + 512 + 512 + 1024 + 1024);
    const field = (off: number, a1: number, b1: number) =>
      tar.toString('utf8', off + a1, off + b1).replace(/\0.*$/s, '');
    expect(field(0, 0, 100)).toBe('a.txt');
    expect(Number.parseInt(field(0, 124, 136), 8)).toBe(5);
    expect(field(0, 257, 262)).toBe('ustar');
    expect(tar.toString('utf8', 512, 517)).toBe('hello');
    const second = 1024;
    expect(field(second, 0, 100)).toBe('frame-000001.png');
    expect(field(second, 345, 500)).toBe('d'.repeat(120));
    expect(Number.parseInt(field(second, 124, 136), 8)).toBe(700);
    // the checksum is the sum of the header with the checksum field as spaces
    const header = Buffer.from(tar.subarray(0, 512));
    const stored = Number.parseInt(header.toString('utf8', 148, 154), 8);
    header.fill(0x20, 148, 156);
    expect(header.reduce((s, v) => s + v, 0)).toBe(stored);
    await expect(writeTar(join(dir, 'y.tar'), [{ name: `${'e'.repeat(300)}.png`, path: a }])).rejects.toThrow(
      /too long/,
    );
  });
});
