import { createHash } from 'node:crypto';
import {
  type APIRequestContext,
  expect,
  type Locator,
  type Page,
  type TestInfo,
  test,
} from '@playwright/test';
import { Api } from './support/api';

/**
 * The studio library's UI (docs/design/library.md#the-ui): Mira saved in episode 1 is used in episode 2 with her id
 * and seed, kept by the writer, linked in a project with a Mira of its own, and updated to the v2 episode 1 publishes,
 * with the warning of the approved clip it makes stale; 3D sets uploaded through the REST API are pinned on a
 * location, moved to their new versions from its 3D row and from the Library page, changed and unlinked; the Library
 * page lists, filters, tags and archives. Desktop and phone. The library is the studio's: every item here carries a tag
 * and a name of this run's own.
 */

// 1×1 PNG: a stand-in for an uploaded photo of an actor.
const PHOTO = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);

/** A tag only this test's items carry: the viewport and the time, for runs side by side and runs again. */
const runTag = (testInfo: TestInfo) =>
  `e2e-${testInfo.project.name}-${Date.now().toString(36)}-${testInfo.retry}`.slice(0, 40);

const docsOf = async (api: Api, pid: string) => (await api.call<any>('GET', `/projects/${pid}/state`)).docs;

const toast = (page: Page, text: string) => page.getByTestId('toast').filter({ hasText: text });

