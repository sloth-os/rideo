import { readFileSync, writeFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { Api, makeFootage } from './support/api';

test('the cut is handed to an NLE with its media on WebDAV and a re-edit comes back from OTIO', async ({
  page,
  request,
}, testInfo) => {
  const api = new Api(request);
  const pid = await api.editProjectWithClip(
    `Hand-off (${testInfo.project.name})`,
    makeFootage(testInfo.outputPath('clip.mp4')),
  );

  await page.goto(`/p/${pid}/exports`);
  const card = page.getByTestId('interchange-card');
  await expect(card).toBeVisible();
  // The share mounted in Finder: the clips point into it
  await card.getByTestId('interchange-media-base').fill('/Volumes/dav/rideo');
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    card.getByTestId('interchange-otio').click(),
  ]);
  expect(download.suggestedFilename()).toBe(`hand-off-${testInfo.project.name}.otio`);
  const file = testInfo.outputPath('cut.otio');
  await download.saveAs(file);
  const otio = JSON.parse(readFileSync(file, 'utf8'));
  const clip = otio.tracks.children[0].children[0];
  expect(clip.media_reference.target_url).toMatch(
    new RegExp(`^file:///Volumes/dav/rideo/projects/${pid}/media/.+\\.mp4$`),
  );
  // The other formats download too, with the remembered location
  await page.reload();
  await expect(card.getByTestId('interchange-media-base')).toHaveValue('/Volumes/dav/rideo');
  for (const format of ['fcpxml', 'xml', 'edl'] as const) {
    const [d] = await Promise.all([
      page.waitForEvent('download'),
      card.getByTestId(`interchange-${format}`).click(),
    ]);
    expect(d.suggestedFilename()).toMatch(new RegExp(`\\.${format}$`));
  }

  // Re-edited in the NLE: trimmed to 2 s, and a clip the project does not have
  clip.source_range.duration.value = 2 * clip.source_range.duration.rate;
  const stranger = structuredClone(clip);
  stranger.name = 'Drone shot';
  stranger.metadata = {};
  stranger.media_reference.target_url = 'file:///Volumes/Media/drone.mov';
  otio.tracks.children[0].children.push(stranger);
  const edited = testInfo.outputPath('re-edit.otio');
  writeFileSync(edited, JSON.stringify(otio));
  await card.getByTestId('interchange-import-file').setInputFiles(edited);
  const result = card.getByTestId('interchange-import-result');
  await expect(result).toContainText('1 clip placed');
  await expect(result).toContainText('Not media of this project: Drone shot');
  await expect
    .poll(async () => {
      const t = await api.call<any>('GET', `/projects/${pid}/timeline`);
      const items = t.tracks.find((x: any) => x.kind === 'video').items;
      return items.map((i: any) => i.out - i.in);
    })
    .toEqual([2]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
});
