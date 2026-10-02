import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { expect, type Page, test } from '@playwright/test';
import { newId, parseProbe } from '@rideo/shared';
import { PNG } from 'pngjs';
import { Api, makeFootage } from './support/api';
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
