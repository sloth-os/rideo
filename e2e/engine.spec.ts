import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { expect, type Page, test } from '@playwright/test';
import { newId, parseProbe } from '@rideo/shared';
import { PNG } from 'pngjs';
import { Api, makeFootage, TINY } from './support/api';
import { at, PORTS } from './support/ports';
import { exportInThisTab } from './support/ui';

// A software WebGPU adapter: SwiftShader through Vulkan (the GL-only SwiftShader path loses its device).
test.use({
  launchOptions: {
    args: [
      '--enable-unsafe-webgpu',
      '--enable-features=Vulkan',
      '--use-vulkan=swiftshader',
      '--use-webgpu-adapter=swiftshader',
      '--use-angle=swiftshader',
    ],
  },
});

const ffmpeg = process.env.RIDEO_FFMPEG_PATH ?? 'ffmpeg';

/** Mean absolute difference per channel (0–255) of two screenshots of the same size. */
function meanDiff(a: Buffer, b: Buffer): number {
  const x = PNG.sync.read(a);
  const y = PNG.sync.read(b);
  expect([x.width, x.height]).toEqual([y.width, y.height]);
  let sum = 0;
  for (let i = 0; i < x.data.length; i += 4)
    for (let c = 0; c < 3; c++) sum += Math.abs(x.data[i + c]! - y.data[i + c]!);
  return sum / ((x.data.length / 4) * 3);
}

/** The preview once its picture stops changing (the first frames load asynchronously). */
async function settledPreview(page: Page): Promise<Buffer> {
  const canvas = page.getByTestId('preview-canvas');
  let last = await canvas.screenshot();
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(400);
    const next = await canvas.screenshot();
    if (next.equals(last)) return next;
    last = next;
  }
  return last;
}

