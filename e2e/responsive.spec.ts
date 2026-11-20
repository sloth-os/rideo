import { expect, type Page, test } from '@playwright/test';
import { Api } from './support/api';

const VIEWS = [
  'overview',
  'story',
  'cast',
  'elements',
  'resources',
  'storyboard',
  'clips',
  'editor',
  'search',
  'history',
  'exports',
] as const;

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

/**
 * What a phone's header shows, left to right (docs/brand.md#layout-and-responsiveness): every visible box, the project
 * title's row cut to whatever clips it, as the eye sees it.
 */
async function headerBoxes(page: Page) {
  return page.evaluate(() => {
    const header = document.querySelector('header');
    if (!header) return [];
    const title = header.querySelector('[data-testid="project-title"]');
    const row = title?.parentElement ?? null;
    /** The part of an element left once every ancestor below the header that clips it has cut it. */
    const seen = (e: Element) => {
      let { left, right } = e.getBoundingClientRect();
      for (let a = e.parentElement; a && a !== header; a = a.parentElement)
        if (getComputedStyle(a).overflowX !== 'visible') {
          const r = a.getBoundingClientRect();
          left = Math.max(left, r.left);
          right = Math.min(right, r.right);
        }
      return { left, right };
    };
    const boxes: { name: string; left: number; right: number }[] = [];
    const add = (e: Element, name: string) => {
      const style = getComputedStyle(e);
      if (style.display === 'none' || style.visibility === 'hidden') return;
      const { left, right } = seen(e);
      if (right - left > 0.5) boxes.push({ name, left, right });
    };
    for (const child of header.children) {
      if (row && child.contains(row))
        for (const e of row.children) add(e, e.getAttribute('data-testid') ?? e.textContent ?? 'badge');
      else add(child, child.getAttribute('data-testid') ?? child.getAttribute('aria-label') ?? child.tagName);
    }
    return boxes.sort((a, b) => a.left - b.left);
  });
}

test('on phones the project header keeps its title and its controls apart, and the Library is under More', async ({
  browser,
  request,
}, testInfo) => {
  const api = new Api(request);
  // longer than any phone's header has room for
  const pid = await api.storyProject('Harbour lights at the far end of the long pier', { screenplay: true });
  for (const [width, height] of [
    [360, 740],
    [390, 844],
    [412, 915],
  ] as const) {
    const phone = await browser.newContext({
      viewport: { width, height },
      deviceScaleFactor: 1,
      isMobile: true,
      hasTouch: true,
    });
    const page = await phone.newPage();
    await page.goto(`/p/${pid}/cast`);
    await expect(page.getByTestId('project-title')).toBeVisible();
    await expect(page.getByTestId('engine-status')).toBeVisible();
    const boxes = await headerBoxes(page);
    const where = `${width} px: ${boxes.map((b) => `${b.name} ${Math.round(b.left)}–${Math.round(b.right)}`).join(', ')}`;
    // the title shows (a few letters at least), the stage waits for a wider screen
    const heading = boxes.find((b) => b.name === 'project-title');
    expect(heading ? heading.right - heading.left : 0, where).toBeGreaterThanOrEqual(48);
    await expect(page.getByTestId('project-stage')).toBeHidden();
    // nothing overlaps, and nothing leaves the screen
    for (const [i, b] of boxes.entries())
      if (i > 0)
        expect(b.left, `${where}: ${boxes[i - 1]!.name} and ${b.name} overlap`).toBeGreaterThanOrEqual(
          boxes[i - 1]!.right - 0.5,
        );
    expect(boxes.at(-1)!.right, where).toBeLessThanOrEqual(width + 0.5);
    await expectNoHorizontalOverflow(page);
    const shot = testInfo.outputPath(`header-${width}x${height}.png`);
    await page.screenshot({ path: shot, clip: { x: 0, y: 0, width, height: 64 } });
    await testInfo.attach(`header-${width}x${height}`, { path: shot, contentType: 'image/png' });
    // the Library, one tap away under More
    await page.getByTestId('mnav-more').tap();
    await page.getByTestId('mnav-library').tap();
    await expect(page).toHaveURL(/\/library$/);
    await phone.close();
  }
});
