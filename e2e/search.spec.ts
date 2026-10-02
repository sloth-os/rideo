import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { Api } from './support/api';

const ffmpeg = process.env.RIDEO_FFMPEG_PATH ?? 'ffmpeg';

/** 8 s of footage: dark blue (night) for 4 s, then yellow (daylight). */
function nightThenDay(out: string): string {
  execFileSync(ffmpeg, [
    '-y',
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'color=c=0x000060:size=320x180:rate=24:duration=4',
    '-f',
    'lavfi',
    '-i',
    'color=c=yellow:size=320x180:rate=24:duration=4',
    '-filter_complex',
    '[0:v][1:v]concat=n=2:v=1,format=yuv420p[v]',
    '-map',
    '[v]',
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    out,
  ]);
  return out;
}

/** Semantic media search (docs/design/search.md): index, search, show, and a match onto the cut. */
test('footage and stills are indexed and found by what they show; a match goes onto the cut at the playhead', async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(180_000);
  const api = new Api(request);
  const pid = await api.editProjectWithClip(
    `Search (${testInfo.project.name})`,
    nightThenDay(testInfo.outputPath('night-day.mp4')),
  );
  const red = testInfo.outputPath('red.png');
  execFileSync(ffmpeg, [
    '-y',
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'color=c=red:size=320x180',
    '-frames:v',
    '1',
    red,
  ]);
  const still = await request.post(`/api/projects/${pid}/uploads`, {
    multipart: { file: { name: 'red.png', mimeType: 'image/png', buffer: readFileSync(red) } },
  });
  expect(still.ok()).toBe(true);
  const stillId: string = (await still.json()).id;

  await page.goto(`/p/${pid}/search`);
  await expect(page.getByTestId('view-search')).toBeVisible();
  await expect(page.getByTestId('search-status')).toContainText('0 frames indexed');
  await expect(page.getByTestId('search-status')).toContainText('3 waiting');
  await expect(page.getByTestId('search-mode')).toContainText('by words');
  await page.getByTestId('search-index').click();
  await expect(page.getByTestId('search-status')).toContainText('3 frames indexed in 2 files', {
    timeout: 60_000,
  });

  // The daylight half of the footage, by words
  await page.getByTestId('search-input').fill('yellow daylight');
  await page.getByTestId('search-submit').click();
  const first = page.getByTestId('search-result').first();
  await expect(first.getByTestId('result-caption')).toContainText('yellow scene in bright daylight');
  await expect(first.getByTestId('result-video')).toHaveAttribute('src', /#t=6$/);
  await expect(page.getByTestId('search-summary')).toContainText('matched by words');

  // Only stills and footage, then where the still is
  await page.getByTestId('search-input').fill('red');
  await page.getByTestId('search-submit').click();
  await page.getByTestId('search-kind-resource').click();
  await expect(page.getByTestId('search-kind-resource')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('search-result')).toHaveCount(1);
  await expect(page.getByTestId('result-caption')).toContainText('red scene');
  await page.getByTestId('result-show').click();
  await expect(page).toHaveURL(new RegExp(`/p/${pid}/resources$`));
  await expect(page.locator(`[data-entity="resource:${stillId}"]`)).toBeInViewport();

  // In the editor: the overlay picker finds it and puts it at the playhead
  await page.goto(`/p/${pid}/editor`);
  await page.getByTestId('overlay-open').click();
  await page.getByTestId('overlay-search').fill('red');
  await page.getByTestId('overlay-search').press('Enter');
  await expect(page.getByTestId('overlay-option').first()).toContainText('red scene');
  await page.getByTestId('overlay-option').first().click();
  await expect
    .poll(async () => {
      const t = await api.call<any>('GET', `/projects/${pid}/timeline`);
      return t.tracks
        .filter((x: any) => x.kind === 'video')
        .slice(1)
        .flatMap((x: any) => x.items.map((i: any) => [i.source.resourceId, i.in, i.out]));
    })
    .toEqual([[stillId, 0, 3]]);
});
