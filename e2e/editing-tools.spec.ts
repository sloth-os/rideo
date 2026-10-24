import { expect, type Page, test } from '@playwright/test';
import { Api, makeFootage } from './support/api';
import { exportInThisTab } from './support/ui';

/**
 * Editing tools after Premiere Pro and CapCut (docs/design/editing-tools.md): markers, shortcuts, undo and redo, split,
 * duplicate, a freeze frame from the context menu, detached audio dragged with snapping and between tracks, track lock
 * and hide, mirror, adjustments, a chroma key, a slide transition, all exported in this tab with ffmpeg.wasm. On
 * phones: the same tools from the inspector and the Markers card.
 */

type Timeline = {
  tracks: { id: string; name: string; kind: string; hidden?: boolean; locked?: boolean; items: any[] }[];
  markers?: { t: number; label: string }[];
};

async function seekTo(page: Page, t: number) {
  const seek = page.getByLabel('Seek');
  await seek.fill(String(t));
  await seek.blur();
}

/** Drags from the middle of an element by (dx, dy) pixels; `during` runs with the button down. */
async function dragBy(
  page: Page,
  el: ReturnType<Page['locator']>,
  dx: number,
  dy: number,
  during?: () => Promise<void>,
) {
  await el.scrollIntoViewIfNeeded();
  const box = (await el.boundingBox())!;
  const x = box.x + Math.min(box.width / 2, 30);
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx / 2, y + dy / 2, { steps: 4 });
  await page.mouse.move(x + dx, y + dy, { steps: 4 });
  await during?.();
  await page.mouse.up();
}

