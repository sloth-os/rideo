import { expect, test } from '@playwright/test';
import { Api } from './support/api';
import { exportInThisTab } from './support/ui';

/** Post audio (docs/design/post-audio.md) in the editor and the exports, desktop and phone. */
test('the cut is ducked, scored and given effects; the export is normalized with stems', async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(360_000);
  const api = new Api(request);
  const pid = await api.storyProject(`Post audio (${testInfo.project.name})`, {
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
  const timeline = () => api.call<any>('GET', `/projects/${pid}/timeline`);

  await page.goto(`/p/${pid}/editor`);
  const mix = page.getByTestId('mix-panel');
  await expect(mix).toBeVisible();
  // the assembled cut ducks the music under speech; the depth is a mix setting
  await expect(mix.getByTestId('mix-ducking')).toBeChecked();
  await mix.getByTestId('mix-depth').selectOption('-18');
  await expect.poll(async () => (await timeline()).mix.ducking.depthDb).toBe(-18);
  await expect(mix.getByTestId('mix-stems')).toContainText('Dialogue');

  // a cue per scene on the Music track
  await mix.getByTestId('score-direction').fill('sparse piano');
  await mix.getByTestId('score-cut').click();
  await expect
    .poll(async () => (await timeline()).tracks.find((t: any) => t.name === 'Music').items[0]?.label, {
      timeout: 120_000,
    })
    .toBe('Cue 1');
  // effects from the action lines on a new Effects track
  await mix.getByTestId('generate-sfx').click();
  await expect(mix.getByTestId('mix-stems').locator('li', { hasText: 'Effects' })).toContainText('effects', {
    timeout: 120_000,
  });
  await api.waitIdle(pid);
  if ((page.viewportSize()?.width ?? 1280) >= 768)
    await expect(
      page.locator('[data-track-role="effects"] [data-testid="timeline-item"]').first(),
    ).toBeVisible();

  // the tab renders the soundtrack and stems; the server normalizes to EBU R128
  await exportInThisTab(page, { quality: 'draft', engine: 'ffmpeg', loudness: 'broadcast', stems: true });
  await page.goto(`/p/${pid}/exports`);
  const card = page.locator('[data-entity^="export:"]').first();
  await expect(card.getByTestId('export-loudness-badge')).toHaveText(/^-2[2-4]\.\d LUFS$/);
  for (const role of ['dialogue', 'music', 'effects'])
    await expect(card.getByTestId(`download-stem-${role}`)).toBeVisible();
  const exp = (await api.call<any[]>('GET', `/projects/${pid}/exports`))[0];
  expect(exp.loudness).toMatchObject({ target: 'broadcast' });
  expect(Math.abs(exp.loudness.integratedLufs + 23)).toBeLessThan(1);
});
