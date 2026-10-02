import { expect, test } from '@playwright/test';
import { Api, makeFootage, projectIdFrom } from './support/api';
import { exportInThisTab } from './support/ui';

test('upload → analysis in the browser → suggestions → auto edit → exports with ffmpeg.wasm and WebCodecs', async ({
  page,
  request,
}, testInfo) => {
  const api = new Api(request);
  const footage = makeFootage(testInfo.outputPath('footage.mp4'));

  await page.goto('/');
  await page.getByTestId('new-edit').click();
  await page.getByLabel('Title').fill('E2E footage');
  await page.getByTestId('create-project-submit').click();
  await expect(page).toHaveURL(/\/resources$/);
  const pid = projectIdFrom(page.url());
  await api.shrink(pid);

  // The browser probes the file and makes its poster with ffmpeg.wasm, so the upload is ready at once.
  await page.getByTestId('resource-upload').setInputFiles(footage);
  const analyze = page.getByTestId('approve-resources');
  await expect(analyze).toBeEnabled({ timeout: 60_000 });
  const [resource] = Object.values(
    (await api.call<any>('GET', `/projects/${pid}/state`)).docs.resources,
  ) as any[];
  expect(resource).toMatchObject({
    status: 'ready',
    media: { videoCodec: 'h264', durationSec: 9, poster: { mime: 'image/jpeg' } },
  });
  expect(
    (await api.call<any[]>('GET', `/projects/${pid}/jobs`)).filter((j) => j.kind === 'media.process'),
  ).toEqual([]);
  await analyze.click();

  // The analysis signals are computed in this tab; the AI suggestions run on the server.
  await expect(page).toHaveURL(/\/analysis$/);
  await expect(page.getByTestId('job-where').filter({ hasText: 'in this tab' }).first()).toBeVisible();
  const summary = page.getByTestId('analysis-summary');
  await expect(summary).toContainText('completed', { timeout: 120_000 });
  await expect(summary.getByRole('group', { name: 'Signal analysis' })).toBeVisible();
  await expect(page.getByTestId('accept-suggestion').first()).toBeVisible();
  await page.getByTestId('accept-all').click();
  const autoEdit = page.getByTestId('auto-edit');
  await expect(autoEdit).toBeEnabled();
  await autoEdit.click();

  await expect(page).toHaveURL(/\/editor$/);
  await expect(page.locator('[data-track="video"] [data-testid="timeline-item"]').first()).toBeVisible();
  await expect(page.getByTestId('preview-canvas')).toBeVisible();

  await exportInThisTab(page, { engine: 'ffmpeg' });
  await exportInThisTab(page, { engine: 'webcodecs', quality: 'draft' });

  await page.getByTestId('nav-exports').click();
  const cards = page.locator('[data-entity^="export:"]');
  await expect(cards).toHaveCount(2);
  for (const engine of ['webcodecs', 'ffmpeg']) {
    const card = cards.filter({ hasText: engine });
    // both exports finish one after the other on the media lane
    await expect(card.getByTestId('download-export')).toBeVisible({ timeout: 120_000 });
    await card.getByTestId('verify-export').click();
    await expect(card.getByTestId('verify-result')).toContainText('found');
  }
});
