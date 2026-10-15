import { expect, test } from '@playwright/test';
import { Api, makeFootage, projectIdFrom } from '../support/api';
import { counters } from './support';

test('footage → the vision model summarizes it and suggests edits → accept → auto edit', async ({
  page,
  request,
}, testInfo) => {
  const api = new Api(request);
  const before = await counters(request);

  await page.goto('/');
  await page.getByTestId('new-edit').click();
  await page.getByLabel('Title').fill('Real models: footage');
  await page.getByTestId('create-project-submit').click();
  await expect(page).toHaveURL(/\/resources$/);
  const pid = projectIdFrom(page.url());
  // 9 s: a test pattern with a tone, a second of black, a fractal, 2.5 s of silence (e2e/support/api.ts)
  await page.getByTestId('resource-upload').setInputFiles(makeFootage(testInfo.outputPath('footage.mp4')));
  const analyze = page.getByTestId('approve-resources');
  await expect(analyze).toBeEnabled();
  await analyze.click();

  // The signals are measured in this tab; the model gets them with a thumbnail per scene
  await expect(page).toHaveURL(/\/analysis$/);
  await expect(page.getByTestId('analysis-summary')).toContainText('completed', { timeout: 15 * 60_000 });
  const { docs } = await api.call('GET', `/projects/${pid}/state`);
  const [analysis] = Object.values<any>(docs.analyses);
  // Without the model the analysis would fall back to the rules alone: its summary and suggestions are there
  expect((await counters(request))('rideo_llm_calls_total', { status: 'ok', task: 'footage.analyze' })).toBe(
    before('rideo_llm_calls_total', { status: 'ok', task: 'footage.analyze' }) + 1,
  );
  expect(analysis.summary).toMatch(/\S.* \(9\.\ds, \d+ scene\(s\)/);
  const ai = analysis.suggestions.filter((s: { source: string }) => s.source === 'ai');
  expect(ai.length, 'suggestions from the model').toBeGreaterThan(0);
  for (const s of ai) {
    expect(s.description).not.toBe('');
    expect(s.confidence).toBeGreaterThanOrEqual(0);
  }

  await expect(page.getByTestId('accept-suggestion').first()).toBeVisible();
  await page.getByTestId('accept-all').click();
  const autoEdit = page.getByTestId('auto-edit');
  await expect(autoEdit).toBeEnabled();
  await autoEdit.click();
  await expect(page).toHaveURL(/\/editor$/);
  await expect(page.locator('[data-track="video"] [data-testid="timeline-item"]').first()).toBeVisible();
});
