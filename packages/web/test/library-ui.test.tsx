import {
  type AuthMe,
  type Character,
  characterSnapshot,
  type Element,
  elementSnapshot,
  type LibraryApplyPlan,
  type LibraryItem,
  type LibraryLinkStatus,
  type LibraryUses,
  type ProjectDocs,
  type Resource,
} from '@rideo/shared';
import * as f from '@rideo/shared/testing';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { libraryApi, listQuery } from '../src/features/library/api';
import { LibraryPage } from '../src/features/library/LibraryPage';
import { LibraryProvider } from '../src/features/library/LibraryProvider';
import { LibraryRows, SaveToLibraryButton, UseFromLibraryButton } from '../src/features/library/rows';
import {
  appliedText,
  applyRefusalText,
  conflictOf,
  consentSubjectsOf,
  deskMoves,
  deskRowText,
  latestOf,
  libraryErrorText,
  libraryRowText,
  moveEverywhere,
  moveEverywhereLabel,
  needsDirectorTitle,
  offeredVersion,
  parseTags,
  planAllowed,
  planLines,
  planTitle,
  usageText,
  usedText,
} from '../src/features/library/words';
import { ApiError } from '../src/lib/api';
import { useAuth } from '../src/lib/auth';
import { useUi } from '../src/store/ui';

/**
 * The studio library's UI (docs/design/library.md#the-ui): what it says (rows, plans, refusals), what it sends (save,
 * apply, the If-Match of a manager's change) and what it lets whom do, on a fetch that answers like the studio.
 */

vi.mock('../src/features/workspace/AppHeader', () => ({ AppHeader: () => null }));

const at = '2026-11-01T00:00:00.000Z';
const author = { kind: 'user' as const, id: 'usr_0000000000anna', name: 'Anna' };
const hex = (n: number) => n.toString(16).padStart(64, '0');
const PID = 'prj_0000000000ep02';
const MIRA_ITEM = 'lib_0000000000mira';
const HARBOR_ITEM = 'lib_00000000harbor';
/** An approved clip whose selected take an apply would make stale (the third clip). */
const HARBOR_CLIP = { id: 'clp_0000000000hrbr', index: 2, title: 'Harbor at dawn' };
const EDDY = 'usr_00000000000eddy';

/** Signs in Eddy, an editor of the project (not a director), and gives the project's access that says so. */
function asEditor(docs: ProjectDocs): ProjectDocs {
  useAuth.setState({
    me: { mode: 'oidc', user: { id: EDDY, name: 'Eddy' }, admin: false, token: null } as unknown as AuthMe,
  });
  return {
    ...docs,
    project: {
      ...docs.project,
      access: { visibility: 'private', members: [{ userId: EDDY, role: 'editor' }], invites: [] },
    },
  };
}

/** The studio's refusal of an apply that needs a director, to an editor (`accounts.authorize`). */
const NEEDS_APPROVE = {
  type: 'about:blank',
  title: 'Forbidden',
  status: 403,
  detail: 'Your role in this project (editor) cannot do that (project.approve)',
  code: 'forbidden',
};

function head(over: Partial<LibraryItem> = {}): LibraryItem {
  const latest = over.latest ?? over.current ?? 1;
  return {
    id: MIRA_ITEM,
    kind: 'character',
    name: 'Mira',
    description: '',
    tags: [],
    entityId: null,
    current: latest,
    latest,
    history: Array.from({ length: latest }, (_, i) => ({
      version: i + 1,
      digest: hex(i + 1),
      basedOn: i ? i : null,
      note: i ? `v${i + 1} note` : '',
      realPerson: false,
      bytes: 10,
      createdBy: author,
      createdAt: at,
    })),
    thumbnail: null,
    unit: null,
    realPerson: false,
    archived: false,
    ownerId: author.id,
    createdBy: author,
    createdAt: at,
    updatedBy: author,
    updatedAt: at,
    rev: 5,
    ...over,
  };
}

const summary = (item: LibraryItem) => {
  const { history, ...rest } = item;
  return { ...rest, versions: history.length };
};

function plan(over: Partial<LibraryApplyPlan> = {}): LibraryApplyPlan {
  return {
    mode: 'update',
    item: { id: MIRA_ITEM, kind: 'character', name: 'Mira', version: 3, digest: hex(3), current: 3 },
    entity: { kind: 'character', id: 'chr_0000000000mira', name: 'Mira', exists: true },
    keepsLibraryId: false,
    changes: ['identity'],
    lock: { locked: true, from: 1, to: 2 },
    voiceLock: null,
    staleTakes: 0,
    approvedClips: [],
    localChanges: false,
    realPerson: false,
    files: { count: 2, bytes: 2000, toCopy: 0, bytesToCopy: 0 },
    warnings: [],
    needs: 'project.edit',
    ...over,
  };
}

function link(over: Partial<LibraryLinkStatus> = {}): LibraryLinkStatus {
  return {
    entity: { kind: 'character', id: 'chr_0000000000mira', name: 'Mira' },
    via: 'library',
    itemId: MIRA_ITEM,
    version: 2,
    item: { name: 'Mira', kind: 'character', current: 3, archived: false },
    state: 'behind',
    modified: false,
    ...over,
  };
}

const apiError = (status: number, code: string, errors?: unknown[], detail = '') =>
  new ApiError(status, { type: 'about:blank', title: code, status, detail, code, errors });

// ---------------------------------------------------------------- the fetch the studio would answer

interface Sent {
  method: string;
  path: string;
  body: any;
  headers: Record<string, string>;
}
type Answer = [number, unknown?];
/** A route: its method, path and answer, and how many milliseconds the answer takes (none by default). */
type Served = [method: string, path: RegExp, answer: (sent: Sent) => Answer, delayMs?: number];

