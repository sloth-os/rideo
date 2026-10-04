import { readFileSync } from 'node:fs';
import { expect, type Page, test } from '@playwright/test';
import { BUNDLE_MANIFEST, parseTarHeader, TAR_BLOCK } from '@rideo/shared';
import { makeFootage, projectIdFrom } from './support/api';
import { at, PORTS } from './support/ports';
import { exportInThisTab } from './support/ui';

/**
 * Projects kept in the browser (docs/design/browser-storage.md) on a studio without mm-gateway: the editor alone
 * (docs/design/settings.md#without-mm-gateway), project files out and back in.
 */
test.use({ baseURL: at(PORTS.browser) });

/** Whether the browser's workspace holds a path. */
function idbHas(page: Page, path: string): Promise<boolean> {
  return page.evaluate(
    (p) =>
      new Promise<boolean>((resolve) => {
        const open = indexedDB.open('rideo-workspace');
        open.onsuccess = () => {
          const get = open.result.transaction('entries').objectStore('entries').get(p);
          get.onsuccess = () => resolve(!!get.result);
          get.onerror = () => resolve(false);
        };
        open.onerror = () => resolve(false);
      }),
    path,
  );
}

async function newEditProject(page: Page, title: string): Promise<string> {
  await page.goto('/');
  await expect(page.getByTestId('browser-storage')).toContainText('stored in this browser');
  await expect(page.getByTestId('ai-off')).toBeVisible();
  await expect(page.getByTestId('new-story')).toBeDisabled();
  await page.getByTestId('new-edit').click();
  await page.getByLabel('Title').fill(title);
  await page.getByTestId('create-project-submit').click();
  await expect(page).toHaveURL(/\/resources$/);
  const pid = projectIdFrom(page.url());
  expect(await idbHas(page, `/projects/${pid}/.rideo/HEAD`)).toBe(true);
  return pid;
}

test('a project this browser keeps: its media here, a project file out, back in, and a copy', async ({
  page,
}, testInfo) => {
  const footage = makeFootage(testInfo.outputPath('footage.mp4'));
  const pid = await newEditProject(page, 'Kept in this browser');
  // the browser probes and posters the upload; the server stores it back in this browser
  await page.getByTestId('resource-upload').setInputFiles(footage);
  await expect(page.getByTestId('approve-resources')).toBeEnabled({ timeout: 60_000 });
  const media = await page.evaluate(
    (p) =>
      new Promise<string[]>((resolve) => {
        const open = indexedDB.open('rideo-workspace');
        open.onsuccess = () => {
          const all = open.result
            .transaction('entries')
            .objectStore('entries')
            .getAllKeys(IDBKeyRange.bound(`${p}/media/`, `${p}/media/￿`));
          all.onsuccess = () => resolve((all.result as string[]).filter((k) => /\.(mp4|jpg)$/.test(k)));
        };
      }),
    `/projects/${pid}`,
  );
  expect(media.some((k) => k.includes('/media/uploads/'))).toBe(true);
  expect(media.some((k) => k.includes('/media/posters/'))).toBe(true);

  // a project file of it
  await page.getByTestId(testInfo.project.name === 'mobile' ? 'mnav-overview' : 'nav-overview').click();
  await expect(page.getByTestId('browser-project-card')).toBeVisible();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId('overview-export').click(),
  ]);
  expect(download.suggestedFilename()).toBe('Kept in this browser.rideo');
  const file = testInfo.outputPath('project.rideo');
  await download.saveAs(file);
  const tar = readFileSync(file);
  const first = parseTarHeader(tar.subarray(0, TAR_BLOCK));
  expect(first?.name).toBe(BUNDLE_MANIFEST);
  const manifest = JSON.parse(tar.subarray(TAR_BLOCK, TAR_BLOCK + first!.size).toString());
  expect(manifest).toMatchObject({ projectId: pid, title: 'Kept in this browser', kind: 'edit' });
  expect(manifest.bytes).toBeGreaterThan(100_000);

  // gone from this browser, back from the file
  await page.goto('/');
  const card = page.getByTestId('project-card').filter({ hasText: 'Kept in this browser' });
  await expect(card).toHaveCount(1);
  page.once('dialog', (d) => void d.accept());
  await card.getByRole('button', { name: /Delete/ }).click();
  await expect(card).toHaveCount(0);
  expect(await idbHas(page, `/projects/${pid}/.rideo/HEAD`)).toBe(false);
  await page.getByTestId('import-project-input').setInputFiles(file);
  await expect(page).toHaveURL(new RegExp(`/p/${pid}`), { timeout: 60_000 });
  expect(await idbHas(page, media.find((k) => k.includes('/media/uploads/'))!)).toBe(true);
  await expect(page.getByTestId('project-title')).toHaveText('Kept in this browser');

  // importing it again asks; keeping both makes a copy with its own id and history
  await page.goto('/');
  await page.getByTestId('import-project-input').setInputFiles(file);
  await page.getByTestId('import-copy').click();
  await expect(page).toHaveURL(/\/p\/prj_[0-9a-z]+/, { timeout: 60_000 });
  expect(projectIdFrom(page.url())).not.toBe(pid);
  await expect(page.getByTestId('project-title')).toHaveText('Kept in this browser (copy)');

  // still here after a reload: the browser keeps them
  await page.goto('/');
  await page.reload();
  await expect(page.getByTestId('project-card')).toHaveCount(2);
  await expect(page.getByTestId('live-status')).toHaveAttribute('data-status', 'live');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
});

test('the editor without mm-gateway: analysis by rules, auto edit and an export, all kept in this browser', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', 'the timeline editor is a desktop view');
  const footage = makeFootage(testInfo.outputPath('footage.mp4'));
  const pid = await newEditProject(page, 'Edited without AI');
  await page.getByTestId('resource-upload').setInputFiles(footage);
  const analyze = page.getByTestId('approve-resources');
  await expect(analyze).toBeEnabled({ timeout: 60_000 });
  await analyze.click();
  // signals in this tab, suggestions by rules
  await expect(page).toHaveURL(/\/analysis$/);
  await expect(page.getByTestId('analysis-summary')).toContainText('completed', { timeout: 120_000 });
  await expect(page.getByTestId('accept-suggestion').first()).toBeVisible();
  await page.getByTestId('accept-all').click();
  await page.getByTestId('auto-edit').click();
  await expect(page).toHaveURL(/\/editor$/);
  await expect(page.locator('[data-track="video"] [data-testid="timeline-item"]').first()).toBeVisible();
  await expect(page.getByTestId('preview-canvas')).toBeVisible();
  await exportInThisTab(page, { engine: 'ffmpeg', quality: 'draft' });
  await page.getByTestId('nav-exports').click();
  const card = page.locator('[data-entity^="export:"]').first();
  await expect(card.getByTestId('download-export')).toBeVisible({ timeout: 120_000 });
  // the watermarked export is in this browser, and the service worker serves it from there
  const href = await card.getByTestId('download-export').getAttribute('href');
  const url = new URL(href!, page.url());
  const mediaPath = decodeURIComponent(url.pathname.split('/media/').slice(1).join('/media/'));
  expect(await idbHas(page, `/projects/${pid}/${mediaPath}`)).toBe(true);
  const served = await page.evaluate(async (u) => {
    const res = await fetch(u, { headers: { range: 'bytes=0-15' } });
    return {
      status: res.status,
      source: res.headers.get('x-rideo-source'),
      size: (await res.arrayBuffer()).byteLength,
    };
  }, url.href);
  expect(served).toEqual({ status: 206, source: 'browser', size: 16 });
});
