import { expect, test } from '@playwright/test';
import { Api } from './support/api';

test('every edit is a commit; restoring an older commit updates the open page', async ({ page, request }) => {
  const api = new Api(request);
  const pid = await api.storyProject('History e2e', { screenplay: true });
  page.on('dialog', (d) => d.accept());

  await page.goto(`/p/${pid}/cast`);
  const names = page.getByTestId('character-name');
  await expect(names.first()).toBeVisible();
  const before = await names.count();
  await page.getByTestId('add-character').click();
  await page.getByTestId('new-character-name').fill('Rhea');
  await page.getByTestId('add-character-submit').click();
  await expect(names).toHaveCount(before + 1);

  await page.getByTestId('nav-history').click();
  const commits = page.getByTestId('commit');
  await expect(commits.first()).toContainText('Add character Rhea');
  await commits.first().click();
  await expect(page.getByTestId('diff')).toContainText('characters/');

  await commits.nth(1).click();
  await page.getByTestId('restore-commit').click();
  await expect(commits.first()).toContainText('Restore project from');

  await page.getByTestId('nav-cast').click();
  await expect(names).toHaveCount(before);
  await expect(names.filter({ hasText: 'Rhea' })).toHaveCount(0);
});
