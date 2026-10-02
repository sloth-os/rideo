import { writeFileSync } from 'node:fs';
import { expect, type Page, test } from '@playwright/test';
import { Api, makeFootage } from './support/api';
import { exportInThisTab } from './support/ui';

/** Editor depth (docs/design/editor.md): overlays, keyframes, ramps, LUTs, a removed background, lanes, transcript. */
test('an overlay with keyframes and a removed background, a ramp and a LUT, waveforms and filmstrips, filler words cut', async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(240_000);
  const api = new Api(request);
  const pid = await api.editProjectWithClip(
    `Layers (${testInfo.project.name})`,
    makeFootage(testInfo.outputPath('clip.mp4')),
  );
  const phone = (page.viewportSize()?.width ?? 1280) < 768;
  const timeline = () => api.call<any>('GET', `/projects/${pid}/timeline`);
  const tracks = async () => (await timeline()).tracks.filter((t: any) => t.kind === 'video');
  const select = async (p: Page, which: 'primary' | 'overlay') => {
    if (phone)
      await (which === 'overlay'
        ? p.getByTestId('overlay-item').first()
        : p.getByTestId('timeline-list').locator('button').first()
      ).click();
    else
      await p
        .locator('[data-track="video"]')
        .nth(which === 'overlay' ? 1 : 0)
        .getByTestId('timeline-item')
        .first()
        .click();
  };

  await page.goto(`/p/${pid}/editor`);
  // B-roll from the project's footage, at the playhead, on a new overlay track
  await page.getByTestId('overlay-open').click();
  await page.getByTestId('overlay-option').first().click();
  await expect.poll(async () => (await tracks()).length).toBe(2);
  await select(page, 'overlay');
  await expect(page.getByTestId('transform-section')).toBeVisible();
  await page.getByTestId('transform-preset').selectOption('pip');
  await expect
    .poll(async () => (await tracks())[1].items[0].transform?.keyframes)
    .toEqual([{ t: 0, x: 0.78, y: 0.22, scale: 0.35 }]);
  // Remove the background with the gateway's segmentation model
  await expect(page.getByTestId('mask-subject')).toHaveValue('the person');
  await page.getByTestId('mask-start').click();
  await expect(page.getByTestId('mask-badge')).toContainText('the person', { timeout: 90_000 });

  // The primary item: a speed ramp and a LUT uploaded from this machine
  await select(page, 'primary');
  await page.getByTestId('ramp-preset').selectOption('ease_in');
  await expect.poll(async () => (await tracks())[0].items[0].ramp?.points.length).toBe(2);
  const cube = testInfo.outputPath('Warm look.cube');
  writeFileSync(
    cube,
    `LUT_3D_SIZE 2\n${[0, 1]
      .flatMap((b) =>
        [0, 1].flatMap((g) => [0, 1].map((r) => `${Math.min(1, r + 0.1)} ${g * 0.95} ${b * 0.8}`)),
      )
      .join('\n')}\n`,
  );
  await page.getByTestId('lut-upload-file').setInputFiles(cube);
  await expect(page.getByTestId('lut-select').locator('option:checked')).toHaveText('Warm look.cube');
  await expect.poll(async () => (await tracks())[0].items[0].lut?.intensity).toBe(1);
  if (!phone) {
    await expect(page.getByTestId('item-shaped').first()).toBeVisible();
    await expect(page.locator('[data-testid="filmstrip"][data-ready="true"]').first()).toBeAttached({
      timeout: 90_000,
    });
    await expect(page.locator('[data-testid="waveform"][data-ready="true"]').first()).toBeAttached({
      timeout: 90_000,
    });
  }

  // The layered cut renders in this tab with ffmpeg.wasm
  await exportInThisTab(page, { quality: 'draft', engine: 'ffmpeg' });

  // Edit by text: the analysis (signals in this tab, speech-to-text on the server), then the fillers go
  const state = await api.call<any>('GET', `/projects/${pid}/state`);
  const resourceId = Object.values<any>(state.docs.resources).find((r) => r.kind === 'video').id;
  await api.call('POST', `/projects/${pid}/analyses`, { resourceId });
  const fillers = page.getByTestId('transcript-fillers');
  await expect(fillers).toHaveAttribute('data-count', '2', { timeout: 120_000 });
  await expect(page.getByTestId('transcript-word').first()).toBeVisible();
  await fillers.click();
  await expect.poll(async () => (await tracks())[0].items.length).toBe(3);
  await expect(fillers).toHaveAttribute('data-count', '0');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
});
