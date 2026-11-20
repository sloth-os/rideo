import {
  type AuthMe,
  type Character,
  characterSnapshot,
  type Element,
  type LibraryApplyPlan,
  type LibraryItem,
  type LibraryLinkStatus,
  type LibraryUses,
  type ProjectDocs,
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
  conflictOf,
  consentSubjectsOf,
  deskMoves,
  deskRowText,
  latestOf,
  libraryErrorText,
  libraryRowText,
  moveEverywhere,
  moveEverywhereLabel,
  offeredVersion,
  parseTags,
  planAllowed,
  planLines,
  planTitle,
  usageText,
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
type Served = [method: string, path: RegExp, answer: (sent: Sent) => Answer];

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
  it('uses the chosen items one after the other and offers to link a clash to the project’s own', async () => {
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
});
