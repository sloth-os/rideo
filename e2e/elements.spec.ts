import { expect, test } from '@playwright/test';
import { Api } from './support/api';

test('locations and props from the screenplay are approved and locked, and scenes link them', async ({
  page,
  request,
}, testInfo) => {
  const api = new Api(request);
  const pid = await api.storyProject(`Elements (${testInfo.project.name})`, { screenplay: true });
  await page.goto(`/p/${pid}/elements`);
  const locations = page.getByTestId('elements-location');
  await expect(locations.getByTestId('element-name').first()).toHaveText('lighthouse lamp room');
  const lamp = locations.locator('[data-entity^="element:"]').first();
  await expect(lamp).toContainText('in use');
  await lamp.getByTestId('generate-element-refs').click();
  await expect(lamp.getByTestId('element-reference')).toHaveCount(2, { timeout: 60_000 });
  await lamp.getByTestId('approve-all-element-references').click();
  await expect(lamp.getByTestId('lock-element')).toBeEnabled();
  await lamp.getByTestId('lock-element').click();
  await expect(lamp.getByTestId('unlock-element')).toBeVisible();
  await expect(lamp).toContainText('locked v1');

  // A new prop from the dialog, linked to the first scene in the Story view
  await page.getByTestId('add-element').click();
  await page.getByTestId('new-element-kind').selectOption('prop');
  await page.getByTestId('new-element-name').fill('Ship in a bottle');
  await page.getByTestId('add-element-submit').click();
  await expect(page.getByTestId('elements-prop')).toContainText('Ship in a bottle');
  await page.goto(`/p/${pid}/story`);
  const scene = page.locator('[data-entity^="scene:"]').first();
  await expect(scene.getByTestId('scene-location')).toHaveValue(/ele_/);
  await scene.getByLabel('prop or style').selectOption({ label: 'Ship in a bottle' });
  await expect(scene.getByTestId('scene-elements').getByTestId('element-chip')).toContainText([
    'Ship in a bottle',
  ]);
  const sp = (await api.call<any>('GET', `/projects/${pid}/state`)).docs.screenplay;
  const elements = (await api.call<any>('GET', `/projects/${pid}/state`)).docs.elements;
  expect(sp.scenes[0].elementIds.map((id: string) => elements[id].name)).toContain('Ship in a bottle');
});