/** Engine performance (docs/design/engine-performance.md). */
test('the engine: threads under cross-origin isolation, WebGPU like the canvas, renders in a hidden tab, WebCodecs proxies', async ({
  page,
  request,
}, testInfo) => {
  // two exports, a 4K proxy and WebGPU on a software adapter: slow when the whole suite runs at once
  test.setTimeout(600_000);
  const api = new Api(request);
  const pid = await api.editProjectWithClip(
    `Engine (${testInfo.project.name})`,
    makeFootage(testInfo.outputPath('clip.mp4')),
  );
  const status = page.getByTestId('engine-status');
  // the GPU path never falls back to the canvas
  const fallbacks: string[] = [];
  page.on('console', (m) => {
    if (m.text().includes('WebGPU compositing failed')) fallbacks.push(m.text());
  });

  // A graded picture under a scaled, turned, half-transparent overlay: the layers both compositors must agree on
  const cut = await api.call<any>('GET', `/projects/${pid}/timeline`);
  const primary = cut.tracks[0].items[0];
  const overlayTrack = newId('track');
  const overlay = newId('item');
  await api.call('POST', `/projects/${pid}/timeline/ops`, {
    ops: [
      { op: 'set_effects', itemId: primary.id, effects: { brightness: 0.1, contrast: 1.2, saturation: 0.5 } },
      { op: 'add_track', track: { id: overlayTrack, kind: 'video', name: 'Overlay' } },
      {
        op: 'insert',
        trackId: overlayTrack,
        item: { id: overlay, kind: 'video', source: primary.source, start: 0, in: 0, out: 3 },
      },
      {
        op: 'set_transform',
        itemId: overlay,
        transform: { keyframes: [{ t: 0, x: 0.7, y: 0.32, scale: 0.4, rotation: 20, opacity: 0.8 }] },
      },
    ],
  });

  // Cross-origin isolated: the studio may use SharedArrayBuffer
  await page.goto(`/p/${pid}/editor`);
  expect(await page.evaluate(() => crossOriginIsolated && typeof SharedArrayBuffer === 'function')).toBe(
    true,
  );

  // The same picture from WebGPU and from the canvas
  await expect(status).toHaveAttribute('data-compositor', 'webgpu');
  const gpu = await settledPreview(page);
  await page.evaluate(() => localStorage.setItem('rideo.compositor', 'canvas'));
  await page.reload();
  await expect(status).toHaveAttribute('data-compositor', 'canvas');
  const canvas = await settledPreview(page);
  expect(meanDiff(gpu, canvas)).toBeLessThan(6);
  await page.evaluate(() => localStorage.removeItem('rideo.compositor'));
  await page.reload();
  await expect(status).toHaveAttribute('data-compositor', 'webgpu');

  // ffmpeg.wasm on threads: the multi-threaded core renders an export
  await exportInThisTab(page, { engine: 'ffmpeg', quality: 'draft' });
  await expect(status).toHaveAttribute('data-threads', /^[2-8]$/);

  // A WebCodecs export composited by WebGPU, in a tab that is hidden: heartbeats from a worker, a Web Lock held
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  const locks: string[] = [];
  const watch = (async () => {
    for (let i = 0; i < 400 && !locks.length; i++) {
      const held = await page.evaluate(async () =>
        ((await navigator.locks.query()).held ?? []).map((l) => l.name ?? ''),
      );
      locks.push(...held.filter((n) => n.startsWith('rideo-editor-job:')));
      if (!locks.length) await page.waitForTimeout(50);
    }
  })();
  const ticks = (async () => {
    await expect(status).toHaveAttribute('data-ticks', 'worker', { timeout: 60_000 });
  })();
  await exportInThisTab(page, { engine: 'webcodecs', quality: 'draft' });
  await watch;
  await ticks;
  expect(locks[0]).toMatch(/^rideo-editor-job:job_/);
  // the dialog may still show the first export as ready: wait for both
  await expect
    .poll(
      async () =>
        Object.values<any>((await api.call<any>('GET', `/projects/${pid}/state`)).docs.exports)
          .map((e) => [e.engine, e.compositor ?? null, e.status])
          .sort(),
      { timeout: 300_000 },
    )
    .toEqual([
      ['ffmpeg', null, 'succeeded'],
      ['webcodecs', 'webgpu', 'succeeded'],
    ]);
  await page.goto(`/p/${pid}/exports`);
  await expect(page.getByTestId('export-webgpu')).toBeVisible();
  expect(fallbacks).toEqual([]);

  // A heavy original previews from an editing proxy made with WebCodecs
  const heavy = testInfo.outputPath('uhd.mp4');
  execFileSync(ffmpeg, [
    '-y',
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=3840x2160:rate=12:duration=2',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-pix_fmt',
    'yuv420p',
    heavy,
  ]);
  let banner = '';
  try {
    execFileSync(ffmpeg, ['-hide_banner', '-i', heavy], { stdio: 'pipe' });
  } catch (err) {
    banner = String((err as { stderr?: Buffer }).stderr ?? '');
  }
  const uploaded = await request.post(`/api/projects/${pid}/uploads`, {
    multipart: {
      meta: JSON.stringify({ probe: parseProbe(banner) }),
      file: { name: 'uhd.mp4', mimeType: 'video/mp4', buffer: readFileSync(heavy) },
    },
  });
  expect(uploaded.ok()).toBe(true);
  const media = (await uploaded.json()).media;
  const timeline = await api.call<any>('GET', `/projects/${pid}/timeline`);
  await api.call('POST', `/projects/${pid}/timeline/ops`, {
    ops: [
      {
        op: 'insert',
        trackId: timeline.tracks[0].id,
        // first on the picture track, where the preview opens
        index: 0,
        item: { kind: 'video', source: { type: 'media', media }, in: 0, out: 2 },
      },
    ],
  });
  await page.goto(`/p/${pid}/editor`);
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          const root = await navigator.storage.getDirectory();
          const dir = await root.getDirectoryHandle('proxies', { create: true });
          const names: string[] = [];
          for await (const [name] of (dir as unknown as { entries(): AsyncIterable<[string]> }).entries())
            names.push(name);
          return names;
        }),
      { timeout: 120_000 },
    )
    .toContainEqual(`${media.hash}-webcodecs-720-v2.webm`);
});

