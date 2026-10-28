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
  await expect(panel.getByTestId('ai-review-score')).toContainText('/ 10 · passes at 7');
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
