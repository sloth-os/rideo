import { expect, test } from '@playwright/test';
import { Api } from './support/api';

// Chromium's fake camera and microphone (a moving pattern and a beep), allowed without a prompt.
test.use({
  permissions: ['camera', 'microphone'],
  launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] },
});

/** Performance-driven animation (docs/design/performance.md): recorded in the studio, acted by the cast. */
test('a performance is recorded on a shot, and its take is acted by the performance model', async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(240_000);
  const api = new Api(request);
  const pid = await api.storyProject(`Performance (${testInfo.project.name})`, {
    screenplay: true,
    settings: { storyboard: { enabled: false } },
  });
  await api.readyForStoryboard(pid);
  const state = await api.call<any>('GET', `/projects/${pid}/state`);
  const plan = await api.call<any>('POST', `/projects/${pid}/clips/plan`, {
    sceneId: state.docs.screenplay.scenes[0].id,
  });
  await api.waitJob(pid, plan.id);
  const shotOf = async (id: string) => {
    const clip = Object.values<any>((await api.call<any>('GET', `/projects/${pid}/state`)).docs.clips)[0];
    return clip.shots.find((s: { id: string }) => s.id === id);
  };

  await page.goto(`/p/${pid}/clips`);
  const row = page.locator('[data-entity^="shot:"]').first();
  const shotId = (await row.getAttribute('data-entity'))!.slice('shot:'.length);
  await row.getByTestId('shot-direct').click();
  const panel = row.getByTestId('direct-panel');
  await panel.getByTestId('performance-open').click();

  // Countdown, a second and a half of acting, then the recording becomes the shot's performance
  const recorder = page.getByTestId('performance-recorder');
  await expect(recorder).toHaveAttribute('data-phase', 'ready');
  await expect(page.getByTestId('performance-live')).toBeVisible();
  await page.getByTestId('performance-record').click();
  await expect(page.getByTestId('performance-countdown')).toHaveText('3');
  await expect(recorder).toHaveAttribute('data-phase', 'recording', { timeout: 6000 });
  await page.waitForTimeout(1500);
  await page.getByTestId('performance-stop').click();
  await expect(recorder).toHaveAttribute('data-phase', 'recorded');
  await expect(page.getByTestId('performance-playback')).toBeVisible();
  await page.getByTestId('performance-use').click();
  await expect(recorder).toBeHidden({ timeout: 60_000 });
  await expect.poll(async () => (await shotOf(shotId)).motionReference?.mode).toBe('performance');
  await expect(panel.getByTestId('motion-ref-mode')).toHaveValue('performance');
  await expect(panel.getByTestId('performance-model')).toContainText('mock-performance-v1');

  // The take: the performance model, the recorded performance, verified like every take
  await row.getByTestId('regenerate-shot').click();
  await expect
    .poll(async () => (await shotOf(shotId)).takes.at(-1)?.request.videoModel, { timeout: 150_000 })
    .toBe('mock-performance-v1');
  await api.waitIdle(pid);
  const take = (await shotOf(shotId)).takes.at(-1);
  expect(take.request.motionReference.mode).toBe('performance');
  expect(take.consistency.status).not.toBe('failed');
  await expect(row.locator(`[data-entity="take:${take.id}"]`)).toBeVisible();
});
