import { expect, type Locator, type Page, test } from '@playwright/test';
import { Api } from './support/api';

/** Drags on the drawing layer from one point to another (fractions of the frame). */
async function drag(page: Page, layer: Locator, from: [number, number], to: [number, number]) {
  const box = (await layer.boundingBox())!;
  await page.mouse.move(box.x + box.width * from[0], box.y + box.height * from[1]);
  await page.mouse.down();
  await page.mouse.move(
    box.x + box.width * ((from[0] + to[0]) / 2),
    box.y + box.height * ((from[1] + to[1]) / 2),
    {
      steps: 4,
    },
  );
  await page.mouse.move(box.x + box.width * to[0], box.y + box.height * to[1], { steps: 4 });
  await page.mouse.up();
}

const noSideScroll = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

test('takes are reviewed with timecoded notes and drawings; an outside reviewer decides the pilot through a link', async ({
  page,
  browser,
  request,
}, testInfo) => {
  test.setTimeout(240_000);
  const api = new Api(request);
  const pid = await api.storyProject(`Review (${testInfo.project.name})`, {
    screenplay: true,
    settings: { storyboard: { enabled: false } },
  });
  await api.readyForStoryboard(pid);
  await api.call('POST', `/projects/${pid}/workflow/approve`, { gate: 'storyboard_approved' });
  const state = await api.call<any>('GET', `/projects/${pid}/state`);
  const plan = await api.call<any>('POST', `/projects/${pid}/clips/plan`, {
    sceneId: state.docs.screenplay.scenes[0].id,
    generate: true,
  });
  await api.waitJob(pid, plan.id);
  await api.waitIdle(pid, 120_000);

  // A note with a drawing on a take, a reply, resolved
  await page.goto(`/p/${pid}/clips`);
  const tile = page.locator('[data-entity^="take:"]').first();
  await tile.getByTestId('take-comments').click();
  const dialog = page.getByRole('dialog');
  const player = dialog.getByTestId('review-player');
  await expect(player).toBeVisible();
  await expect
    .poll(() => player.getByTestId('review-video').evaluate((v: HTMLVideoElement) => v.readyState))
    .toBeGreaterThan(0);
  await player.getByTestId('review-video').evaluate((v: HTMLVideoElement) => {
    v.currentTime = 1;
  });
  await expect(player.getByTestId('comment-composer')).toContainText('0:01.0');
  await player.getByTestId('draw-box').click();
  await drag(page, player.getByTestId('annotation-layer'), [0.2, 0.2], [0.6, 0.7]);
  await expect(player.getByTestId('draw-clear')).toHaveText('1');
  await player.getByTestId('comment-body').fill('The lamp flickers here; keep it steady');
  await player.getByTestId('comment-post').click();
  const thread = player.getByTestId('comment-thread').first();
  await expect(thread.getByTestId('comment-text')).toHaveText('The lamp flickers here; keep it steady');
  await expect(thread.getByTestId('comment-time')).toHaveText('0:01.0');
  await expect(player.getByTestId('comment-marker')).toHaveCount(1);
  await expect(player.getByTestId('annotation-layer')).toHaveAttribute('data-shapes', '1');
  await thread.getByTestId('comment-reply-open').click();
  await thread.getByTestId('reply-body').fill('Regenerating with a steadier lamp');
  await thread.getByTestId('reply-post').click();
  await expect(thread.getByTestId('comment-reply')).toContainText('Regenerating with a steadier lamp');
  await page.keyboard.press('Escape');
  await expect(tile.getByTestId('take-comments')).toHaveAttribute('data-open', '1');
  await tile.getByTestId('take-comments').click();
  await dialog.getByTestId('comment-thread').first().getByTestId('comment-resolve').click();
  await expect(dialog.getByTestId('comment-thread').first()).toHaveAttribute('data-status', 'resolved');
  await page.keyboard.press('Escape');
  await expect(tile.getByTestId('take-comments')).toHaveAttribute('data-open', '0');

  // A review of the pilot for the client, deciding the pilot gate, with a share link
  const title = `Pilot for Northwind (${testInfo.project.name})`;
  await page.goto(`/p/${pid}/overview`);
  const card = page.getByTestId('reviews-card');
  await card.getByTestId('review-new').click();
  await page.getByTestId('review-title').fill(title);
  await page.getByTestId('review-gate-select').selectOption('pilot_approved');
  await page.getByTestId('review-create').click();
  const url = await page.getByTestId('review-link-url').inputValue();
  expect(url).toMatch(/\/review\/prj_[0-9a-z]+\.rev_[0-9a-z]+\.[\w-]+$/);
  await page.getByTestId('review-done').click();
  const row = card.getByTestId('review-row').filter({ hasText: title });
  await expect(row.getByTestId('review-link-state')).toContainText('link active');
  await expect(row.getByTestId('review-gate')).toHaveText('pilot_approved');

  // The client, without an account: a name, the takes, a note with an arrow, then changes requested
  const client = await browser.newContext({
    viewport: page.viewportSize() ?? undefined,
    isMobile: testInfo.project.name === 'mobile',
    hasTouch: testInfo.project.name === 'mobile',
  });
  const guest = await client.newPage();
  await guest.goto(new URL(url).pathname);
  await expect(guest.getByTestId('guest-review-title')).toHaveText(title);
  await guest.getByTestId('guest-name').fill('Ana from Northwind');
  await guest.getByTestId('guest-start').click();
  const gp = guest.getByTestId('review-player');
  await expect(gp.getByTestId('comment-thread')).toHaveCount(1);
  await expect
    .poll(() => gp.getByTestId('review-video').evaluate((v: HTMLVideoElement) => v.readyState))
    .toBeGreaterThan(0);
  await gp.getByTestId('draw-arrow').click();
  await drag(guest, gp.getByTestId('annotation-layer'), [0.8, 0.8], [0.5, 0.4]);
  await gp.getByTestId('comment-body').fill('Can the logo be bigger at the start?');
  await gp.getByTestId('comment-post').click();
  await expect(gp.getByTestId('comment-thread').filter({ hasText: 'logo be bigger' })).toContainText('guest');
  expect(await noSideScroll(guest)).toBe(true);
  await guest.getByTestId('guest-note').fill('Bigger logo, then it is good');
  await guest.getByTestId('guest-changes').click();
  await expect(guest.getByTestId('guest-status')).toHaveText('changes requested');
  await expect(guest.getByTestId('guest-my-decision')).toHaveText('changes requested');

  // The studio hears of it live: the bell leads to the client's note
  await expect(row.getByTestId('review-status')).toHaveText('changes requested');
  await expect(page.getByTestId('notifications-unread')).toBeVisible();
  await page.getByTestId('notifications').click();
  await page
    .getByTestId('notification-item')
    .filter({ hasText: `Ana from Northwind commented on “${title}”` })
    .first()
    .click();
  await expect(page).toHaveURL(new RegExp(`/p/${pid}/clips`));
  await expect(
    page.getByRole('dialog').getByTestId('comment-thread').filter({ hasText: 'logo be bigger' }),
  ).toBeVisible();
  await page.keyboard.press('Escape');

  // The pilot is approved in the studio; the client's approval then approves the gate
  const clip = Object.values<any>((await api.call<any>('GET', `/projects/${pid}/state`)).docs.clips)[0];
  await api.call('POST', `/projects/${pid}/clips/${clip.id}/approve`);
  await guest.getByTestId('guest-approve').click();
  await expect(guest.getByTestId('guest-status')).toHaveText('approved');
  await page.goto(`/p/${pid}/overview`);
  await expect(row.getByTestId('review-gate')).toHaveText('pilot_approved ✓');
  await expect
    .poll(async () => (await api.call<any>('GET', `/projects/${pid}/state`)).docs.project.workflow.stage)
    .toBe('production');

  // Revoked: the link opens nothing
  await row.getByTestId('review-revoke').click();
  await expect(row.getByTestId('review-link-state')).toContainText('link revoked');
  await guest.reload();
  await expect(guest.getByText('This review link does not exist or has expired')).toBeVisible();
  expect(await noSideScroll(page)).toBe(true);
  await client.close();
});