async function noSidewaysScroll(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

/** Every name shown whole: visible, with nothing of it cut off (1 px for rounding). */
async function namesWhole(names: Locator) {
  await expect(names.first()).toBeVisible();
  for (const name of await names.all()) {
    await expect(name).toBeVisible();
    const { text, shown, full } = await name.evaluate((e) => ({
      text: e.textContent ?? '',
      shown: e.clientWidth,
      full: e.scrollWidth,
    }));
    expect(shown, `${text}: ${shown} of its ${full} px shown`).toBeGreaterThanOrEqual(full - 1);
  }
}

/** A photo of a real person as one of the character's references, with its consent record. */
async function uploadPhoto(request: APIRequestContext, pid: string, cid: string): Promise<void> {
  const res = await request.post(`/api/projects/${pid}/characters/${cid}/references`, {
    multipart: {
      view: 'custom',
      consent: JSON.stringify({
        depictsRealPerson: true,
        subject: 'Mira Okafor',
        grantedBy: 'Mira Okafor',
        grantedAt: '2026-11-01',
        scope: 'every episode of the series',
      }),
      file: { name: 'mira.png', mimeType: 'image/png', buffer: PHOTO },
    },
  });
  expect(res.status(), await res.text()).toBe(201);
}

/**
 * Locks what the writer added and approves the gates up to the storyboard (`Api.readyForStoryboard`), leaving alone
 * what came from the library locked: its references, its lock and its voice stay as they arrived.
 */
async function readyKeepingLibrary(api: Api, pid: string): Promise<void> {
  await api.call('POST', `/projects/${pid}/workflow/approve`, { gate: 'screenplay_approved' });
  let docs = await docsOf(api, pid);
  for (const c of Object.values<any>(docs.characters)) {
    if (!c.lock.locked) {
      const j = await api.call<any>('POST', `/projects/${pid}/characters/${c.id}/references/generate`, {
        views: ['front'],
      });
      await api.waitJob(pid, j.id);
    }
    if (!c.voice?.lock?.locked) {
      const v = await api.call<any>('POST', `/projects/${pid}/characters/${c.id}/voice/design`, {});
      await api.waitJob(pid, v.id);
    }
  }
  for (const e of Object.values<any>(docs.elements)) {
    if (e.lock.locked) continue;
    const j = await api.call<any>('POST', `/projects/${pid}/elements/${e.id}/references/generate`, {});
    await api.waitJob(pid, j.id);
  }
  docs = await docsOf(api, pid);
  for (const c of Object.values<any>(docs.characters)) {
    if (!c.lock.locked) {
      for (const r of c.references)
        await api.call('PATCH', `/projects/${pid}/characters/${c.id}/references/${r.id}`, { approved: true });
      await api.call('POST', `/projects/${pid}/characters/${c.id}/lock`);
    }
    if (!c.voice?.lock?.locked) {
      await api.call('POST', `/projects/${pid}/characters/${c.id}/voice/select`, {
        candidateId: c.voice.candidates[0].id,
      });
      await api.call('POST', `/projects/${pid}/characters/${c.id}/voice/lock`);
    }
  }
  for (const e of Object.values<any>(docs.elements)) {
    if (e.lock.locked) continue;
    for (const r of e.references)
      await api.call('PATCH', `/projects/${pid}/elements/${e.id}/references/${r.id}`, { approved: true });
    await api.call('POST', `/projects/${pid}/elements/${e.id}/lock`);
  }
  await api.call('POST', `/projects/${pid}/workflow/approve`, { gate: 'cast_locked' });
  await api.call('POST', `/projects/${pid}/workflow/approve`, { gate: 'resources_ready' });
}

/**
 * A 3D unit file as the 3D-Editor writes it (docs/design/library.md#the-three-hashes): `3DUNIT` CR LF, container
 * version 1, codec 0, two zero bytes, the JSON header's length at byte 12 (little-endian), the header at 16 (its
 * format, version, kind and a name of 1–120 characters), then the body.
 */
function unitFile(kind: 'set' | 'prop', body: string): Buffer {
  const header = Buffer.from(
    JSON.stringify({ format: '3d-editor.desk-unit', version: 1, kind, name: body.slice(0, 120) }),
  );
  const text = Buffer.from(body);
  const out = Buffer.alloc(16 + header.length + text.length);
  out.write('3DUNIT\r\n', 0, 'latin1');
  out[8] = 1;
  out.writeUInt32LE(header.length, 12);
  header.copy(out, 16);
  text.copy(out, 16 + header.length);
  return out;
}

/**
 * A 3D unit uploaded to the library (`POST /api/library/items`), or a new version of one
 * (`POST /api/library/items/:id/versions` with `basedOn`), as the desk's Library tab would.
 */
async function uploadUnit(
  request: APIRequestContext,
  kind: 'set' | 'prop',
  item: { name: string; tag: string } | { id: string; basedOn: number },
): Promise<{ id: string; version: number }> {
  const next = 'id' in item;
  const data = unitFile(kind, next ? `${item.id} v${item.basedOn + 1}` : `${item.name} v1`);
  const meta = {
    kind: `desk-${kind}`,
    ...(next
      ? { basedOn: item.basedOn, note: `v${item.basedOn + 1} of the e2e unit` }
      : { name: item.name, tags: [item.tag], description: 'A unit of the library e2e' }),
    unit: {
      format: '3d-editor.desk-unit',
      formatVersion: 1,
      meta: {
        dimensionsM: [12, 4, 8],
        objects: 5,
        triangles: 900,
        actor: null,
        credits: [],
        deskVersion: '0.0.0-e2e',
        digest: createHash('sha256').update(data).digest('hex'),
      },
    },
  };
  const res = await request.post(next ? `/api/library/items/${item.id}/versions` : '/api/library/items', {
    multipart: {
      meta: JSON.stringify(meta),
      payload: { name: 'unit.bin', mimeType: 'application/octet-stream', buffer: data },
    },
  });
  expect(res.status(), await res.text()).toBe(201);
  const out = (await res.json()) as { item: { id: string }; version: { version: number } };
  return { id: out.item.id, version: out.version.version };
}

test('Mira saved in episode 1 is used in episode 2 with her id and seed, kept by the writer, linked elsewhere and updated to v2 past an approved clip', async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(480_000);
  const api = new Api(request);
  const tag = runTag(testInfo);
  const viewport = testInfo.project.name;

  // Episode 1: Mira, locked, with a photo of the actor who plays her (a real person, with consent)
  const ep1 = await api.storyProject(`Library ep1 (${viewport})`, {
    screenplay: true,
    settings: { storyboard: { enabled: false } },
  });
  const mira = Object.values<any>((await docsOf(api, ep1)).characters).find((c) => c.name === 'Mira');
  expect(mira, 'the writer casts Mira').toBeTruthy();
  await uploadPhoto(request, ep1, mira.id);
  await api.readyForStoryboard(ep1);

  // Save to library: a real person needs the consent box before Save
  await page.goto(`/p/${ep1}/cast`);
  const card1 = page.locator(`[data-entity="character:${mira.id}"]`);
  await card1.getByTestId('save-to-library').click();
  await expect(page.getByTestId('save-to-library-dialog')).toBeVisible();
  await page.getByTestId('save-description').fill('The keeper, as episode 1 has her');
  await page.getByTestId('save-tags').fill(`${tag}, keepers`);
  await expect(page.getByTestId('save-consent')).toBeVisible();
  await expect(page.getByTestId('save-to-library-submit')).toBeDisabled();
  await page.getByTestId('save-consent-check').check();
  await page.getByTestId('save-to-library-submit').click();
  await expect(toast(page, 'Saved Mira v1 to the library')).toBeVisible();
  await expect(card1.getByTestId('library-row-text')).toHaveText('Library: Mira v1');
  const itemId: string = (await docsOf(api, ep1)).characters[mira.id].library.itemId;
  expect(await api.call<any>('GET', `/library/items/${itemId}`)).toMatchObject({
    kind: 'character',
    name: 'Mira',
    current: 1,
    realPerson: true,
    tags: expect.arrayContaining([tag, 'keepers']),
  });
  await noSidewaysScroll(page);

  // Episode 2, before its screenplay: Use from library brings her in with her id and seed, locked
  const ep2 = await api.storyProject(`Library ep2 (${viewport})`, {
    settings: { storyboard: { enabled: false } },
  });
  await page.goto(`/p/${ep2}/cast`);
  await page.getByTestId('use-from-library').click();
  const picker = page.getByTestId('use-picker');
  await page.getByTestId('use-search').fill(tag);
  const pick = picker.getByTestId('use-item');
  await expect(pick).toHaveCount(1);
  await expect(pick).toContainText('Mira');
  await expect(pick).toContainText('real person');
  await pick.getByTestId('use-item-check').check();
  await expect(page.getByTestId('use-submit')).toBeDisabled();
  await page.getByTestId('use-consent-check').check();
  await page.getByTestId('use-submit').click();
  await expect(picker.getByTestId('use-result')).toHaveText(
    'Mira: Mira is in the project (v1, the same id and seed)',
  );
  await page.getByTestId('use-close').click();
  const card2 = page.locator(`[data-entity="character:${mira.id}"]`);
  await expect(card2.getByTestId('library-row-text')).toHaveText('Library: Mira v1');
  let ep2Mira = (await docsOf(api, ep2)).characters[mira.id];
  expect(ep2Mira).toMatchObject({
    id: mira.id,
    seed: mira.seed,
    library: { itemId, version: 1, mode: 'used' },
    lock: { locked: true },
  });

  // Writer awareness: Write screenplay keeps her, and the scenes cast her by the same id
  await page.goto(`/p/${ep2}/story`);
  await page.getByTestId('generate-screenplay').click();
  await expect(page.getByTestId('scenes')).toBeVisible({ timeout: 90_000 });
  await api.waitIdle(ep2);
  const written = await docsOf(api, ep2);
  const miras = Object.values<any>(written.characters).filter((c) => /^mira\b/i.test(c.name));
  expect(miras.map((c) => c.id)).toEqual([mira.id]);
  expect(written.screenplay.scenes[0].characterIds).toContain(mira.id);
  expect(written.characters[mira.id]).toMatchObject({
    seed: mira.seed,
    library: ep2Mira.library,
    lock: ep2Mira.lock,
    identity: ep2Mira.identity,
    references: ep2Mira.references,
  });

  // A project with a Mira of its own: Use from library offers to link to her instead
  const ep3 = await api.storyProject(`Library ep3 (${viewport})`, { screenplay: true });
  const own = Object.values<any>((await docsOf(api, ep3)).characters).find((c) => c.name === 'Mira');
  expect(own.id).not.toBe(mira.id);
  await page.goto(`/p/${ep3}/cast`);
  await page.getByTestId('use-from-library').click();
  await page.getByTestId('use-search').fill(tag);
  // other runs keep their Miras in the shared library: wait for the search to leave this run's one
  await expect(picker.getByTestId('use-item')).toHaveCount(1);
  await picker.getByTestId('use-item-check').check();
  // what is checked stays checked under another search, named while the list hides it
  await page.getByTestId('use-search').fill(`${tag} no-such-word`);
  await expect(picker.getByTestId('use-item')).toHaveCount(0);
  await expect(page.getByTestId('use-checked-elsewhere')).toHaveText('Also checked: Mira');
  await page.getByTestId('use-search').fill(tag);
  await expect(picker.getByTestId('use-item-check')).toBeChecked();
  await expect(page.getByTestId('use-checked-elsewhere')).toHaveCount(0);
  await page.getByTestId('use-consent-check').check();
  await page.getByTestId('use-submit').click();
  await expect(page.getByTestId('use-result')).toContainText(
    'a character named Mira is already in this project',
  );
  await page.getByTestId('use-link-existing').click();
  await expect(page.getByTestId('library-plan')).toBeVisible();
  // Escape closes the plan only: the picker stays open with its result, and offers the link again
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('library-plan')).toHaveCount(0);
  await expect(picker.getByTestId('use-result')).toContainText(
    'a character named Mira is already in this project',
  );
  await page.getByTestId('use-link-existing').click();
  await expect(page.getByTestId('library-plan')).toBeVisible();
  await expect(page.getByRole('dialog').filter({ hasText: 'Link Mira to the library (v1)' })).toBeVisible();
  await expect(page.getByTestId('plan-lock')).toHaveText('Identity: lock version 0 → 1');
  await expect(page.getByTestId('plan-confirm')).toHaveText('Link');
  await expect(page.getByTestId('plan-confirm')).toBeDisabled();
  await page.getByTestId('plan-consent-check').check();
  await page.getByTestId('plan-confirm').click();
  await expect(toast(page, 'Linked Mira to the library (v1)')).toBeVisible();
  const card3 = page.locator(`[data-entity="character:${own.id}"]`);
  await expect(card3.getByTestId('library-row-text')).toHaveText('Library: Mira v1');
  expect((await docsOf(api, ep3)).characters[own.id]).toMatchObject({
    id: own.id,
    seed: mira.seed,
    library: { itemId, version: 1, mode: 'linked' },
    lock: { locked: true, version: 1 },
  });

  // Episode 2 shoots: a clip of the first scene, with Mira in it, approved
  await readyKeepingLibrary(api, ep2);
  const scene = (await docsOf(api, ep2)).screenplay.scenes[0];
  const job = await api.call<any>('POST', `/projects/${ep2}/clips/plan`, {
    sceneId: scene.id,
    generate: true,
  });
  await api.waitJob(ep2, job.id);
  await api.waitIdle(ep2, 180_000);
  const clip = Object.values<any>((await docsOf(api, ep2)).clips)[0];
  await api.call('POST', `/projects/${ep2}/clips/${clip.id}/approve`);

  // Episode 1 changes her look and saves v2 (a new version of the item she is linked to)
  await api.call('POST', `/projects/${ep1}/characters/${mira.id}/unlock`);
  await api.call('PATCH', `/projects/${ep1}/characters/${mira.id}`, {
    identity: { hair: 'silver straight bob with a blunt fringe' },
  });
  await api.call('POST', `/projects/${ep1}/characters/${mira.id}/lock`);
  await page.goto(`/p/${ep1}/cast`);
  await expect(card1.getByTestId('library-row-text')).toHaveText('Library: Mira v1 · edited here since v1');
  await card1.getByTestId('save-to-library').click();
  await expect(page.getByTestId('save-as-version')).toBeChecked();
  await page.getByTestId('save-note').fill('Silver hair from episode 1 on');
  await page.getByTestId('save-consent-check').check();
  await page.getByTestId('save-to-library-submit').click();
  await expect(toast(page, 'Saved Mira v2 to the library')).toBeVisible();
  await expect(card1.getByTestId('library-row-text')).toHaveText('Library: Mira v2');

  // Episode 2: v2 available; Update… plans it first: the identity changes, the lock moves, the approved clip's takes
  // go stale (a director's update, and this studio's user is one); the consent again
  ep2Mira = (await docsOf(api, ep2)).characters[mira.id];
  await page.goto(`/p/${ep2}/cast`);
  await expect(card2.getByTestId('library-row-text')).toHaveText('Library: Mira v1 · v2 available');
  await card2.getByTestId('library-update').click();
  await expect(
    page.getByRole('dialog').filter({ hasText: 'Update Mira from the library (v1 → v2)' }),
  ).toBeVisible();
  await expect(page.getByTestId('plan-changes')).toHaveText('Changes: identity');
  await expect(page.getByTestId('plan-lock')).toContainText(
    `Identity: lock version ${ep2Mira.lock.version} → `,
  );
  await expect(page.getByTestId('plan-stale')).toContainText('will need generating again');
  const approved = page.getByTestId('plan-approved');
  await expect(approved).toContainText('1 approved clip would hold stale takes: clip 1');
  await expect(approved).toContainText('Updating needs a director: you are one');
  await expect(page.getByTestId('plan-confirm')).toHaveText('Update');
  await expect(page.getByTestId('plan-confirm')).toBeDisabled();
  await page.getByTestId('plan-consent-check').check();
  await page.getByTestId('plan-confirm').click();
  await expect(toast(page, 'Updated Mira from the library (v1 → v2)')).toBeVisible();
  await expect(card2.getByTestId('library-row-text')).toHaveText('Library: Mira v2');
  const updated = (await docsOf(api, ep2)).characters[mira.id];
  expect(updated).toMatchObject({
    id: mira.id,
    seed: mira.seed,
    library: { itemId, version: 2, mode: 'updated' },
    lock: { locked: true },
    identity: { hair: 'silver straight bob with a blunt fringe' },
  });
  expect(updated.lock.version).toBeGreaterThan(ep2Mira.lock.version);
  // the clip stays approved with its takes until they are generated again
  expect((await docsOf(api, ep2)).clips[clip.id].status).toBe('approved');
  await noSidewaysScroll(page);

  // The Library page: where Mira is used, project by project
  await page.goto(`/library/${itemId}`);
  const detail = page.getByTestId('library-detail');
  await expect(detail.getByTestId('library-version')).toHaveCount(2);
  const uses = detail.getByTestId('library-use-project');
  await expect(uses).toHaveCount(3);
  await expect(uses.filter({ hasText: `Library ep2 (${viewport})` })).toContainText('Mira: v2');
  await expect(uses.filter({ hasText: `Library ep3 (${viewport})` })).toContainText('Mira: v1');
  await noSidewaysScroll(page);
});

