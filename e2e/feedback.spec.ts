import { expect, test } from '@playwright/test';
import { Api } from './support/api';
import { exportInThisTab } from './support/ui';

/** Feedback on the finished film (docs/design/feedback.md#surfaces) and the continuity settings, desktop and phone. */
test('a story export is watched by itself: scores, issues, recommendations applied and dismissed, improvements, the report', async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(360_000);
  const api = new Api(request);
  const pid = await api.storyProject(`Feedback (${testInfo.project.name})`, {
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
  await api.call('POST', `/projects/${pid}/timeline/assemble`, {});

  // The continuity settings: a language level, version 2 prompts, quality checks and feedback after each export.
  await page.goto(`/p/${pid}/overview`);
  await page.getByTestId('open-settings').click();
  const continuity = page.getByTestId('continuity-settings');
  await expect(continuity.locator('input[name="promptVersion"]')).toBeChecked();
  await expect(continuity.locator('input[name="qualityChecks"]')).toBeChecked();
  await expect(continuity.locator('input[name="feedbackAuto"]')).toBeChecked();
  // A film with only its cast (docs/design/continuity.md#quality-checks-in-the-gate): off until asked for
  const castOnly = continuity.locator('input[name="castOnly"]');
  await expect(castOnly).not.toBeChecked();
  await castOnly.check();
  await page.getByTestId('dialogue-level').selectOption('B1');
  await page.getByTestId('settings-save').click();
  await expect
    .poll(async () => {
      const settings = (await api.call<any>('GET', `/projects/${pid}/state`)).docs.project.settings;
      return [settings.dialogue.level, settings.consistency.castOnly];
    })
    .toEqual(['B1', true]);

  await page.goto(`/p/${pid}/editor`);
  await expect(page.getByTestId('live-status')).toHaveAttribute('data-status', 'live');
  await exportInThisTab(page, { quality: 'draft', engine: 'ffmpeg' });
  await page.goto(`/p/${pid}/exports`);
  const card = page.locator('[data-entity^="export:"]').first();
  const feedback = card.getByTestId('export-feedback');
  await expect(feedback.getByTestId('feedback-overall')).toHaveText(/\/10$/, { timeout: 120_000 });
  await expect(feedback.getByTestId('feedback-score-storytelling')).toContainText('7.0');
  // Without an audio-visual model the film is watched, not heard
  await expect(feedback.getByTestId('feedback-heard')).toHaveText(/^Watched by /);
  await feedback.getByTestId('show-feedback').click();
  const dialog = page.getByTestId('feedback-dialog');
  await expect(dialog.getByTestId('feedback-video')).toBeVisible();

  // Apply the shot regeneration; dismiss the note.
  const regenerate = dialog
    .locator('[data-testid="feedback-recommendation"][data-kind="regenerate_shot"]')
    .first();
  await regenerate.getByTestId('apply-recommendation').click();
  await expect(regenerate).toHaveAttribute('data-status', 'applied');
  const note = dialog.locator('[data-testid="feedback-recommendation"][data-kind="note"]').first();
  await note.getByTestId('dismiss-recommendation').click();
  await expect(note).toHaveAttribute('data-status', 'dismissed');

  // Issues play the export from their time.
  await dialog.getByTestId('feedback-tab-issues').click();
  const issues = dialog.getByTestId('feedback-issue');
  if ((await issues.count()) > 0) {
    await issues.first().getByTestId('play-from-here').click();
    await expect
      .poll(() => dialog.getByTestId('feedback-video').evaluate((v: HTMLVideoElement) => v.currentTime))
      .toBeGreaterThanOrEqual(0);
  }
  await dialog.getByTestId('feedback-tab-retrospective').click();
  await expect(dialog.getByTestId('feedback-retrospective')).toContainText('Fewer discarded generations');
  await expect(page.getByTestId('download-feedback-report')).toHaveAttribute(
    'href',
    /media\/reports\/.+\.md/,
  );
  // Phones: the dialog is a sheet and nothing scrolls sideways.
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
});
