import { expect, test } from '@playwright/test';
import { Api } from './support/api';

const FOUNTAIN = `Title: The Night Ferry

INT. FERRY CABIN - NIGHT

Rain on the porthole. Ada counts coins.

ADA
(to herself)
One more crossing.

EXT. HARBOUR - DAY

ELI
You came back.
`;

test('the storyboard is drawn, reordered and approved; the animatic plays and exports; screenplays import', async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(240_000);
  const api = new Api(request);
  // A 60 s film with a 30 s pilot: two written scenes of two shots each.
  const pid = await api.storyProject(`Storyboard (${testInfo.project.name})`, {
    screenplay: true,
    settings: { targetDurationSec: 60, pilotDurationSec: 30 },
  });
  await api.readyForStoryboard(pid);

  await page.goto(`/p/${pid}/storyboard`);
  await expect(page.getByTestId('approve-storyboard')).toBeDisabled();
  await page.getByTestId('generate-storyboard').click();
  const states = page.getByTestId('board-state');
  await expect(states.first()).toContainText('to review', { timeout: 90_000 });
  await api.waitIdle(pid, 120_000);
  const frames = await states.count();
  expect(frames).toBeGreaterThanOrEqual(4);
  await expect(page.getByTestId('storyboard-progress')).toContainText(`0 of ${frames} frames approved`);

  // Approve one frame, then reorder the first scene (the moved shot keeps its frame)
  const first = page.locator('[data-entity^="shot:"]').first();
  const firstId = (await first.getAttribute('data-entity'))!.slice('shot:'.length);
  await first.getByTestId('approve-board').click();
  await expect(first.getByTestId('board-state')).toContainText('approved');
  await first.getByTestId('move-later').click();
  await expect(page.locator('[data-entity^="shot:"]').nth(1)).toHaveAttribute(
    'data-entity',
    `shot:${firstId}`,
  );
  await page.getByTestId('approve-all-boards').click();
  await expect(page.getByTestId('storyboard-progress')).toContainText(
    `${frames} of ${frames} frames approved`,
  );
  await expect(page.getByTestId('approve-storyboard')).toBeEnabled();

  // Shot list downloads
  const csv = await request.get((await page.getByTestId('shotlist-csv').getAttribute('href'))!);
  expect(await csv.text()).toContain('scene,clip,shot,duration_sec');
  const pdf = await request.get((await page.getByTestId('shotlist-pdf').getAttribute('href'))!);
  expect((await pdf.body()).subarray(0, 5).toString()).toBe('%PDF-');

  // The animatic plays the frames with their dialogue, then renders in this tab
  await page.getByTestId('build-animatic').click();
  await expect(page.getByTestId('animatic-player')).toBeVisible();
  await page.getByTestId('play-animatic').click();
  await expect(page.getByTestId('animatic-time')).not.toContainText(/^0:00 \//, { timeout: 15_000 });
  await page.getByTestId('play-animatic').click();
  await page.getByTestId('export-animatic').click();
  await expect
    .poll(
      async () => {
        const exports = await api.call<any[]>('GET', `/projects/${pid}/exports`);
        return exports.find((e) => e.source === 'animatic')?.status;
      },
      { timeout: 180_000 },
    )
    .toBe('succeeded');
  await page.goto(`/p/${pid}/exports`);
  await expect(page.getByTestId('export-animatic-badge').first()).toBeVisible();

  await page.goto(`/p/${pid}/storyboard`);
  await page.getByTestId('approve-storyboard').click();
  await expect(page).toHaveURL(/\/clips$/);

  // A Fountain screenplay imported into a new project
  const fresh = await api.storyProject(`Import (${testInfo.project.name})`);
  await page.goto(`/p/${fresh}/story`);
  await page.getByTestId('import-screenplay').setInputFiles({
    name: 'ferry.fountain',
    mimeType: 'text/plain',
    buffer: Buffer.from(FOUNTAIN),
  });
  await expect(page.getByTestId('scenes')).toBeVisible();
  await expect(page.getByText('INT. FERRY CABIN - NIGHT').first()).toBeVisible();
  const state = await api.call<any>('GET', `/projects/${fresh}/state`);
  expect(state.docs.screenplay.title).toBe('The Night Ferry');
  expect(
    Object.values<any>(state.docs.characters)
      .map((c) => c.name)
      .sort(),
  ).toEqual(['Ada', 'Eli']);
});