let sent: Sent[] = [];
function serve(routes: Served[]) {
  sent = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost');
      const s: Sent = {
        method: init?.method ?? 'GET',
        path: url.pathname + url.search,
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
        headers: { ...((init?.headers ?? {}) as Record<string, string>) },
      };
      sent.push(s);
      const route = routes.find(([m, p]) => m === s.method && p.test(s.path));
      if (route?.[3]) await new Promise((r) => setTimeout(r, route[3]));
      const [status, body] = route
        ? route[2](s)
        : [404, { type: 'about:blank', title: 'Not found', status: 404, detail: s.path, code: 'not_found' }];
      return new Response(body === undefined ? '' : JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
}
const calls = (method: string, path: RegExp) => sent.filter((s) => s.method === method && path.test(s.path));

const toasts = () => useUi.getState().toasts.map((t) => t.message);

beforeEach(() => {
  useUi.setState({ toasts: [] });
  useAuth.setState({ me: null, loaded: true });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------- what it says

describe('the rows and the plan in words', () => {
  it('says where a linked entity stands against its item', () => {
    expect(libraryRowText(2, undefined)).toBe('Library: v2');
    expect(libraryRowText(2, link())).toBe('Library: Mira v2 · v3 available');
    expect(libraryRowText(2, link({ modified: true }))).toBe(
      'Library: Mira v2 · v3 available · edited here since v2',
    );
    expect(libraryRowText(3, link({ version: 3, state: 'current' }))).toBe('Library: Mira v3');
    expect(libraryRowText(4, link({ version: 4, state: 'ahead' }))).toBe(
      "Library: Mira v4 · the library's current version is v3",
    );
    // a resource whose offered version another resource of the project already holds
    expect(libraryRowText(2, link(), 'Mira B')).toBe('Library: Mira v2 · v3 is in this project: Mira B');
    expect(libraryRowText(4, link({ version: 4, state: 'ahead' }), 'Mira B')).toBe(
      "Library: Mira v4 · the library's current version is v3 · v3 is in this project: Mira B",
    );
    expect(libraryRowText(2, link({ state: 'missing', item: null }))).toBe(
      "Library: v2 (not in this studio's library)",
    );
    expect(
      libraryRowText(3, link({ state: 'current', item: { ...link().item!, archived: true } })),
    ).toContain('archived');
  });

  it('says what a 3D row pins, and offers the item’s current version when another is pinned', () => {
    const pin = { name: 'Mira look', version: 1 };
    const figure = link({
      via: 'deskUnit',
      version: 1,
      item: { name: 'Mira look', kind: 'desk-figure', current: 2, archived: false },
    });
    expect(deskRowText('desk-figure', pin, figure)).toBe('3D figure: Mira look v1 · v2 available');
    expect(deskRowText('desk-set', null, undefined)).toBe('3D set: none');
    expect(deskRowText('desk-prop', pin, link({ via: 'deskUnit', state: 'missing', item: null }))).toBe(
      "3D prop: Mira look v1 (not in this studio's library)",
    );
    expect(offeredVersion(figure)).toBe(2);
    expect(offeredVersion(link({ state: 'ahead', version: 4 }))).toBe(3);
    expect(offeredVersion(link({ state: 'current', version: 3 }))).toBeNull();
    expect(offeredVersion(link({ state: 'missing', item: null }))).toBeNull();
    expect(offeredVersion(undefined)).toBeNull();
  });

  it('plans an update line by line: changes, locks, stale takes, approved clips, local edits, files, warnings', () => {
    const p = plan({
      changes: ['identity', 'aliases', 'deskUnit'],
      voiceLock: { locked: true, from: 1, to: 1 },
      staleTakes: 3,
      approvedClips: [{ id: 'clp_0000000000aaaa', index: 0, title: 'The first letter' }],
      localChanges: true,
      files: { count: 2, bytes: 4096, toCopy: 1, bytesToCopy: 2048 },
      warnings: ['the voice was cloned'],
      needs: 'project.approve',
    });
    expect(planTitle(p, 2)).toBe('Update Mira from the library (v2 → v3)');
    const lines = planLines(p, { fromVersion: 2, canApprove: true });
    expect(lines.map((l) => l.id)).toEqual([
      'changes',
      'lock',
      'voice',
      'stale',
      'approved',
      'local',
      'files',
      'warning-0',
    ]);
    const text = Object.fromEntries(lines.map((l) => [l.id, l.text]));
    expect(text.changes).toBe('Changes: identity, other names, 3D unit');
    expect(text.lock).toBe('Identity: lock version 1 → 2');
    expect(text.voice).toBe('Voice stays locked at version 1');
    expect(text.stale).toBe('3 takes will need generating again');
    expect(text.approved).toBe(
      '1 approved clip would hold stale takes: clip 1 (The first letter). Updating needs a director: you are one, and the clips stay approved with their takes until generated again.',
    );
    expect(text.local).toBe('Edits made here since v2 are replaced');
    expect(text.files).toBe('Copies 1 file (2 KB) into the project');
    // an editor is told to ask a director, and may not confirm
    const editor = planLines(p, { fromVersion: 2, canApprove: false });
    expect(editor.find((l) => l.id === 'approved')).toMatchObject({
      tone: 'danger',
      text: expect.stringContaining('Updating needs a director: ask one to do it.'),
    });
    expect(planAllowed(p, false)).toBe(false);
    expect(planAllowed(p, true)).toBe(true);
    expect(planAllowed(plan(), false)).toBe(true);
    expect(planLines(plan({ changes: [] }), { canApprove: true })[0]!.text).toBe(
      'Nothing changes: Mira is already v3',
    );
    expect(planLines(plan({ lock: { locked: false, from: 0, to: 0 } }), { canApprove: true })[1]!.text).toBe(
      'Identity is not locked',
    );
  });

  it('says which apply needs a director: using it here, updating or linking', () => {
    const approved = (mode: LibraryApplyPlan['mode']) =>
      plan({ mode, approvedClips: [HARBOR_CLIP], staleTakes: 1, needs: 'project.approve' });
    const line = (mode: LibraryApplyPlan['mode'], canApprove: boolean) =>
      planLines(approved(mode), { canApprove }).find((l) => l.id === 'approved')!.text;
    const clips = '1 approved clip would hold stale takes: clip 3 (Harbor at dawn).';
    expect(line('create', false)).toBe(
      `${clips} Using it in this project needs a director: ask one to do it.`,
    );
    expect(line('update', false)).toBe(`${clips} Updating needs a director: ask one to do it.`);
    expect(line('link', false)).toBe(`${clips} Linking needs a director: ask one to do it.`);
    expect(line('link', true)).toBe(
      `${clips} Linking needs a director: you are one, and the clips stay approved with their takes until generated again.`,
    );
    // more than five clips: the first five, and how many more
    const many = Array.from({ length: 7 }, (_, i) => ({ id: `clp_00000000000${i}aa`, index: i, title: '' }));
    expect(
      planLines(plan({ approvedClips: many }), { canApprove: false }).find((l) => l.id === 'approved')!.text,
    ).toBe(
      '7 approved clips would hold stale takes: clip 1, clip 2, clip 3, clip 4, clip 5 and 2 more. Updating needs a director: ask one to do it.',
    );
    // the confirm button says who may do it, in the plan's own verb
    expect(needsDirectorTitle(approved('link'))).toBe('Approved clips are affected: a director links');
    expect(needsDirectorTitle(approved('update'))).toBe('Approved clips are affected: a director updates');
  });

  it('turns a refusal that needs a director into the plan’s approved clips, asking the plan only then', async () => {
    const forbidden = apiError(
      403,
      'forbidden',
      undefined,
      'Your role in this project (editor) cannot do that (project.approve)',
    );
    const director = plan({ mode: 'create', approvedClips: [HARBOR_CLIP], needs: 'project.approve' });
    const answer = (p: LibraryApplyPlan) => async () => ({
      plan: p,
      applied: false,
      entity: { kind: p.entity.kind, id: p.entity.id },
      commit: null,
    });
    expect(await applyRefusalText(forbidden, answer(director))).toBe(
      '1 approved clip would hold stale takes: clip 3 (Harbor at dawn). Using it in this project needs a director: ask one to do it.',
    );
    // refused for another reason: the plan needs no director, or cannot be had; the refusal's own words
    expect(await applyRefusalText(forbidden, answer(plan()))).toBe(
      'You may not do this: Your role in this project (editor) cannot do that (project.approve).',
    );
    const unasked = vi.fn(answer(director));
    expect(
      await applyRefusalText(forbidden, () => Promise.reject(apiError(403, 'forbidden', undefined, 'no'))),
    ).toBe('You may not do this: Your role in this project (editor) cannot do that (project.approve).');
    // any other refusal is said as it is, without asking the plan
    const taken = apiError(409, 'conflict', [{ reason: 'name' }], 'a character named Mira is already here');
    expect(await applyRefusalText(taken, unasked)).toBe('a character named Mira is already here');
    expect(unasked).not.toHaveBeenCalled();
  });

  it('says which approved clips a director’s use left with stale takes', () => {
    const result = (approvedClips: LibraryApplyPlan['approvedClips'], applied = true) => ({
      plan: plan({ mode: 'create', keepsLibraryId: true, approvedClips, needs: 'project.approve' }),
      applied,
      entity: { kind: 'character' as const, id: 'chr_0000000000mira' },
      commit: null,
    });
    expect(usedText(result([HARBOR_CLIP]))).toBe(
      'Mira is in the project (v3, the same id and seed). 1 approved clip now holds stale takes: clip 3 (Harbor at dawn); it stays approved with its takes until generated again.',
    );
    expect(usedText(result([HARBOR_CLIP, { id: 'clp_0000000000five', index: 4, title: '' }]))).toBe(
      'Mira is in the project (v3, the same id and seed). 2 approved clips now hold stale takes: clip 3 (Harbor at dawn), clip 5; they stay approved with their takes until generated again.',
    );
    expect(usedText(result([]))).toBe('Mira is in the project (v3, the same id and seed)');
  });

  it('titles and reports each kind of apply', () => {
    expect(planTitle(plan({ mode: 'link' }), null)).toBe('Link Mira to the library (v3)');
    expect(
      planTitle(
        plan({
          mode: 'pin',
          item: { ...plan().item, kind: 'desk-set', name: 'Harbor' },
          entity: { kind: 'element', id: 'ele_000000harbor', name: 'Harbour', exists: true },
        }),
        null,
      ),
    ).toBe('Use the 3D set Harbor v3');
    const result = (p: LibraryApplyPlan, applied = true) => ({
      plan: p,
      applied,
      entity: { kind: p.entity.kind, id: p.entity.id },
      commit: null,
    });
    expect(appliedText(result(plan({ mode: 'create', keepsLibraryId: true })))).toBe(
      'Mira is in the project (v3, the same id and seed)',
    );
    expect(appliedText(result(plan()), 2)).toBe('Updated Mira from the library (v2 → v3)');
    expect(appliedText(result(plan({ mode: 'link' })))).toBe('Linked Mira to the library (v3)');
    expect(appliedText(result(plan(), false))).toBe('Mira is already v3');
    expect(
      appliedText(
        result(
          plan({
            mode: 'pin',
            item: { ...plan().item, kind: 'desk-figure', name: 'Mira look' },
          }),
          false,
        ),
      ),
    ).toBe('Mira already uses Mira look v3');
  });

  it('turns refusals into words by their stable codes', () => {
    const exists = apiError(
      409,
      'conflict',
      [{ reason: 'exists', entityId: 'chr_0000000000mira' }],
      'Mira is here',
    );
    expect(conflictOf(exists)).toEqual({ reason: 'exists', entityId: 'chr_0000000000mira' });
    expect(conflictOf(apiError(409, 'conflict', [{ reason: 'other' }]))).toBeNull();
    expect(conflictOf(new Error('x'))).toBeNull();
    expect(libraryErrorText(exists)).toBe('Mira is here');
    const stale = apiError(412, 'library_conflict', [{ latest: 4 }]);
    expect(latestOf(stale)).toBe(4);
    expect(libraryErrorText(stale)).toBe(
      'Someone saved v4 meanwhile: take it first, or save anyway as the next version.',
    );
    expect(libraryErrorText(apiError(412, 'library_conflict', [{ rev: 3 }]))).toBe(
      'Someone changed this item meanwhile: it was reloaded, try again.',
    );
    const consent = apiError(422, 'consent_required', [
      { what: 'reference', subject: 'Mira Okafor', scope: null },
    ]);
    expect(consentSubjectsOf(consent)).toEqual([{ what: 'reference', subject: 'Mira Okafor', scope: null }]);
    expect(libraryErrorText(consent)).toBe(
      'This shows a real person: confirm that the consent covers this use first.',
    );
    expect(
      libraryErrorText(
        apiError(409, 'conflict', [{ reason: 'archived', itemId: MIRA_ITEM }], 'Mira is archived'),
      ),
    ).toBe('Mira is archived (unarchive it on the Library page first).');
    expect(libraryErrorText(apiError(403, 'forbidden', [], 'editors only'))).toBe(
      'You may not do this: editors only.',
    );
    expect(libraryErrorText(new TypeError('Failed to fetch'))).toBe(
      'The studio cannot be reached: check the connection and try again.',
    );
  });

  it('reads tags as the library takes them', () => {
    expect(parseTags('Season 1, harbour town, , season 1, !!!')).toEqual({
      tags: ['season 1', 'harbour town'],
      invalid: ['!!!'],
    });
  });

  it('moves every pin at another version, one project after the other, skipping projects the person may not edit', async () => {
    const uses: LibraryUses = {
      incomplete: false,
      projects: [
        {
          projectId: 'prj_00000000000ep1',
          title: 'Episode 1',
          role: 'director',
          uses: [
            {
              itemId: HARBOR_ITEM,
              version: 1,
              via: 'deskUnit',
              entity: { kind: 'element', id: 'ele_000000harbor', name: 'Harbour' },
            },
            { itemId: HARBOR_ITEM, version: 1, via: 'deskState', clips: 2, approved: 1 },
          ],
        },
        {
          projectId: 'prj_00000000000ep2',
          title: 'Episode 2',
          role: 'editor',
          uses: [
            {
              itemId: HARBOR_ITEM,
              version: 3,
              via: 'deskUnit',
              entity: { kind: 'element', id: 'ele_00000000quay', name: 'Quay' },
            },
          ],
        },
        {
          projectId: 'prj_00000000000ep3',
          title: 'Episode 3',
          role: 'reviewer',
          uses: [
            {
              itemId: HARBOR_ITEM,
              version: 2,
              via: 'deskUnit',
              entity: { kind: 'element', id: 'ele_0000000pier', name: 'Pier' },
            },
          ],
        },
      ],
    };
    const moves = deskMoves(uses, 3);
    // Episode 2 already pins v3; the stored desk states are not pins
    expect(moves.map((m) => [m.title, m.targets.map((t) => t.name)])).toEqual([
      ['Episode 1', ['Harbour']],
      ['Episode 3', ['Pier']],
    ]);
    expect(moveEverywhereLabel(3, moves.length)).toBe('Use v3 in all 2 projects');
    expect(moveEverywhereLabel(3, 1)).toBe('Use v3 in 1 project');
    const order: string[] = [];
    const out = await moveEverywhere(moves, HARBOR_ITEM, 3, async (projectId, input) => {
      order.push(`${projectId}:${input.target.id}:v${input.version}`);
      return {
        plan: plan({ mode: 'pin' }),
        applied: true,
        entity: { kind: 'element', id: input.target.id },
        commit: null,
      };
    });
    expect(order).toEqual(['prj_00000000000ep1:ele_000000harbor:v3']);
    expect(out.map((r) => [r.outcome, r.text])).toEqual([
      ['applied', 'Episode 1 · Harbour: now uses v3'],
      ['skipped', 'Episode 3: skipped, you may not edit this project'],
    ]);
    const refused = await moveEverywhere(moves.slice(0, 1), HARBOR_ITEM, 3, async () => {
      throw apiError(409, 'element_locked', [], 'Harbour is locked');
    });
    expect(refused[0]).toMatchObject({
      outcome: 'refused',
      text: 'Episode 1 · Harbour: refused: Harbour is locked',
    });
    expect(usageText(uses.projects[0]!.uses[0]!)).toBe('Harbour: pins v1');
    expect(usageText(uses.projects[0]!.uses[1]!)).toBe('Stored desk states: 2 clips use v1 (1 approved)');
    expect(
      usageText({
        itemId: MIRA_ITEM,
        version: 2,
        via: 'library',
        entity: { kind: 'character', id: 'chr_0000000000mira', name: 'Mira' },
      }),
    ).toBe('Mira: v2');
  });
});

// ---------------------------------------------------------------- the REST client

describe('the library client', () => {
  it('asks lists by kind, tag and words, and sends a manager’s change with If-Match', async () => {
    expect(
      listQuery({ kinds: ['desk-set', 'desk-prop'], tag: 'season 1', q: '  harbour ', archived: true }),
    ).toBe('?kinds=desk-set%2Cdesk-prop&tag=season+1&q=harbour&archived=true');
    expect(listQuery({})).toBe('');
    serve([
      ['PATCH', /^\/api\/library\/items\/lib_0000000000mira$/, () => [200, head({ rev: 6, archived: true })]],
    ]);
    const next = await libraryApi.update(MIRA_ITEM, { archived: true }, 5);
    expect(next.archived).toBe(true);
    expect(sent[0]).toMatchObject({ method: 'PATCH', body: { archived: true } });
    expect(sent[0]!.headers['if-match']).toBe('"r5"');
  });

  it('throws the studio’s refusal with its code, and refuses an answer it cannot read', async () => {
    serve([
      [
        'GET',
        /^\/api\/projects\/prj_0000000000ep02\/library$/,
        () => [
          409,
          { type: 'about:blank', title: 'x', status: 409, detail: 'no', code: 'conflict', errors: [] },
        ],
      ],
      ['GET', /^\/api\/library\/items\/lib_0000000000mira$/, () => [200, { id: 'not a head' }]],
    ]);
    await expect(libraryApi.status(PID)).rejects.toMatchObject({ code: 'conflict', status: 409 });
    await expect(libraryApi.get(MIRA_ITEM)).rejects.toThrow(/something unexpected/);
  });
});

// ---------------------------------------------------------------- the rows, the dialogs

const miraRefs = [f.reference({ approved: true })];
function linkedMira(over: Partial<Character> = {}): Character {
  return f.character({
    id: 'chr_0000000000mira',
    name: 'Mira',
    references: miraRefs,
    library: {
      itemId: MIRA_ITEM,
      version: 2,
      digest: hex(2),
      mode: 'used',
      at,
      by: { kind: 'user', id: 'u1' },
    },
    ...over,
  } as Partial<Character>);
}

function docsWith(characters: Character[], elements: Element[] = []): ProjectDocs {
  return f.docs({
    project: f.project({ id: PID }),
    characters: f.byId(characters),
    elements: f.byId(elements),
  });
}

const statusRoute = (links: LibraryLinkStatus[]): Served => [
  'GET',
  /^\/api\/projects\/prj_0000000000ep02\/library$/,
  () => [200, { links, behind: links.filter((l) => l.state === 'behind').length }],
];

describe('the library on a project’s cards', () => {
  it('Update… plans first, asks a real person’s consent, then applies that version', async () => {
    const mira = linkedMira();
    const dry = plan({
      staleTakes: 2,
      approvedClips: [{ id: 'clp_0000000000aaaa', index: 0, title: 'The first letter' }],
      realPerson: true,
      needs: 'project.approve',
    });
    serve([
      statusRoute([link({ modified: true })]),
      [
        'POST',
        /\/library\/apply$/,
        (s) => [
          200,
          { plan: dry, applied: !s.body.dryRun, entity: { kind: 'character', id: mira.id }, commit: null },
        ],
      ],
    ]);
    render(
      <LibraryProvider projectId={PID} docs={docsWith([mira])}>
        <LibraryRows kind="character" entity={mira} />
      </LibraryProvider>,
    );
    expect(await screen.findByText('Library: Mira v2 · v3 available · edited here since v2')).toBeTruthy();
    fireEvent.click(screen.getByTestId('library-update'));
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByText('Update Mira from the library (v2 → v3)');
    expect(within(dialog).getByTestId('plan-approved').textContent).toContain(
      '1 approved clip would hold stale takes: clip 1 (The first letter)',
    );
    const dryRun = calls('POST', /\/library\/apply$/)[0]!;
    expect(dryRun.body).toEqual({
      itemId: MIRA_ITEM,
      version: 3,
      target: { kind: 'character', id: mira.id },
      dryRun: true,
    });
    const confirm = within(dialog).getByTestId('plan-confirm') as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.click(within(dialog).getByTestId('plan-consent-check'));
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);
    await waitFor(() => expect(toasts()).toContain('Updated Mira from the library (v2 → v3)'));
    const applied = calls('POST', /\/library\/apply$/)[1]!;
    expect(applied.body).toEqual({
      itemId: MIRA_ITEM,
      version: 3,
      target: { kind: 'character', id: mira.id },
      acknowledgeConsent: true,
    });
  });

  it('tells an editor that linking needs a director, for the approved clips it names, and lets only one confirm', async () => {
    const mira = linkedMira();
    const dry = plan({ mode: 'link', staleTakes: 1, approvedClips: [HARBOR_CLIP], needs: 'project.approve' });
    serve([
      statusRoute([link()]),
      [
        'POST',
        /\/library\/apply$/,
        () => [200, { plan: dry, applied: false, entity: { kind: 'character', id: mira.id }, commit: null }],
      ],
    ]);
    render(
      <LibraryProvider projectId={PID} docs={asEditor(docsWith([mira]))}>
        <LibraryRows kind="character" entity={mira} />
      </LibraryProvider>,
    );
    fireEvent.click(await screen.findByTestId('library-update'));
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByText('Link Mira to the library (v3)');
    expect(within(dialog).getByTestId('plan-approved').textContent).toBe(
      '1 approved clip would hold stale takes: clip 3 (Harbor at dawn). Linking needs a director: ask one to do it.',
    );
    const confirm = within(dialog).getByTestId('plan-confirm') as HTMLButtonElement;
    expect(confirm.textContent).toBe('Link');
    expect(confirm.disabled).toBe(true);
    expect(confirm.title).toBe('Approved clips are affected: a director links');
  });

  it('names the approved clips when the apply is refused for a clip approved since its plan', async () => {
    const mira = linkedMira();
    let plans = 0;
    serve([
      statusRoute([link()]),
      [
        'POST',
        /\/library\/apply$/,
        (s) => {
          if (!s.body.dryRun) return [403, NEEDS_APPROVE];
          // the plan the dialog opened with was an editor's; a clip approved since makes it a director's
          const p =
            plans++ === 0
              ? plan()
              : plan({ staleTakes: 1, approvedClips: [HARBOR_CLIP], needs: 'project.approve' });
          return [200, { plan: p, applied: false, entity: { kind: 'character', id: mira.id }, commit: null }];
        },
      ],
    ]);
    render(
      <LibraryProvider projectId={PID} docs={asEditor(docsWith([mira]))}>
        <LibraryRows kind="character" entity={mira} />
      </LibraryProvider>,
    );
    fireEvent.click(await screen.findByTestId('library-update'));
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByText('Update Mira from the library (v2 → v3)');
    fireEvent.click(within(dialog).getByTestId('plan-confirm'));
    expect((await within(dialog).findByTestId('plan-error')).textContent).toBe(
      '1 approved clip would hold stale takes: clip 3 (Harbor at dawn). Updating needs a director: ask one to do it.',
    );
    expect(calls('POST', /\/library\/apply$/).map((c) => !!c.body.dryRun)).toEqual([true, false, true]);
    expect(toasts()).toEqual([]);
  });

  it('shows 3D rows for characters, locations and props, none for styles, and a missing pin with Change and Unlink', async () => {
    const harbor = f.element({
      id: 'ele_000000harbor',
      name: 'Harbour',
      deskUnit: {
        kind: 'desk-set',
        itemId: HARBOR_ITEM,
        version: 2,
        sha256: hex(9),
        name: 'Harbor',
        actorKind: null,
        heightM: null,
        pinnedAt: at,
        pinnedBy: { kind: 'user', id: 'u1' },
      },
    } as Partial<Element>);
    const style = f.element({ id: 'ele_00000000noir', kind: 'style', name: 'Noir' });
    serve([
      statusRoute([
        link({
          entity: { kind: 'element', id: harbor.id, name: 'Harbour' },
          via: 'deskUnit',
          itemId: HARBOR_ITEM,
          state: 'missing',
          item: null,
        }),
      ]),
      ['POST', /\/library\/detach$/, (s) => [200, { entity: s.body.target, commit: null }]],
    ]);
    render(
      <LibraryProvider projectId={PID} docs={docsWith([], [harbor, style])}>
        <div data-testid="harbor">
          <LibraryRows kind="element" entity={harbor} />
        </div>
        <div data-testid="style">
          <LibraryRows kind="element" entity={style} />
        </div>
      </LibraryProvider>,
    );
    const row = within(screen.getByTestId('harbor'));
    expect(await row.findByText("3D set: Harbor v2 (not in this studio's library)")).toBeTruthy();
    expect(row.getByTestId('desk-change')).toBeTruthy();
    expect(row.queryByTestId('desk-use-version')).toBeNull();
    expect(within(screen.getByTestId('style')).queryByTestId('desk-row')).toBeNull();
    fireEvent.click(row.getByTestId('desk-unlink'));
    await waitFor(() => expect(toasts()).toContain('Harbour no longer uses Harbor'));
    expect(calls('POST', /\/library\/detach$/)[0]!.body).toEqual({
      target: { kind: 'element', id: harbor.id },
      what: 'deskUnit',
    });
  });

  it('lets a reviewer read the rows but not save, use, update, pin or unlink', async () => {
    useAuth.setState({
      me: {
        mode: 'oidc',
        user: { id: 'usr_0000000000rita', name: 'Rita' },
        admin: false,
        token: null,
      } as unknown as AuthMe,
    });
    const mira = linkedMira({ deskUnit: null });
    const docs = docsWith([mira]);
    docs.project = { ...docs.project, access: { visibility: 'studio', members: [], invites: [] } };
    serve([statusRoute([link()])]);
    render(
      <LibraryProvider projectId={PID} docs={docs}>
        <UseFromLibraryButton kind="character" />
        <SaveToLibraryButton kind="character" entity={mira} />
        <LibraryRows kind="character" entity={mira} />
      </LibraryProvider>,
    );
    expect(await screen.findByText('Library: Mira v2 · v3 available')).toBeTruthy();
    for (const id of [
      'use-from-library',
      'save-to-library',
      'library-update',
      'library-unlink',
      'desk-choose',
    ])
      expect((screen.getByTestId(id) as HTMLButtonElement).disabled, id).toBe(true);
  });

  it('says a resource’s newer version is already in the project instead of offering to add it again', async () => {
    const MOOD = 'lib_0000000000mood';
    const linked = (version: number) => ({
      itemId: MOOD,
      version,
      digest: hex(version),
      mode: 'used' as const,
      at,
      by: { kind: 'user' as const, id: 'u1' },
    });
    const still = (id: string, name: string, version: number) =>
      ({
        id,
        kind: 'image',
        role: 'reference',
        name,
        media: f.imageMedia(),
        createdAt: at,
        origin: 'library',
        status: 'ready',
        library: linked(version),
      }) as Resource;
    const v1 = still('res_000000000000r1', 'Moodboard still', 1);
    const v2 = still('res_000000000000r2', 'Moodboard still B', 2);
    serve([
      statusRoute([
        link({
          entity: { kind: 'resource', id: v1.id, name: v1.name },
          itemId: MOOD,
          version: 1,
          item: { name: 'Moodboard still', kind: 'resource', current: 2, archived: false },
        }),
      ]),
    ]);
    const rows = (resources: Resource[]) =>
      render(
        <LibraryProvider
          projectId={PID}
          docs={f.docs({ project: f.project({ id: PID }), resources: f.byId(resources) })}
        >
          <div data-testid="v1">
            <LibraryRows kind="resource" entity={v1} />
          </div>
        </LibraryProvider>,
      );
    // without v2 in the project the row offers it
    rows([v1]);
    const row = within(screen.getByTestId('v1'));
    expect(await row.findByText('Library: Moodboard still v1 · v2 available')).toBeTruthy();
    expect(row.getByTestId('library-use-version').textContent).toBe('Use v2');
    cleanup();
    // once a resource holds v2, the row names it and adds no other copy
    rows([v1, v2]);
    const again = within(screen.getByTestId('v1'));
    expect(
      await again.findByText('Library: Moodboard still v1 · v2 is in this project: Moodboard still B'),
    ).toBeTruthy();
    expect(again.queryByTestId('library-use-version')).toBeNull();
  });
});

describe('Save to library', () => {
  const realMira = () =>
    f.character({
      id: 'chr_0000000000mira',
      name: 'Mira',
      references: [
        f.reference({
          approved: true,
          consent: {
            depictsRealPerson: true,
            subject: 'Mira Okafor',
            grantedBy: 'Mira Okafor',
            grantedAt: '2026-11-01',
            recordedBy: { kind: 'user', id: 'u1' },
            recordedAt: at,
          },
        }),
      ],
    });

  const saved = (item: LibraryItem, version: number) => ({
    item,
    version: {
      kind: 'character' as const,
      itemId: item.id,
      version,
      digest: hex(version),
      thumbnail: null,
      basedOn: version > 1 ? version - 1 : null,
      note: '',
      source: null,
      realPerson: true,
      bytes: 10,
      createdBy: author,
      createdAt: at,
      payload: characterSnapshot(realMira()).payload,
    },
    unchanged: false,
    commit: null,
  });

  it('saves a real person as a new item only once the consent is confirmed, with its name, tags and note', async () => {
    const mira = realMira();
    serve([statusRoute([]), ['POST', /\/library\/save$/, () => [201, saved(head({ realPerson: true }), 1)]]]);
    render(
      <LibraryProvider projectId={PID} docs={docsWith([mira])}>
        <SaveToLibraryButton kind="character" entity={mira} />
      </LibraryProvider>,
    );
    fireEvent.click(screen.getByTestId('save-to-library'));
    const submit = (await screen.findByTestId('save-to-library-submit')) as HTMLButtonElement;
    expect((screen.getByTestId('save-name') as HTMLInputElement).value).toBe('Mira');
    fireEvent.change(screen.getByTestId('save-tags'), { target: { value: 'Season 1, !!!' } });
    expect(screen.getByTestId('save-tags-invalid').textContent).toContain('!!!');
    fireEvent.change(screen.getByTestId('save-tags'), { target: { value: 'Season 1, keepers' } });
    fireEvent.change(screen.getByTestId('save-note'), { target: { value: 'episode 1' } });
    expect(submit.disabled).toBe(true);
    fireEvent.click(screen.getByTestId('save-consent-check'));
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);
    await waitFor(() => expect(toasts()).toContain('Saved Mira v1 to the library'));
    expect(calls('POST', /\/library\/save$/)[0]!.body).toEqual({
      entity: { kind: 'character', id: mira.id },
      name: 'Mira',
      tags: ['season 1', 'keepers'],
      note: 'episode 1',
      acknowledgeConsent: true,
    });
  });

  it('offers Update… and Save anyway as the next version when a version was saved meanwhile', async () => {
    const mira = { ...realMira(), library: linkedMira().library };
    let attempt = 0;
    serve([
      statusRoute([link({ state: 'current', version: 2, item: { ...link().item!, current: 2 } })]),
      [
        'POST',
        /\/library\/save$/,
        () =>
          attempt++ === 0
            ? [
                412,
                {
                  type: 'about:blank',
                  title: 'stale',
                  status: 412,
                  detail: 'v3 was saved meanwhile',
                  code: 'library_conflict',
                  errors: [{ latest: 3 }],
                },
              ]
            : [201, saved(head({ current: 4, realPerson: true }), 4)],
      ],
    ]);
    render(
      <LibraryProvider projectId={PID} docs={docsWith([mira])}>
        <SaveToLibraryButton kind="character" entity={mira} />
      </LibraryProvider>,
    );
    fireEvent.click(screen.getByTestId('save-to-library'));
    expect(((await screen.findByTestId('save-as-version')) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByTestId('save-consent-check'));
    fireEvent.click(screen.getByTestId('save-to-library-submit'));
    expect((await screen.findByTestId('save-error')).textContent).toBe(
      'Someone saved v3 meanwhile: take it first, or save anyway as the next version.',
    );
    expect(screen.getByTestId('save-take-latest').textContent).toBe('Update…');
    fireEvent.click(screen.getByTestId('save-anyway'));
    await waitFor(() => expect(toasts()).toContain('Saved Mira v4 to the library'));
    expect(calls('POST', /\/library\/save$/).map((c) => c.body.basedOn)).toEqual([2, 3]);
  });
});

describe('Use from library', () => {
  /** A project with a Mira of its own and a library Mira (a real person): using her is refused, name taken. */
  function clash() {
    const own = f.character({ id: 'chr_00000000ownmira', name: 'Mira', library: undefined });
    const item = head({ realPerson: true });
    serve([
      statusRoute([]),
      ['GET', /^\/api\/library\/items\?/, () => [200, { items: [summary(item)], next: null }]],
      [
        'POST',
        /\/library\/apply$/,
        (s) =>
          s.body.dryRun
            ? [
                200,
                {
                  plan: plan({ mode: 'link', realPerson: true }),
                  applied: false,
                  entity: s.body.target,
                  commit: null,
                },
              ]
            : [
                409,
                {
                  type: 'about:blank',
                  title: 'taken',
                  status: 409,
                  detail: 'a character named Mira is already in this project',
                  code: 'conflict',
                  errors: [{ reason: 'name', entityId: own.id }],
                },
              ],
      ],
    ]);
    render(
      <LibraryProvider projectId={PID} docs={docsWith([own])}>
        <UseFromLibraryButton kind="character" />
      </LibraryProvider>,
    );
    return own;
  }

  const dialogs = () => screen.queryAllByRole('dialog').map((d) => d.getAttribute('aria-label'));

  it('uses the chosen items one after the other and offers to link a clash to the project’s own', async () => {
    const own = clash();
    fireEvent.click(screen.getByTestId('use-from-library'));
    const check = (await screen.findByTestId('use-item-check')) as HTMLInputElement;
    expect(calls('GET', /^\/api\/library\/items\?/)[0]!.path).toContain('kinds=character');
    fireEvent.click(check);
    const use = screen.getByTestId('use-submit') as HTMLButtonElement;
    expect(use.disabled).toBe(true);
    fireEvent.click(screen.getByTestId('use-consent-check'));
    fireEvent.click(use);
    const result = await screen.findByTestId('use-result');
    expect(result.textContent).toContain('Mira: a character named Mira is already in this project');
    expect(within(result).getByTestId('use-link-existing').textContent).toBe('Link to the existing Mira');
    expect(calls('POST', /\/library\/apply$/)[0]!.body).toEqual({
      itemId: MIRA_ITEM,
      acknowledgeConsent: true,
    });
    fireEvent.click(screen.getByTestId('use-link-existing'));
    await screen.findByText('Link Mira to the library (v3)');
    expect(calls('POST', /\/library\/apply$/)[1]!.body).toEqual({
      itemId: MIRA_ITEM,
      target: { kind: 'character', id: own.id },
      dryRun: true,
    });
  });

  it('closes only the plan opened over the picker on Escape, and the picker keeps its results', async () => {
    clash();
    fireEvent.click(screen.getByTestId('use-from-library'));
    fireEvent.click(await screen.findByTestId('use-item-check'));
    fireEvent.click(screen.getByTestId('use-consent-check'));
    fireEvent.click(screen.getByTestId('use-submit'));
    fireEvent.click(await screen.findByTestId('use-link-existing'));
    await screen.findByText('Link Mira to the library (v3)');
    expect(dialogs()).toEqual(['Use characters from the library', 'Link Mira to the library (v3)']);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(dialogs()).toEqual(['Use characters from the library']);
    expect(screen.getByTestId('use-result').textContent).toContain(
      'Mira: a character named Mira is already in this project',
    );
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(dialogs()).toEqual([]);
  });

  /** Ada and Mira in the library, each with a tag of her own; the list answers the search and the tag asked. */
  function twoInTheLibrary() {
    const ada = head({ id: 'lib_00000000000ada', name: 'Ada', tags: ['tag-a'] });
    const mira = head({ name: 'Mira', tags: ['tag-m'] });
    serve([
      statusRoute([]),
      [
        'GET',
        /^\/api\/library\/items\?/,
        (s) => {
          const query = new URL(s.path, 'http://localhost').searchParams;
          const words = (query.get('q') ?? '').toLowerCase();
          const tag = query.get('tag');
          const items = [ada, mira].filter(
            (i) => (!words || i.name.toLowerCase().includes(words)) && (!tag || i.tags.includes(tag)),
          );
          return [200, { items: items.map(summary), next: null }];
        },
      ],
      [
        'POST',
        /\/library\/apply$/,
        (s) => [
          200,
          {
            plan: plan({
              mode: 'create',
              keepsLibraryId: true,
              entity: {
                kind: 'character',
                id: 'chr_00000000000new',
                name: s.body.itemId === ada.id ? 'Ada' : 'Mira',
                exists: false,
              },
            }),
            applied: true,
            entity: { kind: 'character', id: 'chr_00000000000new' },
            commit: null,
          },
        ],
      ],
    ]);
    render(
      <LibraryProvider projectId={PID} docs={docsWith([])}>
        <UseFromLibraryButton kind="character" />
      </LibraryProvider>,
    );
    return { ada, mira };
  }

  const row = (name: string) =>
    within(screen.getAllByTestId('use-item').find((r) => r.textContent?.includes(name))!);

  it('keeps what was checked under another search, and uses every checked item', async () => {
    const { ada, mira } = twoInTheLibrary();
    fireEvent.click(screen.getByTestId('use-from-library'));
    await waitFor(() => expect(screen.getAllByTestId('use-item')).toHaveLength(2));
    fireEvent.click(row('Ada').getByTestId('use-item-check'));
    fireEvent.change(screen.getByTestId('use-search'), { target: { value: 'Mira' } });
    await waitFor(() => expect(screen.getAllByTestId('use-item')).toHaveLength(1));
    fireEvent.click(row('Mira').getByTestId('use-item-check'));
    expect(screen.getByTestId('use-submit').textContent).toBe('Use 2');
    // the item checked under the other search is named, so that "Use 2" adds up
    expect(screen.getByTestId('use-checked-elsewhere').textContent).toBe('Also checked: Ada');
    fireEvent.click(screen.getByTestId('use-submit'));
    await waitFor(() => expect(screen.getAllByTestId('use-result')).toHaveLength(2));
    expect(calls('POST', /\/library\/apply$/).map((c) => c.body.itemId)).toEqual([ada.id, mira.id]);
    // nothing stays checked once used
    expect(screen.queryByTestId('use-checked-elsewhere')).toBeNull();
    expect(screen.getAllByTestId('use-result').map((r) => r.textContent)).toEqual([
      'Ada: Ada is in the project (v3, the same id and seed)',
      'Mira: Mira is in the project (v3, the same id and seed)',
    ]);
  });

  /** Mira in the library; a use answered by `apply` (a dry run answered with the plan `dry`). */
  function miraToUse(docs: ProjectDocs, apply: (s: Sent) => Answer, dry: LibraryApplyPlan) {
    serve([
      statusRoute([]),
      ['GET', /^\/api\/library\/items\?/, () => [200, { items: [summary(head())], next: null }]],
      [
        'POST',
        /\/library\/apply$/,
        (s) =>
          s.body.dryRun
            ? [
                200,
                { plan: dry, applied: false, entity: { kind: 'character', id: dry.entity.id }, commit: null },
              ]
            : apply(s),
      ],
    ]);
    render(
      <LibraryProvider projectId={PID} docs={docs}>
        <UseFromLibraryButton kind="character" />
      </LibraryProvider>,
    );
  }
  /** A use of Mira back in the project, whose old take an approved clip holds (the third clip). */
  const miraBack = plan({
    mode: 'create',
    keepsLibraryId: true,
    entity: { kind: 'character', id: 'chr_0000000000mira', name: 'Mira', exists: false },
    staleTakes: 1,
    approvedClips: [HARBOR_CLIP],
    needs: 'project.approve',
  });

  it('tells an editor which approved clips need a director instead of the role’s refusal', async () => {
    miraToUse(asEditor(docsWith([])), () => [403, NEEDS_APPROVE], miraBack);
    fireEvent.click(screen.getByTestId('use-from-library'));
    fireEvent.click(await screen.findByTestId('use-item-check'));
    fireEvent.click(screen.getByTestId('use-submit'));
    await waitFor(() =>
      expect(screen.getByTestId('use-result').textContent).toBe(
        'Mira: 1 approved clip would hold stale takes: clip 3 (Harbor at dawn). Using it in this project needs a director: ask one to do it.',
      ),
    );
    // the use first, then (refused) its plan, as a dry run of the same use
    expect(calls('POST', /\/library\/apply$/).map((c) => c.body)).toEqual([
      { itemId: MIRA_ITEM },
      { itemId: MIRA_ITEM, dryRun: true },
    ]);
  });

  it('tells a director which approved clips the use left with stale takes', async () => {
    miraToUse(
      docsWith([]),
      () => [
        200,
        {
          plan: miraBack,
          applied: true,
          entity: { kind: 'character', id: miraBack.entity.id },
          commit: null,
        },
      ],
      miraBack,
    );
    fireEvent.click(screen.getByTestId('use-from-library'));
    fireEvent.click(await screen.findByTestId('use-item-check'));
    fireEvent.click(screen.getByTestId('use-submit'));
    await waitFor(() =>
      expect(screen.getByTestId('use-result').textContent).toBe(
        'Mira: Mira is in the project (v3, the same id and seed). 1 approved clip now holds stale takes: clip 3 (Harbor at dawn); it stays approved with its takes until generated again.',
      ),
    );
    expect(calls('POST', /\/library\/apply$/)).toHaveLength(1);
  });

  it('keeps what was checked under another tag, and uses every checked item', async () => {
    const { ada, mira } = twoInTheLibrary();
    fireEvent.click(screen.getByTestId('use-from-library'));
    await waitFor(() => expect(screen.getAllByTestId('use-item')).toHaveLength(2));
    fireEvent.change(screen.getByTestId('use-tag'), { target: { value: 'tag-a' } });
    await waitFor(() => expect(screen.getAllByTestId('use-item')).toHaveLength(1));
    fireEvent.click(row('Ada').getByTestId('use-item-check'));
    fireEvent.change(screen.getByTestId('use-tag'), { target: { value: 'tag-m' } });
    await waitFor(() => expect(screen.getByTestId('use-item').textContent).toContain('Mira'));
    fireEvent.click(row('Mira').getByTestId('use-item-check'));
    expect(screen.getByTestId('use-submit').textContent).toBe('Use 2');
    fireEvent.click(screen.getByTestId('use-submit'));
    await waitFor(() => expect(screen.getAllByTestId('use-result')).toHaveLength(2));
    expect(calls('POST', /\/library\/apply$/).map((c) => c.body.itemId)).toEqual([ada.id, mira.id]);
  });
});

describe('the Library page', () => {
  it('moves every other version’s pins in turn, lists each answer, and archives with the head’s revision', async () => {
    const harbor = head({ id: HARBOR_ITEM, kind: 'desk-set', name: 'Harbor', current: 3, tags: ['docks'] });
    const uses: LibraryUses = {
      incomplete: false,
      projects: [
        {
          projectId: 'prj_00000000000ep1',
          title: 'Episode 1',
          role: 'director',
          uses: [
            {
              itemId: HARBOR_ITEM,
              version: 1,
              via: 'deskUnit',
              entity: { kind: 'element', id: 'ele_000000harbor', name: 'Harbour' },
            },
          ],
        },
        {
          projectId: 'prj_00000000000ep2',
          title: 'Episode 2',
          role: 'director',
          uses: [
            {
              itemId: HARBOR_ITEM,
              version: 2,
              via: 'deskUnit',
              entity: { kind: 'element', id: 'ele_00000000quay', name: 'Quay' },
            },
          ],
        },
      ],
    };
    serve([
      ['GET', /^\/api\/library\/items\?/, () => [200, { items: [summary(harbor)], next: null }]],
      ['GET', /^\/api\/library\/items\/lib_00000000harbor$/, () => [200, harbor]],
      ['GET', /^\/api\/library\/items\/lib_00000000harbor\/uses$/, () => [200, uses]],
      [
        'POST',
        /^\/api\/projects\/prj_00000000000ep1\/library\/apply$/,
        (s) => [200, { plan: plan({ mode: 'pin' }), applied: true, entity: s.body.target, commit: null }],
      ],
      [
        'POST',
        /^\/api\/projects\/prj_00000000000ep2\/library\/apply$/,
        () => [
          409,
          { type: 'about:blank', title: 'x', status: 409, detail: 'Quay is locked', code: 'element_locked' },
        ],
      ],
      [
        'PATCH',
        /^\/api\/library\/items\/lib_00000000harbor$/,
        () => [200, { ...harbor, archived: true, rev: 6 }],
      ],
    ]);
    render(
      <MemoryRouter initialEntries={[`/library/${HARBOR_ITEM}`]}>
        <Routes>
          <Route path="/library/:itemId?" element={<LibraryPage />} />
        </Routes>
      </MemoryRouter>,
    );
    const detail = await screen.findByTestId('library-detail');
    expect(
      within(detail)
        .getAllByTestId('library-version')
        .map((v) => v.textContent?.slice(0, 2)),
    ).toEqual(['v3', 'v2', 'v1']);
    const everywhere = await screen.findByTestId('library-use-everywhere');
    expect(everywhere.textContent).toBe('Use v3 in all 2 projects');
    fireEvent.click(everywhere);
    await waitFor(() => expect(screen.getAllByTestId('library-use-result')).toHaveLength(2));
    expect(
      screen.getAllByTestId('library-use-result').map((r) => [r.dataset.outcome, r.textContent]),
    ).toEqual([
      ['applied', 'Episode 1 · Harbour: now uses v3'],
      ['refused', 'Episode 2 · Quay: refused: Quay is locked'],
    ]);
    const applies = calls('POST', /\/library\/apply$/);
    expect(applies.map((c) => [c.path.split('/')[3], c.body])).toEqual([
      [
        'prj_00000000000ep1',
        { itemId: HARBOR_ITEM, version: 3, target: { kind: 'element', id: 'ele_000000harbor' } },
      ],
      [
        'prj_00000000000ep2',
        { itemId: HARBOR_ITEM, version: 3, target: { kind: 'element', id: 'ele_00000000quay' } },
      ],
    ]);
    fireEvent.click(screen.getByTestId('library-archive'));
    expect(await screen.findByTestId('library-archived')).toBeTruthy();
    const patch = calls('PATCH', /lib_00000000harbor$/)[0]!;
    expect(patch.body).toEqual({ archived: true });
    expect(patch.headers['if-match']).toBe('"r5"');
  });

  it('makes a version current with the item’s revision, and says so after reloading when it changed meanwhile', async () => {
    const mira = head({ current: 3 });
    let reads = 0;
    serve([
      ['GET', /^\/api\/library\/items\?/, () => [200, { items: [summary(mira)], next: null }]],
      [
        'GET',
        /^\/api\/library\/items\/lib_0000000000mira$/,
        // read again after the refused change: the item as someone else left it
        () => [200, ++reads === 1 ? mira : { ...mira, current: 2, rev: 7, description: 'Changed elsewhere' }],
      ],
      [
        'GET',
        /^\/api\/library\/items\/lib_0000000000mira\/uses$/,
        () => [200, { incomplete: false, projects: [] }],
      ],
      [
        'PATCH',
        /^\/api\/library\/items\/lib_0000000000mira$/,
        (s) =>
          s.body.current === 2
            ? [200, { ...mira, current: 2, rev: 6 }]
            : [
                412,
                {
                  type: 'about:blank',
                  title: 'x',
                  status: 412,
                  detail: 'Mira changed meanwhile: its revision is 7',
                  code: 'library_conflict',
                  errors: [{ rev: 7, latest: 3 }],
                },
              ],
      ],
    ]);
    render(
      <MemoryRouter initialEntries={[`/library/${MIRA_ITEM}`]}>
        <Routes>
          <Route path="/library/:itemId?" element={<LibraryPage />} />
        </Routes>
      </MemoryRouter>,
    );
    const detail = await screen.findByTestId('library-detail');
    const versions = () => within(detail).getAllByTestId('library-version');
    expect(within(versions()[0]!).queryByTestId('library-make-current')).toBeNull();
    fireEvent.click(within(versions()[1]!).getByTestId('library-make-current'));
    await waitFor(() => expect(within(versions()[1]!).getByText('current')).toBeTruthy());
    const made = calls('PATCH', /lib_0000000000mira$/)[0]!;
    expect(made.body).toEqual({ current: 2 });
    expect(made.headers['if-match']).toBe('"r5"');
    // v3 again, with the revision the change answered; the item changed meanwhile
    fireEvent.click(within(versions()[0]!).getByTestId('library-make-current'));
    expect((await screen.findByTestId('library-error')).textContent).toBe(
      'Someone changed this item meanwhile: it was reloaded, try again.',
    );
    expect(calls('PATCH', /lib_0000000000mira$/)[1]!.headers['if-match']).toBe('"r6"');
    expect(calls('GET', /lib_0000000000mira$/)).toHaveLength(2);
    // the field takes the reloaded value on its next render
    await waitFor(() =>
      expect((within(detail).getByLabelText('Description') as HTMLTextAreaElement).value).toBe(
        'Changed elsewhere',
      ),
    );
  });

  const page = (itemId: string) =>
    render(
      <MemoryRouter initialEntries={[`/library/${itemId}`]}>
        <Routes>
          <Route path="/library/:itemId?" element={<LibraryPage />} />
        </Routes>
      </MemoryRouter>,
    );

  /** A version of an item as the studio answers it, with `kind` and `payload` of its own. */
  const versionOf = (item: LibraryItem, kind: string, payload: unknown) => ({
    kind,
    itemId: item.id,
    version: item.current,
    digest: hex(item.current),
    thumbnail: null,
    basedOn: null,
    note: '',
    source: null,
    realPerson: false,
    bytes: 78,
    createdBy: author,
    createdAt: at,
    payload,
  });

  it('shows no action bar to someone who may not manage the item and has no pins to move', async () => {
    useAuth.setState({
      me: {
        mode: 'oidc',
        user: { id: 'usr_0000000000cleo', name: 'Cleo' },
        admin: false,
        token: null,
      } as unknown as AuthMe,
    });
    const mira = head();
    serve([
      ['GET', /^\/api\/library\/items\?/, () => [200, { items: [summary(mira)], next: null }]],
      ['GET', /^\/api\/library\/items\/lib_0000000000mira$/, () => [200, mira]],
      [
        'GET',
        /^\/api\/library\/items\/lib_0000000000mira\/uses$/,
        () => [200, { incomplete: false, projects: [] }],
      ],
    ]);
    page(MIRA_ITEM);
    await screen.findByTestId('library-uses');
    expect(screen.queryByTestId('library-archive')).toBeNull();
    expect(screen.queryByTestId('library-actions')).toBeNull();
  });

  it('says one object and one credit in the singular', async () => {
    const lamp = head({ id: 'lib_000000000lampp', kind: 'desk-prop', name: 'Lamp' });
    const unit = {
      format: '3d-editor.desk-unit',
      formatVersion: 1,
      payload: { name: 'lamp', hash: hex(1), mime: 'application/octet-stream', size: 78 },
      meta: {
        dimensionsM: [1, 1, 1],
        objects: 1,
        triangles: 12,
        actor: null,
        credits: [{ name: 'Brass lamp', author: 'A. Modeller', license: 'CC-BY-4.0' }],
        deskVersion: '0.0.0-test',
        digest: hex(2),
      },
    };
    serve([
      ['GET', /^\/api\/library\/items\?/, () => [200, { items: [summary(lamp)], next: null }]],
      ['GET', /^\/api\/library\/items\/lib_000000000lampp$/, () => [200, lamp]],
      [
        'GET',
        /^\/api\/library\/items\/lib_000000000lampp\/versions\/1$/,
        () => [200, versionOf(lamp, 'desk-prop', unit)],
      ],
      [
        'GET',
        /^\/api\/library\/items\/lib_000000000lampp\/uses$/,
        () => [200, { incomplete: false, projects: [] }],
      ],
    ]);
    page(lamp.id);
    const facts = await screen.findByTestId('library-facts');
    expect(facts.textContent).toBe('1 × 1 × 1 m · 78 B · 1 object · 1 credit');
  });

  it('calls a style a style, in the list and on the item', async () => {
    const noir = head({ id: 'lib_000000000noirr', kind: 'element', name: 'Moody noir' });
    const style = f.element({ id: 'ele_0000000000noir', kind: 'style', name: 'Moody noir', references: [] });
    const version = versionOf(noir, 'element', elementSnapshot(style).payload);
    serve([
      ['GET', /^\/api\/library\/items\?/, () => [200, { items: [summary(noir)], next: null }]],
      ['GET', /^\/api\/library\/items\/lib_000000000noirr$/, () => [200, noir]],
      ['GET', /^\/api\/library\/items\/lib_000000000noirr\/versions\/1$/, () => [200, version]],
      [
        'GET',
        /^\/api\/library\/items\/lib_000000000noirr\/uses$/,
        () => [200, { incomplete: false, projects: [] }],
      ],
    ]);
    page(noir.id);
    const detail = await screen.findByTestId('library-detail');
    expect(await within(detail).findByText('Style')).toBeTruthy();
    await waitFor(() => expect(screen.getByTestId('library-item').textContent).toContain('Style · v1'));
    expect(screen.queryByText(/Place or prop/)).toBeNull();
  });

  it('says when it cannot read where an item is used, keeps saying it when the item arrives, and tries again', async () => {
    const crate = head({ id: 'lib_00000000crate1', kind: 'desk-prop', name: 'Crate' });
    const offline = {
      type: 'about:blank',
      title: 'offline',
      status: 503,
      detail: 'the tab is closed',
      code: 'storage_offline',
    };
    for (const [itemDelay, usesDelay] of [
      [80, 0],
      [0, 80],
    ]) {
      let usesAsked = 0;
      serve([
        ['GET', /^\/api\/library\/items\?/, () => [200, { items: [summary(crate)], next: null }]],
        ['GET', /^\/api\/library\/items\/lib_00000000crate1$/, () => [200, crate], itemDelay],
        [
          'GET',
          /^\/api\/library\/items\/lib_00000000crate1\/uses$/,
          () => (usesAsked++ === 0 ? [503, offline] : [200, { incomplete: false, projects: [] }]),
          usesDelay,
        ],
      ]);
      page(crate.id);
      const failed = await screen.findByTestId('library-uses-error');
      // the item arriving after the failure does not wipe it
      await new Promise((r) => setTimeout(r, 150));
      expect(screen.getByTestId('library-uses-error').textContent).toBe(failed.textContent);
      expect(failed.textContent).toContain(
        'The project is kept in a browser tab that is closed: open the project there and try again.',
      );
      fireEvent.click(screen.getByTestId('library-uses-retry'));
      expect((await screen.findByTestId('library-uses')).textContent).toContain('No project uses it yet.');
      expect(screen.queryByTestId('library-uses-error')).toBeNull();
      expect(calls('GET', /\/uses$/)).toHaveLength(2);
      cleanup();
    }
  });
});