/** A cut of many short items: a chunk and the soundtrack open every item as an input (docs/design/engine-performance.md). */
test('ffmpeg.wasm renders a cut of 40 short items within its 32-thread pool', async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(300_000);
  const api = new Api(request);
  const pid = await api.editProjectWithClip(
    `Many inputs (${testInfo.project.name})`,
    makeFootage(testInfo.outputPath('clip.mp4')),
  );
  // threads planned for 8 cores, as on a big machine, whatever runs the test
  await page.addInitScript(() =>
    Object.defineProperty(Navigator.prototype, 'hardwareConcurrency', { get: () => 8 }),
  );
  const cut = await api.call<any>('GET', `/projects/${pid}/timeline`);
  const track = cut.tracks[0];
  const clip = track.items[0];
  // 40 quarter-second items: with a reader thread for each input, the chunk and the soundtrack would hang the pool
  await api.call('POST', `/projects/${pid}/timeline/ops`, {
    ops: [
      { op: 'remove', itemId: clip.id },
      ...Array.from({ length: 40 }, (_, k) => ({
        op: 'insert',
        trackId: track.id,
        item: { kind: 'video', source: clip.source, in: (k % 24) * 0.25, out: (k % 24) * 0.25 + 0.25 },
      })),
    ],
  });
  await page.goto(`/p/${pid}/editor`);
  await exportInThisTab(page, { engine: 'ffmpeg', quality: 'draft' });
  await expect(page.getByTestId('engine-status')).toHaveAttribute('data-threads', '8');
  const exports = Object.values<any>((await api.call<any>('GET', `/projects/${pid}/state`)).docs.exports);
  expect(exports.map((e) => [e.engine, e.status])).toEqual([['ffmpeg', 'succeeded']]);
  expect(exports[0].durationSec).toBeCloseTo(10, 0);
});

/**
 * A cut of many clips on slow storage (docs/design/engine-performance.md#media-requests): the lanes and the preview
 * read a few media requests at a time, and heartbeats also go on the live channel, so an export the tab claimed keeps
 * its lease while ranged media reads are held for 20 s each on the browser's six connections.
 */
test('an editor tab on a cut of many clips keeps its export lease while media reads are slow', async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(300_000);
  const api = new Api(request);
  const { id: pid } = await api.call<{ id: string }>('POST', '/projects', {
    kind: 'edit',
    title: `Slow media (${testInfo.project.name})`,
    settings: TINY,
  });
  // 40 different clips: every item reads a file of its own (with every lane reading at once, the tab's requests
  // would wait minutes behind the held reads: the claim, the heartbeats, the export's inputs)
  const medias: unknown[] = [];
  for (let k = 0; k < 40; k++) {
    const file = testInfo.outputPath(`clip-${k}.mp4`);
    execFileSync(ffmpeg, [
      '-y',
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      `color=c=0x${(0x203040 + k * 0x0b0907).toString(16).slice(-6)}:size=320x180:rate=24:duration=1.5`,
      '-f',
      'lavfi',
      '-i',
      `sine=frequency=${300 + k * 20}:duration=1.5`,
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-shortest',
      file,
    ]);
    let banner = '';
    try {
      execFileSync(ffmpeg, ['-hide_banner', '-i', file], { stdio: 'pipe' });
    } catch (err) {
      banner = String((err as { stderr?: Buffer }).stderr ?? '');
    }
    const res = await request.post(`/api/projects/${pid}/uploads`, {
      multipart: {
        meta: JSON.stringify({ probe: parseProbe(banner) }),
        file: { name: `clip-${k}.mp4`, mimeType: 'video/mp4', buffer: readFileSync(file) },
      },
    });
    expect(res.ok()).toBe(true);
    medias.push((await res.json()).media);
  }
  const track = (await api.call<any>('GET', `/projects/${pid}/timeline`)).tracks[0].id;
  await api.call('POST', `/projects/${pid}/timeline/ops`, {
    ops: medias.map((media, k) => ({
      op: 'insert',
      trackId: track,
      item: { kind: 'video', source: { type: 'media', media }, in: 0, out: 1.5, start: k * 1.5 },
    })),
  });
  const { export: queued } = await api.call<any>('POST', `/projects/${pid}/exports`, {
    quality: 'draft',
    engine: 'ffmpeg',
  });

  // The editor through the slow-media proxy claims the export at once
  await page.goto(at(PORTS.slowMedia, `/p/${pid}/editor`));
  const job = async () =>
    (await api.call<any[]>('GET', `/projects/${pid}/jobs?limit=20`)).find((j) => j.kind === 'export.render');
  await expect
    .poll(async () => (await job())?.status ?? 'queued', { timeout: 60_000 })
    .toMatch(/running|succeeded/);
  // ...and finishes it on its first lease: a lost lease would put it back in the queue (a second attempt)
  await expect
    .poll(
      async () => (await api.call<any>('GET', `/projects/${pid}/state`)).docs.exports[queued.id]?.status,
      {
        timeout: 240_000,
        intervals: [2000],
      },
    )
    .toBe('succeeded');
  const done = await job();
  expect(done.attempts).toBe(1);
  expect(done.error?.code).not.toBe('lease_expired');
});