test('3D rows pin, move, change and unlink sets uploaded through the API; the Library page lists, filters, tags and archives', async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(300_000);
  const api = new Api(request);
  const tag = runTag(testInfo);
  const mobile = testInfo.project.name === 'mobile';
  const harbor = await uploadUnit(request, 'set', { name: `Harbor ${tag}`, tag });
  const quay = await uploadUnit(request, 'set', { name: `Quay ${tag}`, tag });
  const lantern = await uploadUnit(request, 'prop', { name: `Lantern ${tag}`, tag });
  const title = `Library 3D (${testInfo.project.name} ${tag})`;
  const pid = await api.storyProject(title, { screenplay: true });
  const elements = Object.values<any>((await docsOf(api, pid)).elements);
  const place = elements.find((e) => e.kind === 'location');
  const thing = elements.find((e) => e.kind === 'prop');
  expect(place && thing, 'the writer adds a location and a prop').toBeTruthy();

  // Choose…: the picker offers this studio's sets only (not the prop), and pins the current version
  await page.goto(`/p/${pid}/elements`);
  const row = page.locator(`[data-entity="element:${place.id}"]`).getByTestId('desk-row');
  await expect(row).toHaveAttribute('data-kind', 'desk-set');
  await expect(row.getByTestId('desk-row-text')).toHaveText('3D set: none');
  await row.getByTestId('desk-choose').click();
  const picker = page.getByTestId('desk-picker');
  await page.getByTestId('desk-picker-search').fill(tag);
  await expect(picker.getByTestId('desk-picker-item')).toHaveCount(2);
  await expect(picker).not.toContainText('Lantern');
  await picker
    .getByTestId('desk-picker-item')
    .filter({ hasText: `Harbor ${tag}` })
    .getByTestId('desk-picker-use')
    .click();
  await expect(toast(page, `${place.name} uses the 3D set Harbor ${tag} v1`)).toBeVisible();
  await expect(row.getByTestId('desk-row-text')).toHaveText(`3D set: Harbor ${tag} v1`);
  expect((await docsOf(api, pid)).elements[place.id].deskUnit).toMatchObject({
    kind: 'desk-set',
    itemId: harbor.id,
    version: 1,
  });
  await noSidewaysScroll(page);

  // v2 published elsewhere: the row offers it
  await uploadUnit(request, 'set', { id: harbor.id, basedOn: 1 });
  await page.reload();
  await expect(row.getByTestId('desk-row-text')).toHaveText(`3D set: Harbor ${tag} v1 · v2 available`);
  await row.getByTestId('desk-use-version').click();
  await expect(row.getByTestId('desk-row-text')).toHaveText(`3D set: Harbor ${tag} v2`);

  // The Library page, from the header (a phone's under the project's More): search, kind chips, tag filter
  await uploadUnit(request, 'set', { id: harbor.id, basedOn: 2 });
  if (mobile) {
    await expect(page.getByTestId('library-link')).toBeHidden();
    await page.getByTestId('mnav-more').click();
    await page.getByTestId('mnav-library').click();
  } else {
    await expect(page.getByTestId('project-stage')).toBeVisible();
    await page.getByTestId('library-link').click();
  }
  await expect(page).toHaveURL(/\/library$/);
  const names = page.getByTestId('library-item-name');
  await page.getByTestId('library-search').fill(tag);
  await expect(names).toHaveText([`Harbor ${tag}`, `Lantern ${tag}`, `Quay ${tag}`]);
  await page.getByTestId('library-kind-sets').click();
  await expect(names).toHaveText([`Harbor ${tag}`, `Quay ${tag}`]);
  await page.getByTestId('library-kind-props').click();
  await expect(names).toHaveText([`Lantern ${tag}`]);
  await page.getByTestId('library-kind-all').click();
  await page.getByTestId('library-tag').selectOption(tag);
  await page.getByTestId('library-search').fill('');
  await expect(names).toHaveText([`Harbor ${tag}`, `Lantern ${tag}`, `Quay ${tag}`]);
  await noSidewaysScroll(page);

  // Harbor: its versions, where it is used, its tags; Use v3 for the one project
  await page
    .getByTestId('library-item')
    .filter({ hasText: `Harbor ${tag}` })
    .click();
  await expect(page).toHaveURL(new RegExp(`/library/${harbor.id}$`));
  const detail = page.getByTestId('library-detail');
  await expect(detail.getByTestId('library-version')).toHaveCount(3);
  await expect(detail.getByTestId('library-facts')).toContainText('12 × 4 × 8 m');
  if (mobile) {
    // a phone shows the item on its own, its actions in a bar at the bottom
    await expect(page.getByTestId('library-list')).toBeHidden();
    await expect(page.getByTestId('library-actions')).toBeInViewport();
  } else {
    // a wide screen keeps the list beside it, filters and all
    await expect(page.getByTestId('library-search')).toHaveValue('');
    await expect(page.getByTestId('library-tag')).toHaveValue(tag);
    await expect(names).toHaveCount(3);
  }
  const use = detail.getByTestId('library-use-project').filter({ hasText: title });
  await expect(use).toContainText(`${place.name}: pins v2`);
  await use.getByTestId('library-use-version').click();
  await expect(detail.getByTestId('library-use-result')).toHaveText(`${title} · ${place.name}: now uses v3`);
  await expect(use).toContainText(`${place.name}: pins v3`);
  await page.getByTestId('library-tag-input').fill('harbour town');
  await page.getByTestId('library-tag-input').press('Enter');
  await expect(detail.getByTestId('library-item-tag')).toHaveText([tag, 'harbour town']);
  // v4 elsewhere: Use v4 in every project that pins another version
  await uploadUnit(request, 'set', { id: harbor.id, basedOn: 3 });
  await page.reload();
  await expect(use).toContainText(`${place.name}: pins v3`);
  await page.getByTestId('library-use-everywhere').click();
  await expect(detail.getByTestId('library-use-result')).toHaveText(`${title} · ${place.name}: now uses v4`);
  await expect(use).toContainText(`${place.name}: pins v4`);
  await expect(page.getByTestId('library-use-everywhere')).toHaveCount(0);
  await noSidewaysScroll(page);

  // Archive the prop: gone from the list and the pickers, back under Show archived
  if (mobile) await page.getByTestId('library-back').click();
  await page.getByTestId('library-search').fill(tag);
  await page
    .getByTestId('library-item')
    .filter({ hasText: `Lantern ${tag}` })
    .click();
  await expect(page).toHaveURL(new RegExp(`/library/${lantern.id}$`));
  await page.getByTestId('library-archive').click();
  await expect(page.getByTestId('library-archived')).toBeVisible();
  await expect(page.getByTestId('library-unarchive')).toBeVisible();
  if (mobile) await page.getByTestId('library-back').click();
  await page.getByTestId('library-search').fill(tag);
  await expect(names).toHaveText([`Harbor ${tag}`, `Quay ${tag}`]);
  await page.getByTestId('library-show-archived').check();
  await expect(names).toHaveText([`Harbor ${tag}`, `Lantern ${tag}`, `Quay ${tag}`]);
  await expect(page.getByTestId('library-item').filter({ hasText: `Lantern ${tag}` })).toContainText(
    'archived',
  );

  // Back in the project: Change to Quay, then Unlink; the prop's picker no longer offers the archived Lantern
  await page.goto(`/p/${pid}/elements`);
  await expect(row.getByTestId('desk-row-text')).toHaveText(`3D set: Harbor ${tag} v4`);
  await row.getByTestId('desk-change').click();
  await page.getByTestId('desk-picker-search').fill(tag);
  const pinned = picker.getByTestId('desk-picker-item').filter({ hasText: `Harbor ${tag}` });
  await expect(pinned).toContainText('pinned');
  await picker
    .getByTestId('desk-picker-item')
    .filter({ hasText: `Quay ${tag}` })
    .getByTestId('desk-picker-use')
    .click();
  await expect(row.getByTestId('desk-row-text')).toHaveText(`3D set: Quay ${tag} v1`);
  expect((await docsOf(api, pid)).elements[place.id].deskUnit).toMatchObject({ itemId: quay.id, version: 1 });
  await row.getByTestId('desk-unlink').click();
  await expect(toast(page, `${place.name} no longer uses Quay ${tag}`)).toBeVisible();
  await expect(row.getByTestId('desk-row-text')).toHaveText('3D set: none');
  expect((await docsOf(api, pid)).elements[place.id].deskUnit ?? null).toBeNull();
  const propRow = page.locator(`[data-entity="element:${thing.id}"]`).getByTestId('desk-row');
  await expect(propRow).toHaveAttribute('data-kind', 'desk-prop');
  await propRow.getByTestId('desk-choose').click();
  await page.getByTestId('desk-picker-search').fill(tag);
  await expect(picker).toContainText('No 3D props in the library');
  await expect(picker.getByTestId('desk-picker-item')).toHaveCount(0);
  await noSidewaysScroll(page);
});

