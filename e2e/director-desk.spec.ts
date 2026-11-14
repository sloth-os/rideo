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

/** The stored state's text, or null while none is stored (for polling). */
async function storedNow(request: APIRequestContext, pid: string, clipId: string): Promise<string | null> {
  const res = await request.get(`/api/projects/${pid}/clips/${clipId}/desk-state`);
  return res.status() === 200 ? res.text() : null;
}

/** A desk state stored as another session would (a write without a precondition replaces whatever is stored). */
async function storeAsAnotherSession(request: APIRequestContext, pid: string, clipId: string, text: string) {
  const res = await request.put(`/api/projects/${pid}/clips/${clipId}/desk-state`, {
    headers: {
      'content-type': 'application/octet-stream',
      'x-desk-state-format': '3d-editor.desk-state',
      'x-desk-state-version': '1',
    },
    data: Buffer.from(text),
  });
  expect(res.status()).toBe(200);
}

/**
 * The Storyboard view reached from the project's overview inside the studio (a navigation of the page, not a load),
 * so the browser's back leaves it for the overview.
 */
async function storyboardFromOverview(page: Page, pid: string, mobile: boolean) {
  await page.goto(`/p/${pid}`);
  await expect(page.getByTestId('view-overview')).toBeVisible();
  if (mobile) {
    await page.getByTestId('mnav-more').click();
    await page.getByTestId('mnav-storyboard').click();
  } else await page.getByTestId('nav-storyboard').click();
  await expect(page.getByTestId('view-storyboard')).toBeVisible();
}

/** The commits that stored a desk state of the clip. */
async function deskCommits(api: Api, pid: string, clipId: string): Promise<number> {
  const commits = await api.call<{ message: string }[]>(
    'GET',
    `/projects/${pid}/history?path=clips/${clipId}.json`,
  );
  return commits.filter((c) => c.message.startsWith('Save the desk')).length;
}

test('the desk connects, its Send attaches every shot’s clip and camera, and its state is stored and given back', async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(240_000);
  const api = new Api(request);
  const { pid, clip } = await planned(api, `Desk (${testInfo.project.name})`);
  const shots = [...clip.shots].sort((a: any, b: any) => a.index - b.index);
  const plannedCamera = new Map(shots.map((s: any) => [s.id, s.camera]));
  await openDesk(page, pid);
  await expect(page.getByTestId('desk-title')).toHaveText(clip.title);
  // sandboxed: scripts, its own storage and downloads, never the studio's tab
  const frame = page.getByTestId('desk-frame');
  const sandbox = ((await frame.getAttribute('sandbox')) ?? '').split(/\s+/);
  expect(sandbox).toEqual(expect.arrayContaining(['allow-scripts', 'allow-same-origin', 'allow-downloads']));
  expect(sandbox.filter((t) => t.startsWith('allow-top-navigation'))).toEqual([]);
  await expect(frame).toHaveAttribute('allow', /screen-wake-lock/);
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
    // the staged lens and move; the planned framing and movement kept
    const plan = plannedCamera.get(shot.id) as { framing: string; movement: string };
    expect(shot.camera).toMatchObject({
      lensMm: 40,
      move: 'dolly_left',
      framing: plan.framing,
      movement: plan.movement,
    });
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
  // opened and closed without an edit: the desk sends the same bytes, nothing is stored (the same file, no commit)
  const commits = await deskCommits(api, pid, clip.id);
  await page.getByTestId('desk-close').click();
  await expect(page.getByTestId('desk-panel')).toBeHidden();
  expect((await api.call<any>('GET', `/projects/${pid}/state`)).docs.clips[clip.id].deskState).toEqual(
    stored,
  );
  expect(await deskCommits(api, pid, clip.id)).toBe(commits);
  await page.getByTestId('storyboard-scene').first().getByTestId('open-desk').click();
  await expect(desk(page).getByTestId('desk-given')).toHaveText(staged);
  // the desk's own Done: its last state stored, the panel closed
  await desk(page).getByTestId('desk-edit').click();
  const done = (await desk(page).getByTestId('desk-current').textContent())!;
  await desk(page).getByTestId('desk-done').click();
  await expect(page.getByTestId('desk-panel')).toBeHidden();
  expect(await storedState(request, pid, clip.id)).toBe(done);

  // leaving the Storyboard view without Close (the browser's back): the edit is stored on the way out
  await storyboardFromOverview(page, pid, testInfo.project.name === 'mobile');
  await page.getByTestId('storyboard-scene').first().getByTestId('open-desk').click();
  await expect(desk(page).getByTestId('desk-given')).toHaveText(done);
  await desk(page).getByTestId('desk-edit').click();
  const left = (await desk(page).getByTestId('desk-current').textContent())!;
  // the edit's state crosses to the studio over the desk's port
  await page.waitForTimeout(500);
  await page.goBack();
  await expect(page.getByTestId('view-overview')).toBeVisible();
  await expect(page.getByTestId('desk-panel')).toHaveCount(0);
  await expect.poll(() => storedNow(request, pid, clip.id), { timeout: 15_000 }).toBe(left);

  // another session stores a state while the desk is open: Close keeps it and says so; Close again closes
  await openDesk(page, pid);
  await expect(desk(page).getByTestId('desk-given')).toHaveText(left);
  await storeAsAnotherSession(request, pid, clip.id, 'stored by another session');
  await desk(page).getByTestId('desk-edit').click();
  await page.getByTestId('desk-close').click();
  await expect(page.getByTestId('desk-kept-notice')).toHaveText(
    'Another session stored a newer desk state for this clip; it was kept',
  );
  await expect(page.getByTestId('desk-kept')).toHaveAttribute('data-reason', 'conflict');
  await expect(page.getByTestId('desk-panel')).toBeVisible();
  await expect(page.getByTestId('desk-status')).toContainText('The desk was not stored');
  await expect(
    page.getByTestId('toast').filter({ hasText: 'Another session stored a newer desk state' }).first(),
  ).toBeVisible();
  await noSidewaysScroll(page);
  expect(await storedState(request, pid, clip.id)).toBe('stored by another session');
  await page.getByTestId('desk-close').click();
  await expect(page.getByTestId('desk-panel')).toBeHidden();
  expect(await storedState(request, pid, clip.id)).toBe('stored by another session');
});

