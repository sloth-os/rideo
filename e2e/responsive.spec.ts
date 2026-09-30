import { expect, type Page, test } from '@playwright/test';
import { Api } from './support/api';

const VIEWS = ['overview', 'story', 'cast', 'resources', 'clips', 'editor', 'history', 'exports'] as const;

async function expectNoHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() => {
    const doc = document.documentElement;
    const main = document.querySelector('main');
    return { page: doc.scrollWidth - doc.clientWidth, main: main ? main.scrollWidth - main.clientWidth : 0 };
  });
  expect(overflow.page, 'page scrolls horizontally').toBeLessThanOrEqual(1);
  expect(overflow.main, 'main view scrolls horizontally').toBeLessThanOrEqual(1);
}

test('every main view fits a phone, with navigation and primary actions reachable', async ({
  page,
  request,
}) => {
  const api = new Api(request);
  const pid = await api.storyProject('Responsive e2e', { screenplay: true });

  await page.goto('/');
  await expect(page.getByTestId('new-story')).toBeVisible();
  await expect(page.getByTestId('new-edit')).toBeVisible();
  await expectNoHorizontalOverflow(page);

  for (const view of VIEWS) {
    await page.goto(`/p/${pid}/${view}`);
    await expect(page.getByTestId(`view-${view}`)).toBeVisible();
    await expect(page.getByTestId('mnav-overview')).toBeVisible();
    await expect(page.getByTestId(`nav-${view}`)).toBeHidden();
    await expectNoHorizontalOverflow(page);
  }

  await page.goto(`/p/${pid}/overview`);
  await expect(page.getByTestId('approve-gate')).toBeVisible();
  await page.getByTestId('mnav-story').tap();
  await expect(page).toHaveURL(/\/story$/);
  await expect(page.getByTestId('approve-screenplay')).toBeVisible();
  await page.getByTestId('mnav-more').tap();
  await page.getByTestId('mnav-history').tap();
  await expect(page).toHaveURL(/\/history$/);
  await expect(page.getByTestId('commit').first()).toBeVisible();
});