test('editing tools: markers, shortcuts, undo, freeze, detach, snapping, tracks, mirror, adjust, key, slide', async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(300_000);
  const api = new Api(request);
  const pid = await api.editProjectWithClip(
    `Tools (${testInfo.project.name})`,
    makeFootage(testInfo.outputPath('clip.mp4')),
  );
  const timeline = () => api.call<Timeline>('GET', `/projects/${pid}/timeline`);
  const picture = async () => (await timeline()).tracks[0]!.items;
  const phone = (page.viewportSize()?.width ?? 1280) < 768;
  await page.goto(`/p/${pid}/editor`);

  if (phone) {
    // A marker from the Markers card, then named in its inspector
    await expect(page.getByTestId('timeline-list')).toBeVisible();
    await seekTo(page, 1);
    await page.getByTestId('marker-add').click();
    await expect(page.getByTestId('marker-row')).toHaveCount(1);
    await expect.poll(async () => (await timeline()).markers?.map((m) => m.t)).toEqual([1]);
    await page.getByTestId('marker-label').fill('Beat');
    await page.getByTestId('marker-label').blur();
    await expect.poll(async () => (await timeline()).markers?.[0]?.label).toBe('Beat');
    // The inspector's clip tools: a freeze frame at the playhead, a mirror, then undo and redo
    await page.getByTestId('timeline-list').locator('button').first().click();
    await seekTo(page, 2);
    await page.getByTestId('freeze-frame').click();
    await expect
      .poll(async () => (await picture()).map((i) => i.freeze?.duration ?? null))
      .toEqual([null, 2, null]);
    await page.getByTestId('timeline-list').locator('button').first().click();
    await page.getByTestId('mirror').click();
    await expect.poll(async () => (await picture())[0].flip).toEqual({ x: true });
    await page.getByTestId('undo').click();
    await expect.poll(async () => (await picture())[0].flip).toBeUndefined();
    await page.getByTestId('redo').click();
    await expect.poll(async () => (await picture())[0].flip).toEqual({ x: true });
    await page.getByTestId('duplicate-item').click();
    await expect.poll(async () => (await picture()).length).toBe(4);
    await page.getByTestId('adjust-temperature').fill('0.3');
    await expect.poll(async () => (await picture())[0].effects?.temperature).toBe(0.3);
    // A locked track (no lane headers here): its items' inspector says so and unlocks it
    await api.call('POST', `/projects/${pid}/timeline/ops`, {
      ops: [{ op: 'set_track', trackId: 'trk_primaryvideo01', locked: true }],
    });
    await expect(page.getByTestId('inspector-locked')).toBeVisible();
    await page.getByTestId('inspector-unlock').click();
    await expect.poll(async () => (await timeline()).tracks[0]!.locked).toBeUndefined();
    await expect(page.getByTestId('clip-actions')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(
      true,
    );
    return;
  }

  const video = page.locator('[data-track-name="Video"]');
  await expect(video.getByTestId('timeline-item')).toHaveCount(1);
  // Dragging on the ruler scrubs the playhead (at 40 px/s), in small steps
  const ruler = (await page.getByTestId('ruler').boundingBox())!;
  await page.mouse.move(ruler.x + 0.5 * 40, ruler.y + ruler.height / 2);
  await page.mouse.down();
  await page.mouse.move(ruler.x + 2.5 * 40, ruler.y + ruler.height / 2, { steps: 16 });
  await page.mouse.up();
  await expect(page.getByTestId('timecode')).toContainText('00:00:02:12');
  // M adds a marker at the playhead and selects it
  await seekTo(page, 1);
  await page.keyboard.press('m');
  await expect(page.getByTestId('marker')).toHaveCount(1);
  await page.getByTestId('marker-label').fill('Beat');
  await page.getByTestId('marker-label').blur();
  await expect
    .poll(async () => (await timeline()).markers)
    .toEqual([expect.objectContaining({ t: 1, label: 'Beat', color: 'orange' })]);

  // S splits the picture under the playhead; undo and redo walk the history
  await seekTo(page, 3);
  await page.keyboard.press('s');
  await expect.poll(async () => (await picture()).length).toBe(2);
  await page.keyboard.press('Control+z');
  await expect.poll(async () => (await picture()).length).toBe(1);
  await page.keyboard.press('Control+Shift+z');
  await expect.poll(async () => (await picture()).length).toBe(2);
  await expect(video.getByTestId('timeline-item')).toHaveCount(2);

  // Ctrl+D duplicates the selected item after it
  await video.getByTestId('timeline-item').first().click();
  await page.keyboard.press('Control+d');
  await expect
    .poll(async () => (await picture()).map((i) => [i.start, i.in, i.out]))
    .toEqual([
      [0, 0, 3],
      [3, 0, 3],
      [6, 3, 6],
    ]);

  // The context menu: a freeze frame at the playhead (the copy's first frame)
  await video.getByTestId('timeline-item').nth(1).click({ button: 'right' });
  await expect(page.getByTestId('context-menu')).toBeVisible();
  await page.getByTestId('menu-freeze').click();
  await expect
    .poll(async () => (await picture()).map((i) => i.freeze?.duration ?? null))
    .toEqual([null, 2, null, null]);
  await expect(video.getByTestId('item-freeze')).toBeVisible();

  // Detach the first item's sound onto a new Sound track
  await video.getByTestId('timeline-item').first().click();
  await page.getByTestId('detach-audio').click();
  await expect
    .poll(async () => (await timeline()).tracks.find((t) => t.name === 'Sound')?.items.length)
    .toBe(1);
  expect((await picture())[0].muted).toBe(true);

  // Drag it 0.93 s later: it snaps to the marker at 1 s, with the guide showing while dragging
  const sound = page.locator('[data-track-name="Sound"]').getByTestId('timeline-item');
  await dragBy(page, sound, 0.93 * 40, 0, async () => {
    await expect(page.getByTestId('snap-guide')).toBeVisible();
  });
  await expect
    .poll(async () => (await timeline()).tracks.find((t) => t.name === 'Sound')?.items[0]?.start)
    .toBe(1);
  // ...and down onto the Music track, keeping its time
  const music = page.locator('[data-track-name="Music"]');
  const [from, to] = [(await sound.boundingBox())!, (await music.boundingBox())!];
  await dragBy(page, sound, 0, to.y + to.height / 2 - (from.y + from.height / 2));
  await expect
    .poll(async () => (await timeline()).tracks.find((t) => t.name === 'Music')?.items.map((i) => i.start))
    .toEqual([1]);

  // A locked track refuses edits; a hidden one is not drawn
  const header = page.locator('[data-testid="track-header"]').first();
  await header.getByTestId('track-lock').click();
  await expect(video).toHaveAttribute('data-locked', 'true');
  await video.getByTestId('timeline-item').last().click();
  await expect(page.getByTestId('inspector-locked')).toBeVisible();
  await page.keyboard.press('Delete');
  await page.waitForTimeout(500);
  expect(await picture()).toHaveLength(4);
  await header.getByTestId('track-lock').click();
  await expect(video).not.toHaveAttribute('data-locked', 'true');
  await header.getByTestId('track-hide').click();
  await expect(video).toHaveAttribute('data-hidden', 'true');
  await expect.poll(async () => (await timeline()).tracks[0]!.hidden).toBe(true);
  await header.getByTestId('track-hide').click();
  await expect.poll(async () => (await timeline()).tracks[0]!.hidden).toBeUndefined();

  // The last item: mirrored, brighter, keyed and slid in
  await video.getByTestId('timeline-item').last().click();
  await page.getByTestId('mirror').click();
  await expect.poll(async () => (await picture())[3].flip).toEqual({ x: true });
  await expect(video.getByTestId('item-mirror')).toBeVisible();
  await page.getByTestId('adjust-exposure').fill('0.5');
  await expect.poll(async () => (await picture())[3].effects?.exposure).toBe(0.5);
  await page.getByTestId('key-toggle').click();
  await expect
    .poll(async () => (await picture())[3].key)
    .toEqual({ color: '#00ff00', similarity: 0.3, blend: 0.1 });
  await page.getByTestId('transition-select').selectOption('slide_left');
  await expect.poll(async () => (await picture())[3].transitionIn?.type).toBe('slide_left');

  // ? lists the shortcuts
  await page.locator('body').click({ position: { x: 4, y: 4 } });
  await page.keyboard.press('?');
  await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toContainText(
    'Split at the playhead',
  );
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeHidden();

  // The whole cut renders in this tab with ffmpeg.wasm: freeze, mirror, adjustments, key and slide
  await exportInThisTab(page, { quality: 'draft', engine: 'ffmpeg' });
});
