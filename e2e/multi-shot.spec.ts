import { expect, test } from '@playwright/test';
import { Api } from './support/api';

/** Multi-shot generation (docs/design/multi-shot.md) through the clip review, desktop and phone. */
test('consecutive shots render in one request and come back as takes of their own shots', async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(300_000);
  const api = new Api(request);
  // Three 10 s shots (planned on the 10 s model); the multi-shot model renders the first two together.
  const pid = await api.storyProject(`Multi-shot (${testInfo.project.name})`, {
    screenplay: true,
    settings: { storyboard: { enabled: false }, targetDurationSec: 60, pilotDurationSec: 30 },
  });
  await api.readyForStoryboard(pid);
  const state = await api.call<any>('GET', `/projects/${pid}/state`);
  const plan = await api.call<any>('POST', `/projects/${pid}/clips/plan`, {
    sceneId: state.docs.screenplay.scenes[0].id,
  });
  await api.waitJob(pid, plan.id);
  await api.call('PATCH', `/projects/${pid}`, { settings: { models: { video: 'mock-multishot-v1' } } });
  const setting = async () =>
    (await api.call<any>('GET', `/projects/${pid}/state`)).docs.project.settings.generation.multiShot;

  // Multi-shot is a project setting (on by default)
  await page.goto(`/p/${pid}/overview`);
  await page.getByTestId('open-settings').click();
  await expect(page.locator('input[name="multiShot"]')).toBeChecked();
  await page.locator('input[name="multiShot"]').uncheck();
  await page.getByTestId('settings-save').click();
  await expect.poll(setting).toBe('off');
  await page.getByTestId('open-settings').click();
  await page.locator('input[name="multiShot"]').check();
  await page.getByTestId('settings-save').click();
  await expect.poll(setting).toBe('auto');

  await page.goto(`/p/${pid}/clips`);
  await page.getByTestId('generate-clip').click();
  const badges = page.getByTestId('take-multishot');
  await expect(badges).toHaveCount(2, { timeout: 180_000 });
  await expect(badges.filter({ hasText: 'shot 1 of 2' })).toBeVisible();
  await expect(badges.filter({ hasText: 'shot 2 of 2' })).toBeVisible();
  await api.waitIdle(pid, 180_000);
  // the third shot is generated on its own and has no badge
  const rows = page.locator('[data-entity^="shot:"]');
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(2).locator('[data-entity^="take:"]')).toHaveCount(1);
  await expect(rows.nth(2).getByTestId('take-multishot')).toHaveCount(0);
  const jobs = await api.call<any[]>('GET', `/projects/${pid}/jobs`);
  expect(jobs.filter((j) => j.kind === 'shot.group')).toHaveLength(1);
});
