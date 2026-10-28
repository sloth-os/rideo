import { expect, test } from '@playwright/test';
import { Api } from './support/api';
import { at, PORTS } from './support/ports';

/**
 * A model that keeps failing is paused and its jobs wait for it, saying why (docs/design/ai-gateway.md#outages), on
 * a studio of its own per viewport: a pause would slow every spec of a shared studio.
 */
test.use({
  // biome-ignore lint/correctness/noEmptyPattern: Playwright reads a fixture's dependencies from this parameter
  baseURL: async ({}, use, testInfo) =>
    use(at(testInfo.project.name === 'mobile' ? PORTS.outageMobile : PORTS.outage)),
});

/** The mock gateway answers `503 system cpu overloaded` to every chat call that mentions this (OVERLOAD_MARKER). */
const OVERLOADED = '[provider overloaded]';

test('a job waiting for a paused model says why', async ({ page, request }, testInfo) => {
  test.setTimeout(150_000);
  const api = new Api(request);
  const pid = await api.storyProject(`Outage (${testInfo.project.name})`, { screenplay: true });
  const sp = (await api.call<any>('GET', `/projects/${pid}/state`)).docs.screenplay;
  const scene = [...sp.scenes].sort((a: any, b: any) => a.index - b.index)[0];
  await api.call('PATCH', `/projects/${pid}/screenplay`, {
    upsertScenes: [{ ...scene, action: `${scene.action} ${OVERLOADED}` }],
  });

  // Planning the scene: the provider turns every call away, the model is paused, the job waits and says so
  await page.goto(`/p/${pid}/clips`);
  await page.getByTestId('plan-scene').first().click();
  // The planning job's row in the Clips view (the workspace's jobs panel shows it too on wide screens)
  const waiting = page.getByTestId('view-clips').getByTestId('job-waiting');
  await expect(waiting).toContainText(/is paused after \d+ failed calls in a row; next try in \d+ s/, {
    timeout: 120_000,
  });
  await expect(waiting).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);

  // Cancelled, it stops waiting
  await page.getByTestId('view-clips').getByRole('button', { name: 'Cancel job' }).first().click();
  await expect(waiting).toHaveCount(0);
});
