import { expect, test } from '@playwright/test';
import { Api, projectIdFrom } from './support/api';
import { exportInThisTab } from './support/ui';

test('idea → screenplay → locked cast → pilot → production → edit → watermarked export', async ({
  page,
  request,
}) => {
  const api = new Api(request);
  // Emulate a browser without an H.264 decoder (docs/testing.md): the preview must use local proxies built with
  // ffmpeg.wasm, and `auto` must render the export with the ffmpeg.wasm engine.
  await page.addInitScript(() => {
    const original = VideoDecoder.isConfigSupported.bind(VideoDecoder);
    VideoDecoder.isConfigSupported = async (config) =>
      config.codec.startsWith('avc1') ? { supported: false, config } : original(config);
  });

  await page.goto('/');
  await page.getByTestId('new-story').click();
  await page.getByLabel('Title').fill('E2E Keeper');
  await page
    .getByRole('textbox', { name: /^Idea/ })
    .fill('A lighthouse keeper receives letters from the future');
  await page.locator('select[name=target]').selectOption('60');
  await page.getByTestId('create-project-submit').click();
  await expect(page).toHaveURL(/\/p\/prj_[0-9a-z]+\/story$/);
  const pid = projectIdFrom(page.url());
  await api.shrink(pid);

  // Screenplay
  await page.getByTestId('generate-screenplay').click();
  await expect(page.getByTestId('scenes')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('approve-screenplay')).toBeEnabled({ timeout: 60_000 });
  await page.getByTestId('approve-screenplay').click();

  // Cast: generate references, approve them, lock every character, then lock the cast
  await page.getByTestId('nav-cast').click();
  const names = page.getByTestId('character-name');
  await expect(names.first()).toBeVisible();
  const cast = await names.count();
  expect(cast).toBeGreaterThan(0);
  const approveCast = page.getByTestId('approve-cast');
  await expect(approveCast).toBeDisabled();
  for (let i = 0; i < cast; i++) await page.getByTestId('generate-refs').nth(i).click();
  await api.waitIdle(pid);
  await expect(page.getByTestId('reference').first()).toBeVisible();
  const approveAll = page.getByTestId('approve-all-references');
  for (let left = await approveAll.count(); left > 0; left--) {
    await approveAll.first().click();
    await expect(approveAll).toHaveCount(left - 1);
  }
  const lock = page.getByTestId('lock-character');
  for (let left = await lock.count(); left > 0; left--) {
    await lock.first().click();
    await expect(lock).toHaveCount(left - 1);
  }
  await expect(page.getByTestId('unlock-character')).toHaveCount(cast);
  // The cast gate also waits for the locations and props in use (docs/design/elements.md)
  await expect(approveCast).toBeDisabled();
  await expect(page.getByTestId('cast-unmet')).toContainText('not locked');
  await page.getByTestId('go-elements').first().click();
  await expect(page).toHaveURL(/\/elements$/);
  const generateEls = page.getByTestId('generate-element-refs');
  const elementCount = await generateEls.count();
  expect(elementCount).toBeGreaterThan(1);
  for (let i = 0; i < elementCount; i++) await generateEls.nth(i).click();
  await api.waitIdle(pid);
  await expect(page.getByTestId('element-reference').first()).toBeVisible();
  const approveEls = page.getByTestId('approve-all-element-references');
  for (let left = await approveEls.count(); left > 0; left--) {
    await approveEls.first().click();
    await expect(approveEls).toHaveCount(left - 1);
  }
  const lockEls = page.getByTestId('lock-element');
  for (let left = await lockEls.count(); left > 0; left--) {
    await lockEls.first().click();
    await expect(lockEls).toHaveCount(left - 1);
  }
  await expect(page.getByTestId('unlock-element')).toHaveCount(elementCount);
  await page.getByTestId('nav-cast').click();
  await expect(approveCast).toBeEnabled();
  await approveCast.click();

  // Resources → pilot
  await page.getByTestId('nav-resources').click();
  await page.getByTestId('approve-resources').click();
  await expect(page).toHaveURL(/\/clips$/);

  // Pilot clip: plan + generate the first scene, check the consistency gate, approve
  await page.getByTestId('plan-generate-scene').first().click();
  const approveClip = page.getByTestId('approve-clip');
  await expect(approveClip.first()).toBeEnabled({ timeout: 120_000 });
  await expect(page.getByText(/passed 0\.\d\d/).first()).toBeVisible();
  await approveClip.first().click();
  const approveStage = page.getByTestId('approve-stage');
  await expect(approveStage).toHaveText(/Approve pilot/);
  await expect(approveStage).toBeEnabled();
  await approveStage.click();

  // Production: generate the remaining clips up to the target, review and approve them
  await expect(approveStage).toHaveText(/Approve production/);
  await page.getByTestId('start-batch').click();
  await expect(page.getByTestId('pause-batch')).toBeVisible();
  await api.waitIdle(pid, 180_000);
  await expect(page.getByTestId('pause-batch')).toBeHidden();
  for (let left = await approveClip.count(); left > 0; left--) {
    await expect(approveClip.first()).toBeEnabled();
    await approveClip.first().click();
    await expect(approveClip).toHaveCount(left - 1);
  }
  await expect(approveStage).toBeEnabled();
  await approveStage.click();

  // Editor: assemble, split at the playhead, trim
  await page.getByTestId('nav-editor').click();
  await page.getByTestId('assemble').click();
  const videoItems = page.locator('[data-track="video"] [data-testid="timeline-item"]');
  await expect(videoItems.first()).toBeVisible();
  const before = await videoItems.count();
  expect(before).toBeGreaterThanOrEqual(2);
  await videoItems.first().click();
  await page.getByLabel('Seek').fill('2');
  await expect(page.getByTestId('timecode')).toContainText('00:00:02:00');
  // With H.264 hidden from WebCodecs the preview can only show picture through local proxies.
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const c = document.querySelector<HTMLCanvasElement>('[data-testid=preview-canvas]')!;
          const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
          let lit = 0;
          for (let i = 0; i < d.length; i += 4 * 97) if (d[i]! + d[i + 1]! + d[i + 2]! > 90) lit++;
          return lit;
        }),
      { timeout: 60_000 },
    )
    .toBeGreaterThan(20);
  await page.getByTestId('split-item').click();
  await expect(videoItems).toHaveCount(before + 1);
  await videoItems.first().click();
  await page.getByTestId('trim-out').fill('1.5');
  await page.getByTestId('trim-out').blur();
  await expect
    .poll(async () => (await api.call('GET', `/projects/${pid}/timeline`)).tracks[0].items[0].out)
    .toBe(1.5);

  // Drag the right edge of the second item 24 px left: at 40 px/s it gets 0.6 s shorter
  const secondOut = async () => (await api.call('GET', `/projects/${pid}/timeline`)).tracks[0].items[1].out;
  const outBefore = await secondOut();
  await videoItems.nth(1).scrollIntoViewIfNeeded();
  const edge = (await videoItems.nth(1).getByTestId('trim-handle-end').boundingBox())!;
  await page.mouse.move(edge.x + edge.width / 2, edge.y + edge.height / 2);
  await page.mouse.down();
  await page.mouse.move(edge.x + edge.width / 2 - 24, edge.y + edge.height / 2, { steps: 4 });
  await page.mouse.up();
  await expect.poll(secondOut).toBeCloseTo(outBefore - 0.6, 2);

  // Export: rendered in this tab (ffmpeg.wasm: Playwright's Chromium cannot decode H.264 with WebCodecs),
  // then watermarked by the server
  await exportInThisTab(page, { quality: 'draft' });
  await page.getByTestId('nav-exports').click();
  const card = page.locator('[data-entity^="export:"]').first();
  await expect(card).toContainText('ffmpeg');
  await expect(card.getByTestId('download-export')).toBeVisible({ timeout: 120_000 });
  await card.getByTestId('verify-export').click();
  await expect(card.getByTestId('verify-result')).toContainText('found');
  // C2PA Content Credentials: an AI-generated composite of the takes, bound to the watermark
  const credentials = card.getByTestId('content-credentials');
  await expect(credentials).toContainText('AI-generated');
  await expect(credentials).toContainText('bound to the watermark');
});
