import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Reader } from '@contentauth/c2pa-node';
import type { Clip, Job, Timeline } from '@rideo/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type EditorWorker, startEditorWorker } from '../helpers/editor-worker';
import { ff } from '../helpers/media';
import { expectSucceeded, readyStoryProject, type Stack, startStack } from '../helpers/stack';

/** Finishing and deliverables (docs/design/finishing.md) on the mock gateway and the reference editor worker. */
let stack: Stack;
let pid: string;
let editor: EditorWorker;

beforeAll(async () => {
  stack = await startStack();
  const { projectId, state } = await readyStoryProject(stack, { storyboard: { enabled: false } });
  pid = projectId;
  const plan = await stack.api<Job>('POST', `/projects/${pid}/clips/plan`, {
    sceneId: state.docs.screenplay.scenes[0].id,
    generate: true,
  });
  expectSucceeded(await stack.waitJob(pid, plan.id, 180_000));
  await stack.waitIdle(pid, 180_000);
  const clip = Object.values<Clip>((await stack.api<any>('GET', `/projects/${pid}/state`)).docs.clips)[0]!;
  await stack.api('POST', `/projects/${pid}/clips/${clip.id}/approve`);
  await stack.api('POST', `/projects/${pid}/timeline/assemble`, { captions: true });
  editor = await startEditorWorker(stack, pid);
}, 300_000);
afterAll(async () => {
  await editor?.stop();
  await stack?.stop();
});

async function exportWith(body: Record<string, unknown>) {
  const created = await stack.api<any>('POST', `/projects/${pid}/exports`, body);
  const done = await stack.waitExport(pid, created.export.id, 300_000);
  expect(done.status, done.error).toBe('succeeded');
  return { created, done };
}

async function download(path: string, name: string): Promise<string> {
  const res = await fetch(`${stack.url}/api/projects/${pid}/media/${path}`);
  expect(res.ok).toBe(true);
  const out = join(stack.dataDir, name);
  await writeFile(out, Buffer.from(await res.arrayBuffer()));
  return out;
}

/** Streams of a file: codec, size and frame rate per stream. */
async function streams(path: string) {
  const { execFileSync } = await import('node:child_process');
  const json = JSON.parse(
    execFileSync(process.env.RIDEO_FFPROBE_PATH ?? 'ffprobe', [
      '-v',
      'error',
      '-show_entries',
      'stream=codec_type,codec_name,width,height,r_frame_rate,nb_frames,pix_fmt',
      '-of',
      'json',
      path,
    ]).toString(),
  );
  return json.streams as {
    codec_type: string;
    codec_name: string;
    width?: number;
    height?: number;
    r_frame_rate: string;
    nb_frames?: string;
    pix_fmt?: string;
  }[];
}

const manifestOf = async (path: string, mimeType: string) => {
  const store = (await Reader.fromAsset({ path, mimeType }))!.json() as any;
  return store.manifests[store.active_manifest];
};

