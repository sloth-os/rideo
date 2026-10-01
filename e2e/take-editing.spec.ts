import { expect, test } from '@playwright/test';
import { Api } from './support/api';

test('a take is relit and extended; the cut gets generated frames after an item', async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(240_000);
  const api = new Api(request);
  const pid = await api.storyProject(`Take editing (${testInfo.project.name})`, {
    screenplay: true,
    settings: { storyboard: { enabled: false } },
  });
  await api.readyForStoryboard(pid);
  let state = await api.call<any>('GET', `/projects/${pid}/state`);
  const plan = await api.call<any>('POST', `/projects/${pid}/clips/plan`, {
    sceneId: state.docs.screenplay.scenes[0].id,
    generate: true,
  });
  await api.waitJob(pid, plan.id);
  await api.waitIdle(pid, 120_000);

  await page.goto(`/p/${pid}/clips`);
  const row = page.locator('[data-entity^="shot:"]').first();
  const tile = row.locator('[data-entity^="take:"]').first();
  await tile.getByTestId('edit-take').click();
  await page.getByTestId('edit-kind').selectOption('relight');
  await page.getByTestId('edit-instruction').fill('warm golden-hour light from the window');
  await page.getByTestId('edit-submit').click();
  await expect(row.getByTestId('take-lineage').filter({ hasText: 'edited · relight' })).toBeVisible({
    timeout: 90_000,
  });
  await api.waitIdle(pid);

  const original = row.locator('[data-entity^="take:"]').last();
  await original.getByTestId('extend-take').click();
  await page.getByTestId('extend-take-seconds').selectOption('2');
  await page.getByTestId('extend-take-prompt').fill('she turns to the window');
  await page.getByTestId('extend-submit').click();
  await expect(row.getByTestId('take-lineage').filter({ hasText: 'extended +2s' })).toBeVisible({
    timeout: 90_000,
  });
  await api.waitIdle(pid);

  // Generative extend in the cut
  state = await api.call<any>('GET', `/projects/${pid}/state`);
  const clip = Object.values<any>(state.docs.clips)[0];
  await api.call('POST', `/projects/${pid}/clips/${clip.id}/approve`);
  await api.call('POST', `/projects/${pid}/timeline/assemble`, {});
  const before = (await api.call<any>('GET', `/projects/${pid}/timeline`)).tracks[0].items.length;
  await page.goto(`/p/${pid}/editor`);
  // Phones list the items; wider screens show the timeline lanes (docs/brand.md#layout-and-responsiveness).
  const phone = (page.viewportSize()?.width ?? 1280) < 768;
  const items = phone
    ? page.getByTestId('timeline-list').locator('li button')
    : page.locator('[data-track="video"] [data-testid="timeline-item"]');
  await expect(items.first()).toBeVisible();
  await items.first().click();
  const extend = page.getByTestId('generative-extend');
  await expect(extend).toBeVisible();
  await extend.getByTestId('extend-seconds').selectOption('1');
  await extend.getByTestId('extend-item').click();
  await expect(items).toHaveCount(before + 1, { timeout: 90_000 });
  const timeline = await api.call<any>('GET', `/projects/${pid}/timeline`);
  expect(timeline.tracks[0].items[1]).toMatchObject({ out: 1, source: { type: 'media' } });
});
