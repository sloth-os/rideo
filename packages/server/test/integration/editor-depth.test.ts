import { spawnSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  type Analysis,
  cutRanges,
  fillerWords,
  type Job,
  type Resource,
  rampPreset,
  sourceAtLocal,
  type Timeline,
  timeMapOf,
  type VideoItem,
} from '@rideo/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type EditorWorker, startEditorWorker } from '../helpers/editor-worker';
import { makeFootage, makeStill, uploadReady } from '../helpers/media';
import { type ApiError, expectSucceeded, type Stack, startStack } from '../helpers/stack';

/**
 * Editor depth (docs/design/editor.md): overlay tracks with keyframed transforms, a LUT, a speed ramp and a matte,
 * rendered by the reference worker (the shared graph with native ffmpeg) and checked pixel by pixel; transcript
 * editing with word timings.
 */
let stack: Stack;
let editor: EditorWorker | undefined;
beforeAll(async () => {
  // Speech-to-text through the mock's proxy, for the transcript's words
  stack = await startStack({ env: { RIDEO_STT_PROXY_DOMAIN: 'openai' } });
}, 60_000);
afterAll(async () => {
  await editor?.stop();
  await stack?.stop();
});

const code = (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (err: ApiError) => `${err.status} ${err.body?.code}`,
  );

/** The average colour of a small square of a frame (fractions of the frame), as RGB. */
function colorAt(file: string, t: number, x: number, y: number): [number, number, number] {
  const r = spawnSync(
    process.env.RIDEO_FFMPEG_PATH ?? 'ffmpeg',
    [
      '-v',
      'error',
      '-ss',
      String(t),
      '-i',
      file,
      '-frames:v',
      '1',
      '-vf',
      `crop=8:8:iw*${x}-4:ih*${y}-4,scale=1:1:flags=area`,
      '-f',
      'rawvideo',
      '-pix_fmt',
      'rgb24',
      '-',
    ],
    { maxBuffer: 1024 },
  );
  return [...r.stdout.subarray(0, 3)] as [number, number, number];
}

const green = (c: number[]) => c[1]! > 150 && c[0]! < 90 && c[2]! < 90;
/** Two colours within a tolerance per channel (the watermark moves luma a little). */
const near = (a: number[], b: number[], tol = 60) => a.every((v, k) => Math.abs(v - b[k]!) <= tol);
const red = (c: number[]) => c[0]! > 150 && c[1]! < 90 && c[2]! < 90;

let pid: string;
let footageFile: string;
let footage: Resource;
let still: Resource;
let lut: Resource;

async function exportFile(name: string): Promise<{ file: string; durationSec: number }> {
  const exp = await stack.api<any>('POST', `/projects/${pid}/exports`, {
    quality: 'draft',
    engine: 'ffmpeg',
  });
  const done = await stack.waitExport(pid, exp.export.id, 240_000);
  expect(done).toMatchObject({ status: 'succeeded', engine: 'ffmpeg' });
  const res = await fetch(`${stack.url}/api/projects/${pid}/media/${done.media.path}`);
  const file = join(stack.dataDir, name);
  await writeFile(file, Buffer.from(await res.arrayBuffer()));
  return { file, durationSec: done.durationSec };
}

