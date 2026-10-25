import { expect, test } from '@playwright/test';
import { Api } from './support/api';

/** The Insights view and telemetry from the studio (docs/design/observability.md), desktop and phone. */
test('a generated project shows its cost, times, quality and improvements; the studio reports its vitals', async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(240_000);
  const api = new Api(request);
  const pid = await api.storyProject(`Insights (${testInfo.project.name})`, {
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

  await page.goto(`/p/${pid}/insights`);
  const insights = page.getByTestId('insights');
  await expect(insights).toBeVisible();
  // Priced with the stack's RIDEO_PRICES.
  await expect(page.getByTestId('insights-cost-total')).toContainText('$');
  await expect(page.getByTestId('insights-cost')).toContainText('mock-video-v1');
  await expect(page.getByTestId('insights-time')).toContainText('shot.generate');
  await expect(page.getByTestId('insights-first-try')).toContainText('%');
  await expect(page.getByTestId('insights-improvements')).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);

  // Hiding the page sends what the studio measured (the project's load at least).
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect
    .poll(async () =>
      (await (await request.get('/metrics')).text()).includes(
        'rideo_web_timing_seconds_count{op="project_load"}',
      ),
    )
    .toBe(true);
});
