import { type APIRequestContext, expect, type Page, test } from '@playwright/test';
import { Api } from './support/api';
import { PORTS } from './support/ports';

/**
 * The 3D-Editor's director's desk embedded in the Storyboard view (docs/design/director-desk.md), against the fake
 * desk of e2e/fixtures/desk on another origin (localhost, the studio is 127.0.0.1), desktop and phone.
 */
const DESK_URL = `http://localhost:${PORTS.desk}/desk.html`;

/** A story project with its first scene planned (shots, no takes). */
async function planned(api: Api, title: string, settings: Record<string, unknown> = {}) {
  const pid = await api.storyProject(title, { screenplay: true, settings });
  const state = await api.call<any>('GET', `/projects/${pid}/state`);
  const plan = await api.call<any>('POST', `/projects/${pid}/clips/plan`, {
    sceneId: state.docs.screenplay.scenes[0].id,
  });
  await api.waitJob(pid, plan.id);
  const clip = Object.values<any>((await api.call<any>('GET', `/projects/${pid}/state`)).docs.clips)[0];
  return { pid, clip };
}

const desk = (page: Page) => page.frameLocator('[data-testid="desk-frame"]');

async function openDesk(page: Page, pid: string) {
  await page.goto(`/p/${pid}/storyboard`);
  await page.getByTestId('storyboard-scene').first().getByTestId('open-desk').click();
  await expect(page.getByTestId('desk-panel')).toBeVisible();
}

async function noSidewaysScroll(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

async function storedState(request: APIRequestContext, pid: string, clipId: string) {
  const res = await request.get(`/api/projects/${pid}/clips/${clipId}/desk-state`);
  expect(res.status()).toBe(200);
  return res.text();
}

test('the desk connects, its Send attaches every shot’s clip and camera, and its state is stored and given back', async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(180_000);
  const api = new Api(request);
  const { pid, clip } = await planned(api, `Desk (${testInfo.project.name})`);
  const shots = [...clip.shots].sort((a: any, b: any) => a.index - b.index);
  await openDesk(page, pid);
  await expect(page.getByTestId('desk-title')).toHaveText(clip.title);
  // Camera by default
  await expect(page.getByTestId('desk-mode')).toHaveValue('camera');
  const d = desk(page);
  await expect(d.getByTestId('desk-connected')).toHaveText('open');
  await expect(page.getByTestId('desk-status')).toContainText('Opened from the brief');
  await expect(d.getByTestId('desk-shot')).toHaveCount(shots.length);
  await expect(d.getByTestId('desk-given')).toHaveText('none');
  const options = JSON.parse((await d.getByTestId('desk-options').textContent())!);
  expect(options).toEqual({
    hostName: 'Rideo',
    modes: ['camera', 'motion', 'pose'],
    defaultMode: 'camera',
    readOnly: false,
  });
  // the page behind the panel is inert
  expect(await page.locator('[data-testid="rideo-root"] > [inert]').count()).toBeGreaterThan(0);
  await noSidewaysScroll(page);

  // Send: every shot's camera clip attached as its motion reference, with the staged lens and move
  await d.getByTestId('desk-send').click();
  await expect(d.getByTestId('desk-ack')).toContainText(`ok: Attached ${shots.length} reference`);
  const last = shots.length;
  await expect(page.getByTestId('toast').filter({ hasText: 'Attached' })).toContainText(
    `S${last}: the camera does not show the planned layout`,
  );
  const docs = (await api.call<any>('GET', `/projects/${pid}/state`)).docs;
  for (const shot of docs.clips[clip.id].shots) {
    expect(shot.motionReference).toMatchObject({ mode: 'camera' });
    expect(shot.camera).toMatchObject({ lensMm: 40, move: 'dolly_left' });
    const resource = docs.resources[shot.motionReference.resourceId];
    const frames = Math.max(1, Math.round(shot.durationSec * 24));
    expect(resource).toMatchObject({
      kind: 'video',
      role: 'reference',
      status: 'ready',
      name: `desk-c${clip.index + 1}-s${shot.index + 1}-camera.mp4`,
    });
    expect(resource.media).toMatchObject({
      width: 320,
      height: 180,
      fps: 24,
      videoCodec: 'h264',
      hasAudio: false,
    });
    expect(resource.media.durationSec).toBeCloseTo(frames / 24, 6);
    expect(resource.media.poster?.mime).toBe('image/jpeg');
  }

  // Close: the desk's state stored, and given back the next time
  await d.getByTestId('desk-edit').click();
  const staged = (await d.getByTestId('desk-current').textContent())!;
  await page.getByTestId('desk-close').click();
  await expect(page.getByTestId('desk-panel')).toBeHidden();
  expect(await storedState(request, pid, clip.id)).toBe(staged);
  const stored = (await api.call<any>('GET', `/projects/${pid}/state`)).docs.clips[clip.id].deskState;
  expect(stored).toMatchObject({ format: '3d-editor.desk-state', version: 1 });
  expect(stored.media.path).toMatch(/^media\/desk\/.+-[0-9a-f]{12}\.bin$/);
  await page.getByTestId('storyboard-scene').first().getByTestId('open-desk').click();
  await expect(desk(page).getByTestId('desk-given')).toHaveText(staged);
  await expect(page.getByTestId('desk-status')).toContainText('Opened from the stored desk');
  // the desk's own Done: its last state stored, the panel closed
  await desk(page).getByTestId('desk-edit').click();
  const done = (await desk(page).getByTestId('desk-current').textContent())!;
  await desk(page).getByTestId('desk-done').click();
  await expect(page.getByTestId('desk-panel')).toBeHidden();
  expect(await storedState(request, pid, clip.id)).toBe(done);
});

