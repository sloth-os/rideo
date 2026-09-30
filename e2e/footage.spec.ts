import { expect, test } from '@playwright/test';
import { Api, makeFootage, projectIdFrom } from './support/api';

test('upload → AI analysis → suggestions → auto edit → WebCodecs browser export', async ({
  page,
  request,
}, testInfo) => {
  const footage = makeFootage(testInfo.outputPath('footage.mp4'));

  await page.goto('/');
  await page.getByTestId('new-edit').click();
  await page.getByLabel('Title').fill('E2E footage');
  await page.getByTestId('create-project-submit').click();
  await expect(page).toHaveURL(/\/resources$/);
  await new Api(request).shrink(projectIdFrom(page.url()));

  await page.getByTestId('resource-upload').setInputFiles(footage);
  const analyze = page.getByTestId('approve-resources');
  await expect(analyze).toBeEnabled({ timeout: 60_000 });
  await analyze.click();

  await expect(page).toHaveURL(/\/analysis$/);
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

  await page.getByTestId('open-export').click();
  await expect(page.getByTestId('webcodecs-caps')).toContainText('WebCodecs');
  await page.getByTestId('export-browser').click();
  const uploaded = page.getByTestId('toast').filter({ hasText: 'Browser render uploaded' });
  const failed = page.getByTestId('export-error');
  await expect(uploaded.or(failed)).toBeVisible({ timeout: 120_000 });
  if (await failed.isVisible()) throw new Error(`browser export failed: ${await failed.innerText()}`);

  await page.getByTestId('nav-exports').click();
  const card = page.locator('[data-entity^="export:"]').first();
  await expect(card).toContainText('browser');
  await expect(card.getByTestId('download-export')).toBeVisible({ timeout: 120_000 });
  await card.getByTestId('verify-export').click();
  await expect(card.getByTestId('verify-result')).toContainText('found');
});
