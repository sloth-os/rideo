import { expect, type Page, test } from '@playwright/test';
import { Api } from './support/api';
import { libraryUnit, pinUnit } from './support/desk-units';
import { at, PORTS } from './support/ports';

/**
 * Library units in the director's desk (docs/design/director-desk.md#library-units), desktop and phone, on the stack's
 * units studio: its desk is the fake desk of e2e/fixtures/desk in units mode (`desk.html?units=1`), which announces
 * the capability, shows the pins and the unit files it got (their sha256 checked), keeps a record per pinned slot in
 * its state and sends it as `state.units`, and publishes with Publish set, Publish new version and Publish prop.
 */
test.use({ baseURL: at(PORTS.units) });

/** The options an open with units gives a desk the person may publish from (no accounts on this studio). */
const UNITS_OPTION = '{"version":1,"publish":true}';

/** A story project with its first scene planned (shots, no takes). */
async function planned(api: Api, title: string) {
  const pid = await api.storyProject(title, { screenplay: true });
  const scene = (await docsOf(api, pid)).screenplay.scenes[0];
  const clip = await plan(api, pid, scene.id);
  return { pid, scene, clip };
}

/** Plans a scene's clip and answers it. */
async function plan(api: Api, pid: string, sceneId: string) {
  const job = await api.call<any>('POST', `/projects/${pid}/clips/plan`, { sceneId });
  await api.waitJob(pid, job.id);
  return Object.values<any>((await docsOf(api, pid)).clips).find((c) => c.sceneId === sceneId);
}

async function docsOf(api: Api, pid: string) {
  return (await api.call<any>('GET', `/projects/${pid}/state`)).docs;
}

/** What the clip's stored desk state uses (`clip.deskState.units`); undefined while no state is stored. */
async function unitsOf(api: Api, pid: string, clipId: string) {
  return (await docsOf(api, pid)).clips[clipId].deskState?.units;
}

/** The commits that pinned a 3D set on the element. */
async function setPins(api: Api, pid: string, elementId: string): Promise<number> {
  const commits = await api.call<{ message: string }[]>(
    'GET',
    `/projects/${pid}/history?path=elements/${elementId}.json`,
  );
  return commits.filter((c) => c.message.startsWith('Use the 3D set')).length;
}

const desk = (page: Page) => page.frameLocator('[data-testid="desk-frame"]');
const sceneRow = (page: Page, index: number) => page.getByTestId('storyboard-scene').nth(index);

async function openDesk(page: Page, pid: string, index = 0) {
  await page.goto(`/p/${pid}/storyboard`);
  await sceneRow(page, index).getByTestId('open-desk').click();
  await expect(page.getByTestId('desk-panel')).toBeVisible();
  await expect(desk(page).getByTestId('desk-connected')).toHaveText('open');
}

async function closeDesk(page: Page) {
  await page.getByTestId('desk-close').click();
  await expect(page.getByTestId('desk-panel')).toBeHidden();
}

