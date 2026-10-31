import { expect, test } from '@playwright/test';
import { Api } from './support/api';

/** AI review of the screenplay and the storyboard (docs/design/ai-review.md#surfaces), desktop and phone. */
test('the screenplay and the storyboard are reviewed, revised by their review and pass before the next stage', async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(360_000);
  const api = new Api(request);
  const pid = await api.storyProject(`AI review (${testInfo.project.name})`, {
    screenplay: true,
    settings: { review: { screenplay: true, storyboard: true }, storyboard: { enabled: true, scenes: 1 } },
  });
  await api.waitIdle(pid);

  // Written, then reviewed by itself
  await page.goto(`/p/${pid}/story`);
  const panel = page.getByTestId('ai-review-screenplay');
  await expect(panel).toHaveAttribute('data-state', 'passed');
  // New projects hold every score at 8 (docs/design/first-pass.md#the-gate-at-8)
  await expect(panel.getByTestId('ai-review-score')).toContainText('/ 10 · passes at 8, every dimension 8+');
  await expect(page.getByTestId('approve-screenplay')).toBeEnabled();

  // A crowd the video model cannot keep: the review is outdated and the gate waits
  const sp = (await api.call<any>('GET', `/projects/${pid}/state`)).docs.screenplay;
  const scene = [...sp.scenes].sort((a: any, b: any) => a.index - b.index)[0];
  await api.call('PATCH', `/projects/${pid}/screenplay`, {
    upsertScenes: [{ ...scene, action: `${scene.action} A crowd of tourists cheers on the pier.` }],
  });
  await expect(panel).toHaveAttribute('data-state', 'outdated');
  await expect(page.getByTestId('approve-screenplay')).toBeDisabled();

  // Reviewed again: the first round fails, the review rewrites the scene, the second passes
  await panel.getByTestId('run-ai-review').click();
  await expect(panel).toHaveAttribute('data-state', 'passed', { timeout: 120_000 });
  await expect(panel.getByTestId('ai-review-round')).toContainText('Round 2');
  await panel.getByTestId('ai-review-details').click();
  const applied = panel.locator('[data-testid="ai-review-recommendation"][data-status="applied"]');
  await expect(applied.first()).toContainText('applied by the review');
  await expect(page.getByTestId('approve-screenplay')).toBeEnabled();

  // The storyboard: drawn, reviewed, approved
  await api.readyForStoryboard(pid);
  await page.goto(`/p/${pid}/storyboard`);
  await page.getByTestId('generate-storyboard').click();
  await api.waitIdle(pid, 180_000);
  const board = page.getByTestId('ai-review-storyboard');
  await expect(board).toHaveAttribute('data-state', 'passed', { timeout: 60_000 });
  await expect(board.getByTestId('ai-review-score-composition')).toContainText('8.0');
  await page.getByTestId('approve-all-boards').click();
  await expect(page.getByTestId('approve-storyboard')).toBeEnabled();
});

/** The review gates in the project settings (docs/design/first-pass.md#the-gate-at-8), desktop and phone. */
test('the project settings show the review gates at 8 and save a new bar', async ({
  page,
  request,
}, testInfo) => {
  const api = new Api(request);
  const pid = await api.storyProject(`Review gates (${testInfo.project.name})`);
  await page.goto(`/p/${pid}/overview`);
  await page.getByTestId('open-settings').click();
  const gates = page.getByTestId('review-gates');
  await expect(gates.getByTestId('review-threshold')).toHaveValue('8');
  await expect(gates.getByTestId('review-scene-threshold')).toHaveValue('8');
  const floor = gates.getByTestId('review-min-dimension');
  await expect(floor).toHaveValue('8');
  await floor.fill('7.5');
  await page.getByTestId('settings-save').click();
  await expect
    .poll(async () => (await api.call<any>('GET', `/projects/${pid}/state`)).docs.project.settings.review)
    .toMatchObject({ threshold: 8, sceneThreshold: 8, minDimension: 7.5 });
});

/** The brief adapted for the video model (docs/design/first-pass.md#the-brief-adapted-for-the-video-model), desktop and phone. */
test('the Story view shows what of the brief the video model renders badly and how it is filmed', async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(240_000);
  const api = new Api(request);
  const pid = await api.storyProject(`Adapted brief (${testInfo.project.name})`, {
    screenplay: true,
    brief: 'Two friends learn to ride ponies; at the end they ride side by side over a pole.',
    settings: { brief: { adapt: true } },
  });
  await api.waitIdle(pid);
  await page.goto(`/p/${pid}/story`);
  const adapted = page.getByTestId('brief-adapted');
  await expect(adapted).toBeVisible();
  await expect(adapted.getByTestId('brief-moment')).toContainText('riding side by side');
  await expect(adapted.getByTestId('brief-moment')).toContainText('along the far fence');
  // The project settings turn it off
  await page.goto(`/p/${pid}/overview`);
  await page.getByTestId('open-settings').click();
  await expect(page.locator('input[name="briefAdapt"]')).toBeChecked();
});

/** The screenplay read for the video model (docs/design/first-pass.md#the-screenplay-read-for-the-video-model), desktop and phone. */
test('the Story view shows the screenplay with its hard moments made filmable before anyone reads it', async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(240_000);
  const api = new Api(request);
  const pid = await api.storyProject(`Checked screenplay (${testInfo.project.name})`, {
    screenplay: true,
    brief: 'Two friends learn to trot ponies, bouncing up and down; nobody else appears.',
  });
  await api.waitIdle(pid);
  await page.goto(`/p/${pid}/story`);
  await expect(page.getByText(/One slow bounce, then a laugh\./).first()).toBeVisible();
  await expect(page.getByTestId('scenes').getByPlaceholder('Action').first()).toHaveValue(
    /They bounce once, slowly, and laugh\.$/,
  );
});
