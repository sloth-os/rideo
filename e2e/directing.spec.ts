import { expect, test } from '@playwright/test';
import { Api } from './support/api';

test('a shot is directed (move, lens, end frame), varied and compared A/B', async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(180_000);
  const api = new Api(request);
  const pid = await api.storyProject(`Directing (${testInfo.project.name})`, {
    screenplay: true,
    settings: { storyboard: { enabled: false } },
  });
  await api.readyForStoryboard(pid);
  let state = await api.call<any>('GET', `/projects/${pid}/state`);
  const plan = await api.call<any>('POST', `/projects/${pid}/clips/plan`, {
    sceneId: state.docs.screenplay.scenes[0].id,
  });
  await api.waitJob(pid, plan.id);

  await page.goto(`/p/${pid}/clips`);
  const row = page.locator('[data-entity^="shot:"]').first();
  const shotId = (await row.getAttribute('data-entity'))!.slice('shot:'.length);
  await row.getByTestId('shot-direct').click();
  const panel = row.getByTestId('direct-panel');
  await expect(panel).toBeVisible();
  await panel.getByTestId('camera-move').selectOption('push_in');
  await panel.getByTestId('camera-lens').selectOption('85');
  await panel.getByTestId('camera-aperture').selectOption('2');
  await panel.getByTestId('end-frame-mode').selectOption('generate');
  await expect(panel.getByLabel('End frame description')).toBeVisible();
  await expect
    .poll(async () => {
      state = await api.call<any>('GET', `/projects/${pid}/state`);
      const clip = Object.values<any>(state.docs.clips)[0];
      return clip.shots.find((s: { id: string }) => s.id === shotId);
    })
    .toMatchObject({
      camera: { move: 'push_in', lensMm: 85, aperture: 2 },
      endFrame: { mode: 'generate' },
    });

  // Two variations, compared side by side; B is chosen
  await panel.getByTestId('variation-count').selectOption('2');
  await panel.getByTestId('generate-variations').click();
  await expect(row.getByTestId('take-variation')).toHaveCount(2, { timeout: 120_000 });
  await api.waitIdle(pid);
  const boxes = row.getByTestId('compare-take');
  await boxes.nth(0).check();
  await boxes.nth(1).check();
  await row.getByTestId('open-compare').click();
  const dialog = page.getByTestId('compare-dialog');
  await expect(dialog.getByTestId('compare-video-a')).toBeVisible();
  await expect(dialog.getByTestId('compare-video-b')).toBeVisible();
  await expect(dialog).toContainText('variation');
  await dialog.getByTestId('compare-play').click();
  await expect(dialog.getByTestId('compare-play')).toContainText('Pause both');
  await dialog.getByTestId('compare-use-b').click();
  await expect(dialog).toBeHidden();
  state = await api.call<any>('GET', `/projects/${pid}/state`);
  const shot = Object.values<any>(state.docs.clips)[0].shots.find((s: { id: string }) => s.id === shotId);
  const chosen = shot.takes.find((t: { id: string }) => t.id === shot.selectedTakeId);
  expect(chosen.request.prompt).toContain(
    'slow push-in toward the subject; 85mm lens, f/2 shallow depth of field.',
  );
  expect(chosen.request.lastFrameSource).toBe('generated');
});