test('the Follow mode is the reference the shots get, and the browser remembers it', async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(180_000);
  const api = new Api(request);
  const { pid, clip } = await planned(api, `Desk follow (${testInfo.project.name})`);
  await openDesk(page, pid);
  await page.getByTestId('desk-mode').selectOption('pose');
  const d = desk(page);
  await expect(d.getByTestId('desk-connected')).toHaveText('open');
  await d.getByTestId('desk-send').click();
  await expect(d.getByTestId('desk-ack')).toContainText('ok: Attached');
  const docs = (await api.call<any>('GET', `/projects/${pid}/state`)).docs;
  for (const shot of docs.clips[clip.id].shots) {
    expect(shot.motionReference.mode).toBe('pose');
    expect(docs.resources[shot.motionReference.resourceId].name).toMatch(/-pose\.mp4$/);
  }
  await page.getByTestId('desk-close').click();
  await expect(page.getByTestId('desk-panel')).toBeHidden();
  // remembered by this browser: the next desk opens on Poses
  await page.reload();
  await page.getByTestId('storyboard-scene').first().getByTestId('open-desk').click();
  await expect(page.getByTestId('desk-mode')).toHaveValue('pose');
  const options = desk(page).getByTestId('desk-options');
  await expect(options).toContainText('"defaultMode":"pose"');
  await page.getByTestId('desk-close').click();
  await expect(page.getByTestId('desk-panel')).toBeHidden();
});

test('a desk that never says hello: the panel says so after 15 seconds, and Close still works', async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(120_000);
  const api = new Api(request);
  const { pid } = await planned(api, `Desk silent (${testInfo.project.name})`);
  // a desk page served without its headers: the browser refuses it inside the isolated studio, no hello comes
  await page.route(DESK_URL, (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>No desk</title>' }),
  );
  await openDesk(page, pid);
  const failure = page.getByTestId('desk-failure');
  await expect(failure).toContainText(
    `The desk at http://localhost:${PORTS.desk} did not answer. Check that it is served with the headers it needs`,
    { timeout: 40_000 },
  );
  await expect(failure.getByRole('link')).toHaveAttribute('href', /director-desk\.md#topology-and-headers$/);
  await noSidewaysScroll(page);
  await page.getByTestId('desk-close').click();
  await expect(page.getByTestId('desk-panel')).toBeHidden();
});

test('an approved clip opens read-only, and its result is refused', async ({ page, request }, testInfo) => {
  test.setTimeout(240_000);
  const api = new Api(request);
  const pid = await api.storyProject(`Desk approved (${testInfo.project.name})`, {
    screenplay: true,
    settings: { storyboard: { enabled: false } },
  });
  await api.readyForStoryboard(pid);
  const state = await api.call<any>('GET', `/projects/${pid}/state`);
  const plan = await api.call<any>('POST', `/projects/${pid}/clips/plan`, {
    sceneId: state.docs.screenplay.scenes[0].id,
    generate: true,
  });
  await api.waitJob(pid, plan.id);
  await api.waitIdle(pid, 150_000);
  const clip = Object.values<any>((await api.call<any>('GET', `/projects/${pid}/state`)).docs.clips)[0];
  await api.call('POST', `/projects/${pid}/clips/${clip.id}/approve`);

  await openDesk(page, pid);
  await expect(page.getByTestId('desk-read-only')).toBeVisible();
  const d = desk(page);
  await expect(d.getByTestId('desk-connected')).toHaveText('open');
  expect(JSON.parse((await d.getByTestId('desk-options').textContent())!)).toMatchObject({ readOnly: true });
  await d.getByTestId('desk-send').click();
  const n = clip.shots.length;
  await expect(d.getByTestId('desk-ack')).toContainText(
    `refused: Attached 0 of ${n} reference${n === 1 ? '' : 's'}. S1: clip ${clip.index + 1} is approved: unapprove it to change its shots.`,
  );
  await expect(page.getByTestId('toast').filter({ hasText: 'is approved' }).first()).toBeVisible();
  const docs = (await api.call<any>('GET', `/projects/${pid}/state`)).docs;
  for (const shot of docs.clips[clip.id].shots) expect(shot.motionReference).toBeNull();
  await page.getByTestId('desk-close').click();
  await expect(page.getByTestId('desk-panel')).toBeHidden();
});