test('a partial result attaches the shots it has, and the desk says which shot it left out', async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(180_000);
  const api = new Api(request);
  // a 30 s pilot: the first scene is planned as two shots
  const { pid, clip } = await planned(api, `Desk part (${testInfo.project.name})`, {
    targetDurationSec: 60,
    pilotDurationSec: 30,
  });
  const shots = [...clip.shots].sort((a: any, b: any) => a.index - b.index);
  expect(shots.length).toBeGreaterThan(1);
  await openDesk(page, pid);
  const d = desk(page);
  await expect(d.getByTestId('desk-connected')).toHaveText('open');
  await d.getByTestId('desk-send-part').click();
  const n = shots.length - 1;
  await expect(d.getByTestId('desk-ack')).toContainText(`ok: Attached ${n} reference${n === 1 ? '' : 's'}.`);
  // the desk's export_failed, named after the result, in a toast
  await expect(page.getByTestId('toast').filter({ hasText: 'was not rendered' })).toContainText(
    `S${shots.length} (${shots.at(-1).id}) was not rendered: the encoder stopped`,
  );
  const docs = (await api.call<any>('GET', `/projects/${pid}/state`)).docs;
  const after = [...docs.clips[clip.id].shots].sort((a: any, b: any) => a.index - b.index);
  for (const shot of after.slice(0, -1)) expect(shot.motionReference).toMatchObject({ mode: 'camera' });
  expect(after.at(-1).motionReference).toBeNull();
  await noSidewaysScroll(page);
  await page.getByTestId('desk-close').click();
  await expect(page.getByTestId('desk-panel')).toBeHidden();
});