test('on phones the Cast, Elements and Resources cards keep their names whole beside their badges and Save to library', async ({
  browser,
  request,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile', 'phone widths');
  const api = new Api(request);
  const pid = await api.storyProject(`Library phones (${runTag(testInfo)})`, { screenplay: true });
  // A long name beside every badge a character card has: its role, locked and a real person
  const long = await api.call<any>('POST', `/projects/${pid}/characters`, {
    name: 'Seraphina Okonkwo-Delacroix',
  });
  await uploadPhoto(request, pid, long.id);
  for (const r of (await docsOf(api, pid)).characters[long.id].references)
    await api.call('PATCH', `/projects/${pid}/characters/${long.id}/references/${r.id}`, { approved: true });
  await api.call('POST', `/projects/${pid}/characters/${long.id}/lock`);
  // The writer's places and props in use, one of them locked (Unlock), and a prop nothing uses yet (Remove too)
  const place = Object.values<any>((await docsOf(api, pid)).elements).find((e) => e.kind === 'location');
  const ref = await request.post(`/api/projects/${pid}/elements/${place.id}/references`, {
    multipart: { view: 'establishing', file: { name: 'place.png', mimeType: 'image/png', buffer: PHOTO } },
  });
  expect(ref.status(), await ref.text()).toBe(201);
  for (const r of (await docsOf(api, pid)).elements[place.id].references)
    await api.call('PATCH', `/projects/${pid}/elements/${place.id}/references/${r.id}`, { approved: true });
  await api.call('POST', `/projects/${pid}/elements/${place.id}/lock`);
  await api.call('POST', `/projects/${pid}/elements`, {
    kind: 'prop',
    name: "harbour master's storm lantern",
    description: 'a brass storm lantern with a cracked green glass',
  });
  const still = await request.post(`/api/projects/${pid}/uploads`, {
    multipart: { file: { name: 'harbour wall at dawn.png', mimeType: 'image/png', buffer: PHOTO } },
  });
  expect(still.status(), await still.text()).toBe(201);
  await api.waitIdle(pid);

  for (const [width, height] of [
    [360, 740],
    [390, 844],
    [412, 915],
  ] as const) {
    const phone = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
    const page = await phone.newPage();
    for (const view of ['cast', 'elements', 'resources'] as const) {
      await page.goto(`/p/${pid}/${view}`);
      await expect(page.getByTestId('save-to-library').first()).toBeVisible();
      await namesWhole(
        view === 'cast'
          ? page.getByTestId('character-name')
          : view === 'elements'
            ? page.getByTestId('element-name')
            : page.getByTitle('harbour wall at dawn.png', { exact: true }),
      );
      await noSidewaysScroll(page);
      // kept beside the run's other output, to look at (device pixel ratio 1, as the phone is)
      const shot = testInfo.outputPath(`${view}-${width}x${height}.png`);
      await page.screenshot({ path: shot, fullPage: true });
      await testInfo.attach(`${view}-${width}x${height}`, { path: shot, contentType: 'image/png' });
    }
    await phone.close();
  }
});