async function noSidewaysScroll(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

test('a scene whose place, cast and prop are pinned opens with their pins and bytes, and its stored state records them', async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(240_000);
  const api = new Api(request);
  const { pid, scene, clip } = await planned(api, `Desk units (${testInfo.project.name})`);
  const docs = await docsOf(api, pid);
  const placeId: string = scene.locationId;
  const characterId: string = clip.shots.flatMap((s: any) => s.characterIds)[0];
  const propId: string = scene.elementIds.find((id: string) => docs.elements[id].kind === 'prop');
  expect(placeId && characterId && propId).toBeTruthy();
  const set = await libraryUnit(request, 'set', 'Old harbor');
  const figure = await libraryUnit(request, 'figure', 'Mira figure', { kind: 'adult', heightM: 1.7 });
  const prop = await libraryUnit(request, 'prop', 'Brass lamp');
  await pinUnit(api, pid, set, { kind: 'element', id: placeId });
  await pinUnit(api, pid, figure, { kind: 'character', id: characterId });
  await pinUnit(api, pid, prop, { kind: 'element', id: propId });

  await openDesk(page, pid);
  const d = desk(page);
  await expect(d.getByTestId('desk-units-option')).toHaveText(UNITS_OPTION);
  // the brief's pins in slot order (the set, the cast, the props), and every unit's bytes with their sha256
  await expect(d.getByTestId('desk-pin')).toHaveText([
    `set ${set.id}@1`,
    `cast:${characterId} ${figure.id}@1`,
    `el:${propId} ${prop.id}@1`,
  ]);
  await expect(d.getByTestId('desk-unit-file')).toHaveText([
    `${set.id}@1 ${set.bytes} bytes sha256 ok`,
    `${figure.id}@1 ${figure.bytes} bytes sha256 ok`,
    `${prop.id}@1 ${prop.bytes} bytes sha256 ok`,
  ]);
  const record = `set=${set.id}@1:unit, cast:${characterId}=${figure.id}@1:unit, el:${propId}=${prop.id}@1:unit`;
  await expect(d.getByTestId('desk-records')).toHaveText(record);
  await noSidewaysScroll(page);

  // Close stores the state with what it uses (X-Desk-State-Units), kept on the clip
  await closeDesk(page);
  await expect
    .poll(() => unitsOf(api, pid, clip.id), { timeout: 30_000 })
    .toEqual([
      { slot: 'set', ref: set.id, version: 1, staged: 'unit', local: false },
      { slot: `cast:${characterId}`, ref: figure.id, version: 1, staged: 'unit', local: false },
      { slot: `el:${propId}`, ref: prop.id, version: 1, staged: 'unit', local: false },
    ]);
  // every pin is current: no badge
  await page.reload();
  await expect(sceneRow(page, 0)).toBeVisible();
  await expect(sceneRow(page, 0).getByTestId('desk-unit-badge')).toHaveCount(0);

  // opened again: the stored state already uses every pin, so no file is sent, and the record keeps them
  await openDesk(page, pid);
  await expect(d.getByTestId('desk-pin')).toHaveCount(3);
  await expect(d.getByTestId('desk-unit-file')).toHaveCount(0);
  await expect(d.getByTestId('desk-records')).toHaveText(record);
  await closeDesk(page);
});

test('Publish set saves the place’s set to the library and links it; a new version moves the pin, and another scene at the place shows it available until its desk opens', async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(300_000);
  const api = new Api(request);
  const { pid, scene, clip } = await planned(api, `Desk publish (${testInfo.project.name})`);
  const placeId: string = scene.locationId;
  const place: string = (await docsOf(api, pid)).elements[placeId].name;
  // another scene at the same place, planned too
  await api.call('PATCH', `/projects/${pid}/screenplay`, {
    upsertScenes: [
      {
        heading: scene.heading,
        location: scene.location,
        timeOfDay: scene.timeOfDay,
        summary: 'They come back to the same place at dawn.',
        action: 'The two of them walk in and stop at the door.',
        characterIds: scene.characterIds,
        locationId: placeId,
        estDurationSec: 10,
      },
    ],
  });
  const later = (await docsOf(api, pid)).screenplay.scenes.find((s: any) => s.id !== scene.id);
  const second = await plan(api, pid, later.id);
  const d = desk(page);

  // the second scene's desk first: the place pins nothing yet, so its stored state uses no unit
  await openDesk(page, pid, 1);
  await expect(d.getByTestId('desk-units-option')).toHaveText(UNITS_OPTION);
  await expect(d.getByTestId('desk-pin')).toHaveCount(0);
  await closeDesk(page);
  await expect.poll(() => unitsOf(api, pid, second.id), { timeout: 30_000 }).toEqual([]);

  // Publish set from the first scene: a new item, the place linked in one commit, acknowledged `linked`
  await openDesk(page, pid, 0);
  await d.getByTestId('desk-publish-set').click();
  await expect(d.getByTestId('desk-unit-ack')).toHaveText(/^pub-1: lib_[0-9a-z]+ v1 linked$/);
  await expect(page.getByTestId('toast').filter({ hasText: 'Saved Harbor set v1' })).toContainText(
    `Saved Harbor set v1 to the library; linked to the scene's place (${place})`,
  );
  const pinned = (await docsOf(api, pid)).elements[placeId].deskUnit;
  expect(pinned).toMatchObject({ kind: 'desk-set', version: 1, name: 'Harbor set' });
  const ref: string = pinned.itemId;
  expect(await setPins(api, pid, placeId)).toBe(1);
  // the desk adopted it: its record holds the pin
  await expect(d.getByTestId('desk-records')).toHaveText(`set=${ref}@1:unit`);

  // Publish new version: v2 made from v1, and the place's pin moves to it
  await d.getByTestId('desk-publish-version').click();
  await expect(d.getByTestId('desk-unit-ack')).toHaveText(`pub-2: ${ref} v2 linked`);
  await expect(page.getByTestId('toast').filter({ hasText: 'Saved Harbor set v2' })).toContainText(
    `Saved Harbor set v2 to the library; linked to the scene's place (${place})`,
  );
  expect((await docsOf(api, pid)).elements[placeId].deskUnit).toMatchObject({ itemId: ref, version: 2 });
  expect(await setPins(api, pid, placeId)).toBe(2);
  const item = await api.call<any>('GET', `/library/items/${ref}`);
  expect(item).toMatchObject({ name: 'Harbor set', kind: 'desk-set', current: 2, latest: 2 });
  await expect(d.getByTestId('desk-records')).toHaveText(`set=${ref}@2:unit`);

  // Close: the first scene's state records v2
  await closeDesk(page);
  await expect
    .poll(() => unitsOf(api, pid, clip.id), { timeout: 30_000 })
    .toEqual([{ slot: 'set', ref, version: 2, staged: 'unit', local: false }]);
  // the first scene is current; the other scene at the place has v2 available
  await page.reload();
  await expect(sceneRow(page, 1)).toBeVisible();
  await expect(sceneRow(page, 0).getByTestId('desk-unit-badge')).toHaveCount(0);
  const badge = sceneRow(page, 1).getByTestId('desk-unit-badge');
  await expect(badge).toHaveText('3D: v2 available');
  await expect(badge).toHaveAttribute('title', `${place}: Harbor set v2 available (not staged yet)`);
  await noSidewaysScroll(page);

  // until its desk opens again: the pin and its bytes come, and its stored state uses v2
  await openDesk(page, pid, 1);
  await expect(d.getByTestId('desk-pin')).toHaveText([`set ${ref}@2`]);
  await expect(d.getByTestId('desk-unit-file')).toHaveText([new RegExp(`^${ref}@2 \\d+ bytes sha256 ok$`)]);
  await expect(d.getByTestId('desk-records')).toHaveText(`set=${ref}@2:unit`);
  await closeDesk(page);
  await expect
    .poll(() => unitsOf(api, pid, second.id), { timeout: 30_000 })
    .toEqual([{ slot: 'set', ref, version: 2, staged: 'unit', local: false }]);
  await page.reload();
  await expect(sceneRow(page, 1)).toBeVisible();
  await expect(sceneRow(page, 1).getByTestId('desk-unit-badge')).toHaveCount(0);
});

