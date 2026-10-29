import { expect, test } from '@playwright/test';
import { Api } from './support/api';

/** Pixels of a canvas that differ from its first one: a drawn camera view, not an empty frame. */
async function drawnPixels(canvas: import('@playwright/test').Locator) {
  return canvas.evaluate((c: HTMLCanvasElement) => {
    const g = c.getContext('2d');
    if (!g || !c.width) return 0;
    const d = g.getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) if (Math.abs(d[i]! - d[0]!) + Math.abs(d[i + 2]! - d[2]!) > 30) n++;
    return n;
  });
}

test("the director's desk shows the AI's blocking, edits it, and the frames it changes are drawn again", async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(300_000);
  const api = new Api(request);
  const pid = await api.storyProject(`Desk (${testInfo.project.name})`, {
    screenplay: true,
    settings: {
      generation: { promptVersion: 2 },
      blocking: { enabled: true, layoutImage: true },
      storyboard: { enabled: true, scenes: 1 },
    },
  });
  await api.readyForStoryboard(pid);

  await page.goto(`/p/${pid}/storyboard`);
  await page.getByTestId('generate-storyboard').click();
  await expect(page.getByTestId('board-state').first()).toContainText('to review', { timeout: 120_000 });
  await api.waitIdle(pid, 180_000);

  // The scene was blocked by the AI before its frames were drawn
  const scene = page.getByTestId('storyboard-scene').first();
  await expect(scene).toContainText('blocked');
  await scene.getByTestId('open-desk').click();
  const desk = page.getByTestId('director-desk');
  await expect(desk).toBeVisible();
  await expect(desk.getByTestId('desk-state')).toContainText('Blocked by the AI');
  await expect(desk.getByTestId('desk-plan')).toBeVisible();
  await expect(desk.locator('[data-testid^="desk-camera-"]').first()).toBeAttached();
  const view = desk.getByTestId('desk-camera-view');
  await expect.poll(() => drawnPixels(view)).toBeGreaterThan(200);
  await expect(desk.getByTestId('desk-blocking-line')).toContainText('Blocking:');

  // Drag the first character across the plan: its mark moves and the draft is unsaved
  const actor = desk.locator('[data-testid^="desk-actor-"]').first();
  const x0 = Number(await actor.getAttribute('data-x'));
  const disc = await actor.locator('circle').first().boundingBox();
  expect(disc).not.toBeNull();
  await page.mouse.move(disc!.x + disc!.width / 2, disc!.y + disc!.height / 2);
  await page.mouse.down();
  await page.mouse.move(disc!.x + disc!.width / 2 + 60, disc!.y + disc!.height / 2, { steps: 6 });
  await page.mouse.up();
  await expect(desk).toHaveAttribute('data-dirty', 'true');
  await expect.poll(async () => Number(await actor.getAttribute('data-x'))).toBeGreaterThan(x0);

  // The inspector poses and turns it; the camera's lens and move are set
  await expect(desk.getByTestId('desk-pose')).toBeVisible();
  await desk.getByTestId('desk-pose').selectOption('wave');
  await desk.getByTestId('desk-shot-1').click();
  await desk.getByTestId('desk-move').selectOption('push_in');
  await desk.getByTestId('desk-auto-camera').click();

  // Saved: the frames drawn from the old blocking are outdated
  await desk.getByTestId('desk-save').click();
  await expect(desk).toHaveAttribute('data-dirty', 'false');
  await expect(scene.getByTestId('board-state').first()).toContainText('shot edited');
  // Fixed (solver and line), and the checks say what still breaks the scene
  await desk.getByTestId('desk-fix').click();
  await expect(desk.getByTestId('desk-issues')).toBeVisible();
  await desk.getByTestId('desk-redraw').click();
  await expect(scene.getByTestId('board-state').first()).toContainText('to review', { timeout: 120_000 });

  // Nothing scrolls sideways, at either size
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  await desk.getByTestId('desk-close').click();
  await expect(desk).toBeHidden();
});

test('the cast review gates the cast, shown with the cast', async ({ page, request }, testInfo) => {
  test.setTimeout(240_000);
  const api = new Api(request);
  const pid = await api.storyProject(`Cast review (${testInfo.project.name})`, {
    screenplay: true,
    settings: { review: { cast: true } },
  });
  await api.call('POST', `/projects/${pid}/workflow/approve`, { gate: 'screenplay_approved' });
  const s = await api.call<any>('GET', `/projects/${pid}/state`);
  for (const c of Object.values<any>(s.docs.characters)) {
    const j = await api.call<any>('POST', `/projects/${pid}/characters/${c.id}/references/generate`, {
      views: ['front'],
    });
    await api.waitJob(pid, j.id);
  }
  for (const e of Object.values<any>(s.docs.elements)) {
    const j = await api.call<any>('POST', `/projects/${pid}/elements/${e.id}/references/generate`, {});
    await api.waitJob(pid, j.id);
  }
  await api.waitIdle(pid, 120_000);
  await page.goto(`/p/${pid}/cast`);
  const panel = page.getByTestId('ai-review-cast');
  await expect(panel).toBeVisible();
  await expect(panel.getByTestId('ai-review-state')).toHaveText('Passed', { timeout: 60_000 });
  await expect(panel.getByTestId('ai-review-score-consistency')).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});
