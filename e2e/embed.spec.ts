import { expect, test } from '@playwright/test';
import { makeFootage } from './support/api';
import { at, PORTS } from './support/ports';

/**
 * The studio as a library (docs/design/embedding.md): a host app on its own origin mounts it from the package, with
 * its theme and routes, talking to the browser-storage studio on another origin (RIDEO_CORS_ORIGINS).
 */
test.use({ baseURL: at(PORTS.host) });
const server = encodeURIComponent(at(PORTS.browser, '/'));

test('another app embeds the studio: its theme and name, hash routes, a server on another origin, styles kept apart', async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`/?server=${server}`);
  const root = page.getByTestId('rideo-root');
  await expect(page.getByTestId('host-header')).toBeVisible();
  await expect(root).toBeVisible();
  // the host's theme over the studio's: light mode, a violet accent and readable text on it
  await expect(root).toHaveAttribute('data-theme', 'light');
  const vars = await root.evaluate((el) => {
    const cs = getComputedStyle(el);
    return {
      accent: cs.getPropertyValue('--color-accent').trim(),
      on: cs.getPropertyValue('--color-accent-contrast').trim(),
    };
  });
  expect(vars.accent).toBe('#7c3aed');
  expect(vars.on).toMatch(/^#fff(fff)?$/);
  if (testInfo.project.name !== 'mobile')
    await expect(page.getByTestId('studio-name')).toHaveText('Host Video');
  // the studio talks to its server on another origin: config, projects, the live channel
  await expect(page.getByTestId('live-status')).toHaveAttribute('data-status', 'live');
  await expect(page.getByTestId('browser-storage')).toBeVisible();

  // styles stay apart: the host's links stay blue, its body font stays; the studio keeps its own
  expect(await page.getByTestId('host-link').evaluate((el) => getComputedStyle(el).color)).toBe(
    'rgb(0, 0, 255)',
  );
  expect(await page.evaluate(() => getComputedStyle(document.body).fontFamily)).toContain('Georgia');
  expect(await root.evaluate((el) => getComputedStyle(el).fontFamily)).toContain('Inter');
  const primary = page.getByTestId('new-edit');
  expect(await primary.evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe('rgb(255, 0, 0)');

  // routes live in the hash; the host hears every change and can navigate
  await page.getByTestId('new-edit').click();
  await page.getByLabel('Title').fill('Embedded edit');
  await page.getByTestId('create-project-submit').click();
  await expect(page).toHaveURL(/#\/p\/prj_[0-9a-z]+\/resources$/);
  // the editor engine runs inside the host: ffmpeg.wasm (loaded from the host's build) probes the upload
  await page.getByTestId('resource-upload').setInputFiles(makeFootage(testInfo.outputPath('footage.mp4')));
  await expect(page.getByTestId('approve-resources')).toBeEnabled({ timeout: 90_000 });
  await expect(page.locator('body')).toHaveAttribute('data-studio-path', /^\/p\/prj_[0-9a-z]+\/resources$/);
  await page.evaluate(() =>
    (window as unknown as { studio: { navigate(p: string): void } }).studio.navigate('/'),
  );
  await expect(page.getByTestId('project-card').filter({ hasText: 'Embedded edit' })).toHaveCount(1);
  // the project is kept in this (the host's) browser
  const kept = await page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        const open = indexedDB.open('rideo-workspace');
        open.onsuccess = () => {
          const r = open.result.transaction('entries').objectStore('entries').getAllKeys();
          r.onsuccess = () =>
            resolve((r.result as string[]).filter((k) => /^\/projects\/prj_[^/]+$/.test(k)).length);
        };
        open.onerror = () => resolve(0);
      }),
  );
  expect(kept).toBe(1);

  // the host switches the theme
  await page.evaluate(() =>
    (window as unknown as { studio: { setTheme(t: unknown): void } }).studio.setTheme({
      mode: 'dark',
      colors: { accent: '#0ea5e9' },
    }),
  );
  await expect(root).toHaveAttribute('data-theme', 'dark');
  expect(await root.evaluate((el) => getComputedStyle(el).getPropertyValue('--color-accent').trim())).toBe(
    '#0ea5e9',
  );
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  expect(errors).toEqual([]);
});

test('the studio under the host’s own routes, without its header', async ({ page }) => {
  await page.goto(`/video/?server=${server}&routing=browser&header=off`);
  await expect(page.getByTestId('rideo-root')).toBeVisible();
  await expect(page.getByTestId('new-edit')).toBeVisible();
  await expect(page.getByTestId('live-status')).toHaveCount(0);
  await page.getByTestId('new-edit').click();
  await page.getByLabel('Title').fill('Under the host');
  await page.getByTestId('create-project-submit').click();
  await expect(page).toHaveURL(/\/video\/p\/prj_[0-9a-z]+\/resources$/);
  await page.reload();
  await expect(page.getByTestId('view-resources')).toBeVisible();
});