test('an approved clip’s desk may publish to the library, and the place is not linked', async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(240_000);
  const api = new Api(request);
  const pid = await api.storyProject(`Desk units approved (${testInfo.project.name})`, {
    screenplay: true,
    settings: { storyboard: { enabled: false } },
  });
  await api.readyForStoryboard(pid);
  const scene = (await docsOf(api, pid)).screenplay.scenes[0];
  const job = await api.call<any>('POST', `/projects/${pid}/clips/plan`, {
    sceneId: scene.id,
    generate: true,
  });
  await api.waitJob(pid, job.id);
  await api.waitIdle(pid, 150_000);
  const clip = Object.values<any>((await docsOf(api, pid)).clips)[0];
  await api.call('POST', `/projects/${pid}/clips/${clip.id}/approve`);

  await openDesk(page, pid);
  await expect(page.getByTestId('desk-read-only')).toBeVisible();
  const d = desk(page);
  await expect(d.getByTestId('desk-units-option')).toHaveText(UNITS_OPTION);
  await d.getByTestId('desk-publish-set').click();
  await expect(d.getByTestId('desk-unit-ack')).toHaveText(
    /^pub-1: lib_[0-9a-z]+ v1 not linked \(the scene is read-only\)$/,
  );
  await expect(page.getByTestId('toast').filter({ hasText: 'Saved Harbor set v1' })).toContainText(
    'Saved Harbor set v1 to the library; not linked: the scene is read-only',
  );
  // saved, not pinned: the place keeps no unit, and the desk's record stays empty
  const ref = (await d.getByTestId('desk-unit-ack').textContent())!.split(' ')[1]!;
  expect(await api.call<any>('GET', `/library/items/${ref}`)).toMatchObject({
    name: 'Harbor set',
    current: 1,
  });
  expect((await docsOf(api, pid)).elements[scene.locationId].deskUnit ?? null).toBeNull();
  await expect(d.getByTestId('desk-records')).toHaveText('');
  await noSidewaysScroll(page);
  await closeDesk(page);
});