describe('editor depth', () => {
  beforeAll(async () => {
    const p = await stack.api<{ id: string }>('POST', '/projects', {
      kind: 'edit',
      title: 'Layers',
      settings: { resolution: { width: 320, height: 180 }, fps: 24 },
    });
    pid = p.id;
    footageFile = await makeFootage(stack.dataDir);
    footage = await uploadReady(stack, pid, footageFile, { mime: 'video/mp4', name: 'harbour.mp4' });
    still = await uploadReady(stack, pid, await makeStill(stack.dataDir, 'red.png', 'red'), {
      mime: 'image/png',
      name: 'red.png',
    });
    editor = await startEditorWorker(stack, pid);
  }, 120_000);

  it('uploads .cube LUTs as resources and refuses broken ones', async () => {
    const rows = Array.from({ length: 8 }, () => '0 1 0').join('\n');
    const form = new FormData();
    form.set('file', new Blob([`TITLE "all green"\nLUT_3D_SIZE 2\n${rows}\n`]), 'All Green.cube');
    lut = await stack.api<Resource>('POST', `/projects/${pid}/uploads`, form);
    expect(lut).toMatchObject({ kind: 'lut', role: 'other', status: 'ready', name: 'All Green.cube' });
    expect(lut.media).toMatchObject({ mime: 'application/x-cube' });
    expect(lut.media.path).toMatch(/^media\/luts\/all-green-[0-9a-f]{12}\.cube$/);
    const bad = new FormData();
    bad.set('file', new Blob(['LUT_3D_SIZE 2\n0 0 0\n']), 'broken.cube');
    expect(await code(stack.api('POST', `/projects/${pid}/uploads`, bad))).toBe('422 validation_error');
  });

  it('renders overlays, a keyframed picture-in-picture, a LUT and a ramp as the shared graph says', async () => {
    const t0 = await stack.api<Timeline>('GET', `/projects/${pid}/timeline`);
    const primary = t0.tracks.find((t) => t.kind === 'video')!.id;
    const source = { type: 'media', media: footage.media, resourceId: footage.id };
    await stack.api('POST', `/projects/${pid}/timeline/ops`, {
      ops: [
        {
          op: 'insert',
          trackId: primary,
          item: {
            kind: 'video',
            source,
            in: 0,
            out: 3.5,
            lut: { media: lut.media, resourceId: lut.id, intensity: 1 },
          },
        },
        { op: 'insert', trackId: primary, item: { kind: 'video', source, in: 5, out: 8 } },
        { op: 'add_track', track: { id: 'trk_overlay000001', kind: 'video', name: 'B-roll' } },
        {
          op: 'insert',
          trackId: 'trk_overlay000001',
          item: {
            id: 'itm_0000000000p1',
            kind: 'video',
            source: { type: 'media', media: still.media, resourceId: still.id },
            start: 1,
            in: 0,
            out: 2,
            // a picture-in-picture top right, sliding to the left over its two seconds
            transform: {
              keyframes: [
                { t: 0, x: 0.75, y: 0.25, scale: 0.3 },
                { t: 2, x: 0.3 },
              ],
            },
          },
        },
      ],
    });
    let t = await stack.api<Timeline>('GET', `/projects/${pid}/timeline`);
    const second = t.tracks[0]!.items[1]!.id;
    await stack.api('POST', `/projects/${pid}/timeline/ops`, {
      ops: [{ op: 'set_ramp', itemId: second, ramp: rampPreset('ease_in', { in: 5, out: 8 }) }],
    });
    t = await stack.api<Timeline>('GET', `/projects/${pid}/timeline`);
    const ramped = t.tracks[0]!.items[1] as VideoItem;
    expect(ramped.start).toBeCloseTo(3.5);
    const { file, durationSec } = await exportFile('layers.mp4');
    // 3.5 s + the ramp's ln(4) / 0.5 s
    expect(durationSec).toBeCloseTo(3.5 + Math.log(4) / 0.5, 1);
    // The LUT turns the first item green; the red still is top right at 1.0 s and has slid left by 2.9 s
    expect(green(colorAt(file, 0.5, 0.5, 0.5))).toBe(true);
    expect(red(colorAt(file, 1.05, 0.75, 0.25))).toBe(true);
    expect(green(colorAt(file, 1.05, 0.3, 0.25))).toBe(true);
    expect(red(colorAt(file, 2.9, 0.32, 0.25))).toBe(true);
    expect(green(colorAt(file, 2.9, 0.75, 0.25))).toBe(true);
    // After the overlay, the ramped item: no LUT, the footage at the ramp's source time
    const src = sourceAtLocal(timeMapOf(ramped), 4.5 - ramped.start);
    expect(near(colorAt(file, 4.5, 0.5, 0.5), colorAt(footageFile, src, 0.5, 0.5))).toBe(true);
  }, 300_000);

  it('removes the background with the segmentation model; the matte shows the tracks below around the subject', async () => {
    let t = await stack.api<Timeline>('GET', `/projects/${pid}/timeline`);
    // a still has nothing to segment
    expect(await code(stack.api('POST', `/projects/${pid}/timeline/items/itm_0000000000p1/mask`, {}))).toBe(
      '422 validation_error',
    );
    await stack.api('POST', `/projects/${pid}/timeline/ops`, {
      ops: [
        { op: 'remove', itemId: 'itm_0000000000p1' },
        {
          op: 'insert',
          trackId: 'trk_overlay000001',
          item: {
            id: 'itm_0000000000m1',
            kind: 'video',
            source: { type: 'media', media: footage.media, resourceId: footage.id },
            start: 0.5,
            in: 0.5,
            out: 3,
          },
        },
      ],
    });
    const job = await stack.api<Job>('POST', `/projects/${pid}/timeline/items/itm_0000000000m1/mask`, {
      subject: 'the dancer',
    });
    expect(job).toMatchObject({ kind: 'mask.generate', lane: 'video' });
    expectSucceeded(await stack.waitJob(pid, job.id));
    t = await stack.api<Timeline>('GET', `/projects/${pid}/timeline`);
    const item = t.tracks[1]!.items[0] as VideoItem;
    expect(item.mask).toMatchObject({
      subject: 'the dancer',
      offset: 0,
      invert: false,
      model: 'mock-segment-v1',
    });
    expect(item.mask!.media.path).toMatch(/^media\/masks\/.+\.mp4$/);
    expect(item.mask!.media.durationSec).toBeCloseTo(4, 0);
    const { file } = await exportFile('masked.mp4');
    // Around the subject (the matte's ellipse) the green primary shows; inside, the footage (source 1.5 s)
    expect(green(colorAt(file, 1.5, 0.08, 0.12))).toBe(true);
    expect(near(colorAt(file, 1.5, 0.5, 0.55), colorAt(footageFile, 1.5, 0.5, 0.55))).toBe(true);

    // Without a segmentation model for the project
    await stack.api('PATCH', `/projects/${pid}`, { settings: { models: { segment: 'off' } } });
    expect(await code(stack.api('POST', `/projects/${pid}/timeline/items/itm_0000000000m1/mask`, {}))).toBe(
      '422 segmentation_unavailable',
    );
    await stack.api('PATCH', `/projects/${pid}`, { settings: { models: { segment: 'auto' } } });
    const metrics = await (await fetch(`${stack.url}/metrics`)).text();
    expect(metrics).toMatch(/rideo_masks_total\{outcome="ok"\} 1/);
  }, 300_000);

  it('edits by text: word timings from speech-to-text, filler words cut out of the picture', async () => {
    const { analysis, job } = await stack.api<{ analysis: Analysis; job: Job }>(
      'POST',
      `/projects/${pid}/analyses`,
      {
        resourceId: footage.id,
      },
    );
    const signals = expectSucceeded(await stack.waitJob(pid, job.id));
    expectSucceeded(await stack.waitJob(pid, (signals.result as { next: string }).next));
    const state = await stack.api<any>('GET', `/projects/${pid}/state`);
    const a = state.docs.analyses[analysis.id] as Analysis;
    expect(a.transcript[1]!.words!.map((w) => w.text)).toEqual([
      'Um,',
      'line',
      '2',
      'of',
      'the',
      'conversation,',
      'you',
      'know.',
    ]);
    const words = a.transcript.flatMap((s) => s.words ?? []);
    const fillers = fillerWords(words);
    expect(fillers.map((f) => f.text)).toEqual(['Um', 'you know']);
    const before = await stack.api<Timeline>('GET', `/projects/${pid}/timeline`);
    const ranges = cutRanges(fillers).filter(([s, e]) => s < 3.5 && e > 0);
    const res = await stack.api<{ timeline: Timeline }>('POST', `/projects/${pid}/timeline/ops`, {
      ops: [{ op: 'remove_ranges', media: footage.media.path, ranges }],
    });
    const items = res.timeline.tracks[0]!.items as VideoItem[];
    expect(items.length).toBeGreaterThan(before.tracks[0]!.items.length);
    // nothing of the cut plays the hesitations any more
    for (const [s, e] of ranges)
      for (const i of items.filter((x) => x.source.media.path === footage.media.path))
        expect(i.out <= s + 1e-6 || i.in >= e - 1e-6).toBe(true);
  }, 300_000);

  it('agents use the same operations and the background tool over MCP', async () => {
    const client = new Client({ name: 'Claude Code', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(`${stack.url}/mcp`));
    await client.connect(transport);
    try {
      const call = async (name: string, args: Record<string, unknown>) => {
        const r = await client.callTool({ name, arguments: args });
        return { error: !!r.isError, body: JSON.parse((r.content as { text: string }[])[0]!.text) };
      };
      const applied = await call('timeline_apply', {
        projectId: pid,
        ops: [
          {
            op: 'set_transform',
            itemId: 'itm_0000000000m1',
            transform: { keyframes: [{ t: 0, scale: 0.5, opacity: 0.8 }] },
          },
        ],
      });
      expect(applied.error).toBe(false);
      const job = await call('timeline_remove_background', {
        projectId: pid,
        itemId: 'itm_0000000000m1',
        invert: true,
      });
      expect(job.body).toMatchObject({ kind: 'mask.generate' });
      expectSucceeded(await stack.waitJob(pid, job.body.id));
      const t = await stack.api<Timeline>('GET', `/projects/${pid}/timeline`);
      expect((t.tracks[1]!.items[0] as VideoItem).mask!.invert).toBe(true);
    } finally {
      await client.close();
    }
  }, 120_000);
});