/** Names and sizes of a ustar archive's entries. */
function tarEntries(buf: Buffer): { name: string; size: number }[] {
  const out: { name: string; size: number }[] = [];
  for (let off = 0; off + 512 <= buf.length; ) {
    const header = buf.subarray(off, off + 512);
    if (header.every((b) => b === 0)) break;
    const field = (a: number, b: number) => header.toString('utf8', a, b).replace(/\0.*$/s, '');
    const name = field(0, 100);
    const prefix = field(345, 500);
    const size = Number.parseInt(field(124, 136).trim(), 8);
    out.push({ name: prefix ? `${prefix}/${name}` : name, size });
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return out;
}

describe('finishing and deliverables', () => {
  it('upscales and interpolates through the gateway model, with signed thumbnails', async () => {
    const { done } = await exportWith({ quality: 'standard', preset: 'youtube', resolution: 'hd', fps: 48 });
    expect(done.delivery).toMatchObject({
      preset: 'youtube',
      format: 'mp4',
      width: 1920,
      height: 1080,
      fps: 48,
      enhance: { upscale: 'model', interpolate: 'model', model: 'mock-enhance-v1' },
    });
    const film = await download(done.media.path, 'youtube.mp4');
    const [v] = (await streams(film)).filter((s) => s.codec_type === 'video');
    expect(v).toMatchObject({ codec_name: 'h264', width: 1920, height: 1080, r_frame_rate: '48/1' });
    const manifest = await manifestOf(film, 'video/mp4');
    const actions = manifest.assertions.find((a: any) => a.label.startsWith('c2pa.actions')).data.actions;
    expect(actions).toContainEqual(
      expect.objectContaining({ action: 'c2pa.edited', parameters: { operation: 'upscale' } }),
    );
    // thumbnails: three signed JPEGs, frames of the export
    expect(done.thumbnails).toHaveLength(3);
    const thumb = await download(done.thumbnails[0].path, 'thumb.jpg');
    expect(done.thumbnails[0].mime).toBe('image/jpeg');
    const tm = await manifestOf(thumb, 'image/jpeg');
    expect(tm.ingredients[0].relationship).toBe('parentOf');
    // the YouTube preset delivers the subtitles beside the film
    expect(done.captions).toBe('sidecar');
  }, 300_000);

  it('falls back to ffmpeg without an enhancement model', async () => {
    await stack.api('PATCH', `/projects/${pid}`, { settings: { models: { enhance: 'off' } } });
    const { done } = await exportWith({ quality: 'draft', resolution: 'hd' });
    expect(done.delivery).toMatchObject({
      width: 1280,
      height: 720,
      enhance: { upscale: 'ffmpeg', interpolate: null, model: null },
    });
    await stack.api('PATCH', `/projects/${pid}`, { settings: { models: { enhance: 'auto' } } });
  }, 300_000);

  it('delivers a ProRes master with PCM sound and stems', async () => {
    const { done } = await exportWith({ quality: 'draft', preset: 'master_prores' });
    expect(done.media.mime).toBe('video/quicktime');
    const mov = await download(done.media.path, 'master.mov');
    const s = await streams(mov);
    expect(s.find((x) => x.codec_type === 'video')).toMatchObject({
      codec_name: 'prores',
      pix_fmt: 'yuv422p10le',
    });
    expect(s.find((x) => x.codec_type === 'audio')).toMatchObject({ codec_name: 'pcm_s24le' });
    expect(done.contentCredentials.manifest).toMatch(/^urn:c2pa:/);
    expect(done.stems.music.mime).toBe('audio/wav');
    expect(done.loudness.target).toBe('off');
  }, 300_000);

  it('delivers an image-sequence master: every frame, the sound and the subtitles in a TAR', async () => {
    const { done } = await exportWith({ quality: 'draft', preset: 'master_frames' });
    expect(done.media.mime).toBe('application/x-tar');
    const tar = await readFile(await download(done.media.path, 'master.tar'));
    const entries = tarEntries(tar);
    const frames = entries.filter((e) => e.name.startsWith('frames/frame-'));
    const render = await stack.api<Timeline>('GET', `/projects/${pid}/docs/renders/${done.id}.json`);
    const seconds = Math.max(
      ...render.tracks.flatMap((t) =>
        t.items.map((i: any) =>
          i.kind === 'text' ? i.start + i.duration : i.start + (i.out - i.in) / (i.speed ?? 1),
        ),
      ),
    );
    expect(frames).toHaveLength(Math.round(seconds * 24));
    expect(frames[0]!.name).toBe('frames/frame-000001.png');
    expect(entries.map((e) => e.name)).toEqual(
      expect.arrayContaining(['soundtrack.wav', 'subtitles.srt', 'subtitles.vtt']),
    );
    expect(done.contentCredentials).toBeNull();
    expect(done.watermarkId).toMatch(/^wm_/);
  }, 300_000);

  it('reframes a vertical cut-down around the subject, preparing the focus once', async () => {
    const first = await exportWith({ quality: 'draft', preset: 'vertical', maxDurationSec: 6 });
    expect(first.created.job.kind).toBe('export.prepare');
    expect(first.done.delivery).toMatchObject({ aspect: '9:16', width: 406, height: 720, maxDurationSec: 6 });
    const render = await stack.api<Timeline>('GET', `/projects/${pid}/docs/renders/${first.done.id}.json`);
    expect([render.width, render.height]).toEqual([102, 180]);
    expect(render.tracks[0]!.items.every((i: any) => i.crop?.focus.length > 0)).toBe(true);
    const clips = Object.values<Clip>((await stack.api<any>('GET', `/projects/${pid}/state`)).docs.clips);
    const takes = clips.flatMap((c) =>
      c.shots.flatMap((s) => s.takes.filter((t) => t.id === s.selectedTakeId)),
    );
    expect(takes.every((t) => t.focus?.length === 3)).toBe(true);
    const film = await download(first.done.media.path, 'vertical.mp4');
    expect((await ff.probe(film)).durationSec).toBeLessThanOrEqual(6.1);
    const [v] = (await streams(film)).filter((s) => s.codec_type === 'video');
    expect([v!.width, v!.height]).toEqual([406, 720]);
    expect(first.done.thumbnails.length).toBeGreaterThan(0);
    // the focus is kept: a square cut-down goes straight to the render
    const second = await exportWith({ quality: 'draft', preset: 'square', maxDurationSec: 6 });
    expect(second.created.job.kind).toBe('export.render');
    expect(second.done.delivery).toMatchObject({ aspect: '1:1', width: 720, height: 720 });
  }, 300_000);
});
