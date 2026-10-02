import { execFileSync } from 'node:child_process';
import { expect, test } from '@playwright/test';
import { Api, makeFootage } from './support/api';
import { exportInThisTab } from './support/ui';

/** Brand kits (docs/design/brand-kits.md): a kit with a logo and the bug, applied to a project, a lower third, the export. */
test('a brand kit is made, applied to a project, and its lower third and bug reach the export', async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(240_000);
  const api = new Api(request);
  const pid = await api.editProjectWithClip(
    `Branded (${testInfo.project.name})`,
    makeFootage(testInfo.outputPath('clip.mp4')),
  );
  const logo = testInfo.outputPath('logo.png');
  execFileSync(process.env.RIDEO_FFMPEG_PATH ?? 'ffmpeg', [
    '-y',
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'color=c=red:size=200x100',
    '-frames:v',
    '1',
    logo,
  ]);
  const kitName = `Northwind (${testInfo.project.name})`;

  // The kit
  await page.goto(`/p/${pid}/overview`);
  await page.getByTestId('brand-kits-link').click();
  await expect(page).toHaveURL(/\/brand$/);
  await page.getByTestId('kit-name').fill(kitName);
  await page.getByTestId('kit-create').click();
  const editor = page.getByTestId('kit-editor');
  await expect(editor).toContainText(kitName);
  await editor.getByTestId('kit-file-logo').setInputFiles(logo);
  await expect(editor.getByTestId('kit-slot-logo-name')).toHaveText('logo.png');
  await editor.getByTestId('kit-bug-enabled').check();
  await expect
    .poll(
      async () => (await api.call<any[]>('GET', '/brand-kits')).find((k) => k.name === kitName)?.bug.enabled,
    )
    .toBe(true);

  // Applied to the project
  await page.goto(`/p/${pid}/overview`);
  const card = page.getByTestId('brand-card');
  await card.getByTestId('brand-select').selectOption({ label: kitName });
  await card.getByTestId('brand-apply').click();
  await expect(card.getByTestId('brand-name')).toHaveText(kitName);

  // A lower third from the kit's template, at the playhead
  await page.goto(`/p/${pid}/editor`);
  await page.getByTestId('lower-third-open').click();
  await page.getByTestId('lower-third-name').fill('Mira Okafor');
  await page.getByTestId('lower-third-role').fill('Lighthouse keeper');
  await page.getByTestId('lower-third-add').click();
  await expect
    .poll(async () => {
      const t = await api.call<any>('GET', `/projects/${pid}/timeline`);
      return t.tracks
        .filter((x: any) => x.kind === 'text')
        .flatMap((x: any) => x.items.map((i: any) => [i.text, i.style.preset]));
    })
    .toEqual([['Mira Okafor\nLighthouse keeper', 'lower_third']]);

  // The export: the bug is on by default for this kit
  await page.getByTestId('open-export').click();
  await expect(page.getByTestId('export-bug')).toBeChecked();
  await page.getByTestId('export-close').click();
  await exportInThisTab(page, { quality: 'draft', engine: 'ffmpeg' });
  const exports = await api.call<any[]>('GET', `/projects/${pid}/exports`);
  expect(exports.some((e) => e.status === 'succeeded')).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
});
