import { expect, test } from '@playwright/test';
import { Api } from './support/api';
import { exportInThisTab } from './support/ui';

/** Finishing and deliverables (docs/design/finishing.md) from the export dialog, desktop and phone. */
test('a vertical cut-down is reframed with thumbnails; a ProRes master is delivered', async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(360_000);
  const api = new Api(request);
  const pid = await api.storyProject(`Finishing (${testInfo.project.name})`, {
    screenplay: true,
    settings: { storyboard: { enabled: false } },
  });
  await api.readyForStoryboard(pid);
  const state = await api.call<any>('GET', `/projects/${pid}/state`);
  const plan = await api.call<any>('POST', `/projects/${pid}/clips/plan`, {
    sceneId: state.docs.screenplay.scenes[0].id,
    generate: true,
  });
  await api.waitJob(pid, plan.id);
  await api.waitIdle(pid, 120_000);
  const clip = Object.values<any>((await api.call<any>('GET', `/projects/${pid}/state`)).docs.clips)[0];
  await api.call('POST', `/projects/${pid}/clips/${clip.id}/approve`);
  await api.call('POST', `/projects/${pid}/timeline/assemble`, { captions: true });

  await page.goto(`/p/${pid}/editor`);
  await expect(page.getByTestId('live-status')).toHaveAttribute('data-status', 'live');
  // The vertical preset: auto-reframed to 9:16, cut down, upscaled by the gateway's enhancement model, thumbnails
  await exportInThisTab(page, { preset: 'vertical', quality: 'draft', engine: 'ffmpeg' });
  await page.goto(`/p/${pid}/exports`);
  const card = page.locator('[data-entity^="export:"]').first();
  await expect(card.getByTestId('export-delivery')).toHaveText('vertical · mp4 · 406×720 · 24 fps · 9:16');
  await expect(card.getByTestId('export-enhance')).toHaveText('upscaled · mock-enhance-v1');
  await expect(card.getByTestId('export-thumbnails').locator('img')).toHaveCount(3);
  const takes = Object.values<any>((await api.call<any>('GET', `/projects/${pid}/state`)).docs.clips).flatMap(
    (c) => c.shots.flatMap((s: any) => s.takes.filter((t: any) => t.id === s.selectedTakeId)),
  );
  expect(takes.every((t: any) => t.focus?.length === 3)).toBe(true);

  // A ProRes master: listed with its download, not played in the browser
  await page.goto(`/p/${pid}/editor`);
  await exportInThisTab(page, { preset: 'master_prores', quality: 'draft', engine: 'ffmpeg' });
  await page.goto(`/p/${pid}/exports`);
  const master = page.locator('[data-entity^="export:"]').first();
  await expect(master).toContainText('ProRes master');
  await expect(master.getByTestId('export-delivery')).toContainText('master_prores · prores');
  await expect(master.getByTestId('download-export')).toBeVisible();
  await expect(master.getByTestId('download-stem-music')).toBeVisible();
});