test('a stored state the desk cannot read is kept until the person replaces it; one the server cannot read fails the panel until Retry or Start over', async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(240_000);
  const api = new Api(request);
  const { pid, clip } = await planned(api, `Desk unreadable (${testInfo.project.name})`);
  const unreadable = 'unreadable: saved by another desk';
  await storeAsAnotherSession(request, pid, clip.id, unreadable);
  // the desk cannot read it: it stages the brief and sends nothing; the panel keeps the stored state and says why
  await openDesk(page, pid);
  const d = desk(page);
  await expect(d.getByTestId('desk-connected')).toHaveText('open');
  await expect(page.getByTestId('desk-status')).toContainText('Opened from the brief');
  await expect(page.getByTestId('desk-kept')).toHaveAttribute('data-reason', 'unreadable');
  const notice =
    'The stored desk state was kept: the desk could not read it (the state was saved by a desk this one does not read)';
  await expect(page.getByTestId('desk-kept-notice')).toHaveText(notice);
  await expect(page.getByTestId('toast').filter({ hasText: notice }).first()).toBeVisible();
  await noSidewaysScroll(page);
  // an edit is not stored, on Close either: the stored state stays as it was
  await d.getByTestId('desk-edit').click();
  await page.getByTestId('desk-close').click();
  await expect(page.getByTestId('desk-panel')).toBeHidden();
  expect(await storedState(request, pid, clip.id)).toBe(unreadable);

  // Replace the stored desk state, once confirmed: what the desk holds now replaces it, later edits are stored
  await page.getByTestId('storyboard-scene').first().getByTestId('open-desk').click();
  await expect(page.getByTestId('desk-kept')).toBeVisible();
  await page.getByTestId('desk-replace').click();
  await expect(page.getByTestId('desk-replace-what')).toContainText(
    'replaces the stored desk state, which this desk could not read',
  );
  await noSidewaysScroll(page);
  await page.getByTestId('desk-replace-confirm').click();
  await expect(page.getByTestId('desk-kept')).toBeHidden();
  const staged = `staged ${clip.id}`;
  await expect.poll(() => storedNow(request, pid, clip.id), { timeout: 15_000 }).toBe(staged);
  await d.getByTestId('desk-edit').click();
  const edited = (await d.getByTestId('desk-current').textContent())!;
  await page.getByTestId('desk-close').click();
  await expect(page.getByTestId('desk-panel')).toBeHidden();
  expect(await storedState(request, pid, clip.id)).toBe(edited);

  // the server cannot read the stored state (503): the panel fails with Retry and Start over, the desk not opened
  let failing = true;
  await page.route(`**/api/projects/${pid}/clips/${clip.id}/desk-state`, (route) =>
    failing && route.request().method() === 'GET'
      ? route.fulfill({
          status: 503,
          contentType: 'application/problem+json',
          body: JSON.stringify({
            type: 'about:blank',
            title: 'Service Unavailable',
            status: 503,
            detail: 'the stored desk state of scene 1 could not be read: storage answered 404',
            code: 'storage_error',
          }),
        })
      : route.fallback(),
  );
  await page.getByTestId('storyboard-scene').first().getByTestId('open-desk').click();
  await expect(page.getByTestId('desk-failure')).toContainText(
    'The stored desk could not be loaded: the stored desk state of scene 1 could not be read: storage answered 404',
  );
  await expect(page.getByTestId('desk-start-over')).toBeVisible();
  await expect(d.getByTestId('desk-connected')).toHaveText('connected');
  await noSidewaysScroll(page);
  failing = false;
  await page.getByTestId('desk-retry').click();
  await expect(d.getByTestId('desk-connected')).toHaveText('open');
  await expect(d.getByTestId('desk-given')).toHaveText(edited);
  await expect(page.getByTestId('desk-status')).toContainText('Opened from the stored desk');
  await page.getByTestId('desk-close').click();
  await expect(page.getByTestId('desk-panel')).toBeHidden();
  expect(await storedState(request, pid, clip.id)).toBe(edited);

  // a state gone for good: Start over, once confirmed, clears it and opens the desk from the brief
  failing = true;
  await page.getByTestId('storyboard-scene').first().getByTestId('open-desk').click();
  await expect(page.getByTestId('desk-failure')).toBeVisible();
  await page.getByTestId('desk-start-over').click();
  await expect(page.getByTestId('desk-start-over-what')).toContainText(
    'What was staged only in the stored desk state is lost',
  );
  await noSidewaysScroll(page);
  await page.getByTestId('desk-start-over-confirm').click();
  await expect(d.getByTestId('desk-connected')).toHaveText('open');
  await expect(d.getByTestId('desk-given')).toHaveText('none');
  await expect(page.getByTestId('desk-status')).toContainText('Opened from the brief');
  expect(await storedNow(request, pid, clip.id)).toBeNull();
  // the desk's state is stored as the first one again
  await page.getByTestId('desk-close').click();
  await expect(page.getByTestId('desk-panel')).toBeHidden();
  expect(await storedState(request, pid, clip.id)).toBe(staged);
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
