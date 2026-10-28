import { expect, test } from '@playwright/test';
import { Api } from './support/api';

/** A scene's takes watched before the edit (docs/design/ai-review.md#scenes-before-the-edit), desktop and phone. */
test('a scene is watched after its takes, the shot that breaks it is generated again, and it is watched again', async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(360_000);
  const api = new Api(request);
  const pid = await api.storyProject(`Scene review (${testInfo.project.name})`, {
    screenplay: true,
    settings: {
      review: { screenplay: false, storyboard: false, scenes: true, sceneFixes: 2 },
      storyboard: { enabled: false },
      pilotDurationSec: 15,
    },
  });
  await api.readyForStoryboard(pid);
  const state = await api.call<any>('GET', `/projects/${pid}/state`);
  const plan = await api.call<any>('POST', `/projects/${pid}/clips/plan`, {
    sceneId: state.docs.screenplay.scenes[0].id,
  });
  await api.waitJob(pid, plan.id);
  const clip = Object.values<any>((await api.call<any>('GET', `/projects/${pid}/state`)).docs.clips)[0];
  const shot = [...clip.shots].sort((a: any, b: any) => a.index - b.index)[1];
  // A shot the mock reviewer sees break the scene (docs/design/ai-review.md#mock-gateway)
  await api.call('PATCH', `/projects/${pid}/clips/${clip.id}/shots/${shot.id}`, {
    description: `${shot.description} Continuity break.`,
  });

  // Generated from the clip card: the scene is watched, the shot made again, the scene watched again
  await page.goto(`/p/${pid}/clips`);
  await page.getByTestId('generate-clip').first().click();
  const panel = page.getByTestId('clip-review');
  await expect(panel).toHaveAttribute('data-state', 'current', { timeout: 240_000 });
  await expect(panel.getByTestId('clip-review-score')).toContainText('/10');
  await expect(panel.getByTestId('clip-review-before')).toContainText('before 1 fix');
  await panel.locator('summary').getByText('Scene review', { exact: true }).click();
  const fix = panel.getByTestId('clip-review-fix');
  await expect(fix).toHaveAttribute('data-outcome', 'fixed');
  await expect(fix).toContainText('Fixed: the new take passed its checks and is selected.');
  await expect(fix).toContainText(`C1·S${shot.index + 1}`);
  await expect(panel.getByRole('list', { name: 'Scores' })).toContainText('Continuity');

  // Watched again from the panel: nothing breaks the scene now, so one round and no fix
  await panel.getByTestId('clip-review-run').click();
  await expect(panel.getByTestId('clip-review-before')).toBeHidden({ timeout: 120_000 });
  await expect(panel).toHaveAttribute('data-state', 'current');
  await expect(panel.getByTestId('clip-review-fix')).toHaveCount(0);

  // Nothing scrolls sideways at this width
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});
