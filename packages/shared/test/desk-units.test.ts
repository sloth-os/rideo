import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  type Clip,
  DESK_STATE_UNITS_HEADER,
  DESK_UNIT_LIBRARY_KIND,
  type DeskBriefPinSlot,
  DeskStateUnitsError,
  type DeskStateUnitUse,
  type DeskUnitPin,
  deskStateUses,
  deskUnitBadge,
  deskUnitDrift,
  deskUnitDriftLine,
  deskUnitPinsToSend,
  formatDeskStateUnits,
  libraryUses,
  parseDeskStateUnits,
  type Scene,
} from '../src';
import * as f from '../src/testing/fixtures';

/** Library units in the desk, the pure parts (docs/design/director-desk.md#library-units). */

const SET = 'lib_0j8kc4n2q1h7wz3x';
const FIGURE = 'lib_0j8kc4n2q1h7mira';
const PROP = 'lib_0j8kc4n2q1h7lamp';

describe('X-Desk-State-Units (docs/design/director-desk.md#what-a-stored-state-uses)', () => {
  // the docs' example, its rows in the desk's order
  const EXAMPLE =
    'cast:chr_0j8kc3v9m2a7mr5t=lib_0j8kc4n2q1h7mira@2:unit:local, el:ele_0j8kc3x0b5k9dn2p=lib_0j8kc4n2q1h7lamp@1:pending:missing, set=lib_0j8kc4n2q1h7wz3x@3:unit';
  const ROWS: DeskStateUnitUse[] = [
    {
      slot: 'cast:chr_0j8kc3v9m2a7mr5t',
      ref: 'lib_0j8kc4n2q1h7mira',
      version: 2,
      staged: 'unit',
      local: true,
    },
    {
      slot: 'el:ele_0j8kc3x0b5k9dn2p',
      ref: 'lib_0j8kc4n2q1h7lamp',
      version: 1,
      staged: 'pending',
      local: false,
      why: 'missing',
    },
    { slot: 'set', ref: 'lib_0j8kc4n2q1h7wz3x', version: 3, staged: 'unit', local: false },
  ];

  it("is the docs' example, rows sorted by slot in plain string order as the desk sends them", () => {
    const doc = readFileSync(resolve(import.meta.dirname, '../../../docs/design/director-desk.md'), 'utf8');
    expect(/^X-Desk-State-Units: (.+)$/m.exec(doc)?.[1]).toBe(EXAMPLE);
    // the desk compares slots as plain strings (a < b): cast:…, el:…, set
    const slots = parseDeskStateUnits(EXAMPLE)!.map((r) => r.slot);
    expect(slots).toEqual([...slots].sort());
    expect(doc.replace(/\s+/g, ' ')).toContain(
      'sorted by slot in plain string order (`cast:<characterId>`, `el:<elementId>`, `set`)',
    );
  });

  it("is the docs' header, and reads back as its rows", () => {
    expect(DESK_STATE_UNITS_HEADER).toBe('x-desk-state-units');
    const rows = parseDeskStateUnits(EXAMPLE)!;
    expect(rows.map((r) => [r.slot, r.version, r.staged, r.local, r.why])).toEqual([
      ['cast:chr_0j8kc3v9m2a7mr5t', 2, 'unit', true, undefined],
      ['el:ele_0j8kc3x0b5k9dn2p', 1, 'pending', false, 'missing'],
      ['set', 3, 'unit', false, undefined],
    ]);
    expect(rows).toEqual(ROWS);
    expect(formatDeskStateUnits(ROWS)).toBe(EXAMPLE);
    expect(parseDeskStateUnits(formatDeskStateUnits(ROWS))).toEqual(ROWS);
    // a reason with `local`, a slot whose id holds `:` and `.`
    const odd: DeskStateUnitUse[] = [
      {
        slot: 'el:a.b:c',
        ref: 'lib_0000000000odd1',
        version: 1000,
        staged: 'refused',
        local: true,
        why: 'too_large',
      },
    ];
    expect(formatDeskStateUnits(odd)).toBe('el:a.b:c=lib_0000000000odd1@1000:refused:local:too_large');
    expect(parseDeskStateUnits(formatDeskStateUnits(odd))).toEqual(odd);
  });

  it("says none with '-' and unknown with no header", () => {
    expect(formatDeskStateUnits([])).toBe('-');
    expect(formatDeskStateUnits(null)).toBeUndefined();
    expect(formatDeskStateUnits(undefined)).toBeUndefined();
    expect(parseDeskStateUnits('-')).toEqual([]);
    expect(parseDeskStateUnits(' - ')).toEqual([]);
    expect(parseDeskStateUnits(undefined)).toBeNull();
  });

  it('takes 128 rows and 8 KiB at most: rows that do not fit are no header, a header past them is refused', () => {
    const row = (i: number): DeskStateUnitUse => ({
      slot: `el:e${i}`,
      ref: SET,
      version: 1,
      staged: 'unit',
      local: false,
    });
    const rows128 = Array.from({ length: 128 }, (_, i) => row(i));
    const header = formatDeskStateUnits(rows128)!;
    expect(parseDeskStateUnits(header)).toHaveLength(128);
    expect(formatDeskStateUnits([...rows128, row(128)])).toBeUndefined();
    expect(() => parseDeskStateUnits(`${header}, ${'el:e128=lib_0j8kc4n2q1h7wz3x@1:unit'}`)).toThrow(
      DeskStateUnitsError,
    );
    // long ids: fewer rows, past 8 KiB
    const long = (i: number): DeskStateUnitUse => ({ ...row(i), slot: `el:${String(i).padStart(99, 'x')}` });
    const big = Array.from({ length: 70 }, (_, i) => long(i));
    expect(formatDeskStateUnits(big)).toBeUndefined();
    const raw = big.map((r) => `${r.slot}=${r.ref}@1:unit`).join(', ');
    expect(raw.length).toBeGreaterThan(8192);
    expect(() => parseDeskStateUnits(raw)).toThrow(/8192 bytes/);
    expect(formatDeskStateUnits(big.slice(0, 60))!.length).toBeLessThanOrEqual(8192);
  });

  it('gives no header for rows that name a slot twice, which the server refuses; each slot once in any order is one', () => {
    const twice: DeskStateUnitUse[] = [ROWS[2]!, ROWS[0]!, { ...ROWS[0]!, version: 4 }];
    expect(formatDeskStateUnits(twice)).toBeUndefined();
    const once = [ROWS[2]!, ROWS[0]!];
    expect(parseDeskStateUnits(formatDeskStateUnits(once))).toEqual(once);
  });

  it('refuses what does not parse: bad syntax, a staging or reason it does not know, a slot named twice', () => {
    for (const bad of [
      '',
      ' ',
      'set',
      'set=lib_a',
      'set=@1:unit',
      '=lib_0j8kc4n2q1h7wz3x@1:unit',
      'set=lib_0j8kc4n2q1h7wz3x@0:unit',
      'set=lib_0j8kc4n2q1h7wz3x@01:unit',
      'set=lib_0j8kc4n2q1h7wz3x@1.5:unit',
      'set=lib_0j8kc4n2q1h7wz3x@1',
      'set=lib_0j8kc4n2q1h7wz3x@1:words',
      'set=lib_0j8kc4n2q1h7wz3x@1:unit:Missing',
      'set=lib_0j8kc4n2q1h7wz3x@1:pending:missing:again',
      'set=lib_0j8kc4n2q1h7wz3x@1:unit:local:local',
      'scene=lib_0j8kc4n2q1h7wz3x@1:unit',
      'cast:=lib_0j8kc4n2q1h7wz3x@1:unit',
      'set=lib_0j8kc4n2q1h7wz3x@1:unit,',
      'set=lib_0j8kc4n2q1h7wz3x@1:unit, set=lib_0j8kc4n2q1h7wz3x@2:unit',
      'set=lib x@1:unit',
    ])
      expect(() => parseDeskStateUnits(bad), JSON.stringify(bad)).toThrow(DeskStateUnitsError);
  });
});

/** A scene at a place with a set pin, a character with a figure pin and a prop with a prop pin. */
function scene(
  opts: { units?: DeskStateUnitUse[] | null; status?: Clip['status']; deskState?: boolean } = {},
) {
  const pin = (kind: DeskUnitPin['kind'], itemId: string, version: number, name: string): DeskUnitPin => ({
    kind,
    itemId,
    version,
    sha256: 'c'.repeat(64),
    name,
    actorKind: null,
    heightM: null,
    pinnedAt: '2026-11-01T10:00:00.000Z',
    pinnedBy: { kind: 'user', id: 'usr_1', name: 'Ada' },
  });
  const harbor = f.element({ kind: 'location', name: 'Harbor', deskUnit: pin('desk-set', SET, 3, 'Harbor') });
  const lamp = f.element({
    kind: 'prop',
    name: 'Oil lamp',
    deskUnit: pin('desk-prop', PROP, 1, 'Brass lamp'),
  });
  const mira = f.character({ name: 'Mira', deskUnit: pin('desk-figure', FIGURE, 2, 'Mira figure') });
  const sc: Scene = {
    id: 'scn_0000000000000001',
    index: 0,
    beatId: null,
    heading: 'EXT. HARBOR - DAY',
    location: 'Harbor',
    timeOfDay: 'day',
    summary: '',
    action: '',
    dialogue: [],
    characterIds: [mira.id],
    locationId: harbor.id,
    elementIds: [lamp.id],
    estDurationSec: 10,
    continuity: '',
  };
  const shot = f.shot({ characterIds: [mira.id], elementIds: [lamp.id] });
  const clip = f.clip({
    sceneId: sc.id,
    shots: [shot],
    status: opts.status ?? 'planned',
    deskState:
      opts.deskState === false
        ? null
        : {
            format: '3d-editor.desk-state',
            version: 1,
            media: f.media(),
            updatedAt: '2026-11-02T10:00:00.000Z',
            ...(opts.units !== undefined ? { units: opts.units } : {}),
          },
  });
  const docs = f.docs({
    screenplay: f.screenplay({ scenes: [sc] }),
    characters: f.byId([mira]),
    elements: f.byId([harbor, lamp]),
    clips: f.byId([clip]),
  });
  const rows = {
    set: { slot: 'set', ref: SET, version: 3, staged: 'unit', local: false } as DeskStateUnitUse,
    cast: {
      slot: `cast:${mira.id}`,
      ref: FIGURE,
      version: 2,
      staged: 'unit',
      local: false,
    } as DeskStateUnitUse,
    el: { slot: `el:${lamp.id}`, ref: PROP, version: 1, staged: 'unit', local: false } as DeskStateUnitUse,
  };
  return { docs, clip, harbor, lamp, mira, rows };
}

describe('deskUnitDrift (docs/design/director-desk.md#drift-the-storyboard-badge)', () => {
  /** The drift of a scene whose stored state uses the rows `units` picks from its own slots. */
  const statuses = (
    units: (r: ReturnType<typeof scene>['rows']) => DeskStateUnitUse[],
    status?: Clip['status'],
  ) => {
    const s = scene(status ? { status } : {});
    const clip = { ...s.clip, deskState: { ...s.clip.deskState!, units: units(s.rows) } };
    const docs = { ...s.docs, clips: { [clip.id]: clip } };
    return { ...s, docs, clip, drift: deskUnitDrift(docs, clip.id) };
  };

  it('is current, local, update, pending and refused by what the stored state uses, slot by slot', () => {
    const { drift, harbor, mira, lamp } = statuses((r) => [r.set, { ...r.cast, local: true }, r.el]);
    expect(drift.map((d) => [d.slot, d.kind, d.status])).toEqual([
      ['set', 'set', 'current'],
      [`cast:${mira.id}`, 'figure', 'local'],
      [`el:${lamp.id}`, 'prop', 'current'],
    ]);
    expect(drift[0]).toMatchObject({ label: harbor.name, pin: { itemId: SET, version: 3, name: 'Harbor' } });
    expect(deskUnitBadge(drift)).toBeNull();

    const later = statuses((r) => [{ ...r.set, version: 2 }, r.cast]).drift;
    // an older version of the pin's item, and a slot with no row (pinned after the state)
    expect(later.map((d) => d.status)).toEqual(['update', 'current', 'update']);
    expect(deskUnitBadge(later)).toMatchObject({ status: 'update', text: '3D: v3 available' });
    expect(deskUnitBadge(later)!.title).toContain('Harbor: Harbor v3 available (the stored desk uses v2)');
    expect(deskUnitBadge(later)!.title).toContain('Oil lamp: Brass lamp v1 available (not staged yet)');

    const other = statuses((r) => [{ ...r.set, ref: 'lib_0000000000other' }]).drift;
    expect(other[0]!.status).toBe('update');

    const waiting = statuses((r) => [r.set, { ...r.cast, staged: 'pending', why: 'missing' }, r.el]).drift;
    expect(waiting.map((d) => d.status)).toEqual(['current', 'pending', 'current']);
    expect(deskUnitBadge(waiting)).toMatchObject({ status: 'pending', text: '3D: waiting' });
    expect(deskUnitBadge(waiting)!.title).toContain(
      'Mira: Mira figure v2 waiting (it was not sent to the desk)',
    );

    const refused = statuses((r) => [{ ...r.set, staged: 'refused', why: 'too_large' }, r.cast, r.el]).drift;
    expect(refused[0]!.status).toBe('refused');
    expect(deskUnitBadge(refused)).toMatchObject({ status: 'refused', text: "3D: can't use Harbor v3" });
    expect(deskUnitBadge(refused)!.title).toContain("Harbor: can't use Harbor v3 (it is over 32 MiB)");
  });

  it('keeps a slot made local local whatever its pin becomes: the desk never puts a unit back in it', () => {
    // made local at v2 of the place's set, then v3 pinned; made local from another figure than Mira's pin
    const moved = statuses((r) => [
      { ...r.set, version: 2, local: true },
      { ...r.cast, ref: 'lib_0000000000other', local: true },
      r.el,
    ]).drift;
    expect(moved.map((d) => d.status)).toEqual(['local', 'local', 'current']);
    expect(deskUnitBadge(moved)).toBeNull();
    expect(moved.map(deskUnitDriftLine)).toEqual([
      'Harbor: made local in the desk (from Harbor v2); Harbor v3 is pinned now',
      'Mira: made local in the desk (from another unit); Mira figure v2 is pinned now',
      'Oil lamp: Brass lamp v1, up to date',
    ]);
    // at the pinned version, as before
    const same = statuses((r) => [{ ...r.set, local: true }]).drift;
    expect(deskUnitDriftLine(same[0]!)).toBe('Harbor: made local in the desk (from Harbor v3)');
    // an approved clip's slot made local is local too
    const approved = statuses((r) => [{ ...r.set, version: 2, local: true }], 'approved').drift;
    expect(approved[0]!.status).toBe('local');
  });

  it("says what the desk's refusals mean: one unit too large for a staging, a figure that does not fit the actor", () => {
    const line = (row: 'set' | 'cast', why: string) =>
      deskUnitDriftLine(
        statuses((r) => [
          { ...r.set, ...(row === 'set' ? { staged: 'refused', why } : {}) },
          { ...r.cast, ...(row === 'cast' ? { staged: 'refused', why } : {}) },
          r.el,
        ]).drift[row === 'set' ? 0 : 1]!,
      );
    // a unit whose own size never fits one staging: not the scene's units together (those wait, unavailable)
    expect(line('set', 'over_budget')).toBe(
      "Harbor: can't use Harbor v3 (it is larger than one desk staging takes)",
    );
    // the actor the desk staged for the member stays: a figure of another kind or rig or height is refused
    expect(line('cast', 'figure_kind')).toBe(
      "Mira: can't use Mira figure v2 (the figure is not of the staged actor's kind (or of a kind the desk does not build))",
    );
    expect(line('cast', 'figure_rig')).toBe(
      "Mira: can't use Mira figure v2 (the figure does not fit the staged actor's rig or height (±5 mm))",
    );
  });

  it("names the first slot that needs attention: can't use, waiting, available, approved", () => {
    const all = statuses((r) => [
      { ...r.set, version: 1 },
      { ...r.cast, staged: 'pending', why: 'unavailable' },
      { ...r.el, staged: 'refused', why: 'wrong_kind' },
    ]).drift;
    expect(all.map((d) => d.status)).toEqual(['update', 'pending', 'refused']);
    expect(deskUnitBadge(all)).toMatchObject({ status: 'refused', text: "3D: can't use Brass lamp v1" });
    expect(deskUnitBadge(all.filter((d) => d.status !== 'refused'))!.text).toBe('3D: waiting');
    expect(deskUnitBadge(all.filter((d) => d.status === 'update'))!.text).toBe('3D: v3 available');
    // every pinned slot in the tooltip, one line each
    expect(deskUnitBadge(all)!.title.split('\n')).toHaveLength(3);
  });

  it('keeps an approved clip on what it uses: approved, never an update', () => {
    const { drift } = statuses((r) => [{ ...r.set, version: 2 }, r.cast], 'approved');
    expect(drift.map((d) => d.status)).toEqual(['approved', 'current', 'approved']);
    expect(deskUnitBadge(drift)).toMatchObject({ status: 'approved', text: 'approved: keeps v2' });
    const pending = statuses((r) => [{ ...r.set, staged: 'pending', why: 'missing' }], 'approved').drift;
    // an approved clip whose state holds the pin pending keeps it: nothing will stage it
    expect(pending[0]!.status).toBe('approved');
    expect(deskUnitBadge([pending[2]!])!.text).toBe('approved: keeps its staging');
  });

  it('is unknown for a state without units, and has no rows for a clip without a stored state', () => {
    for (const units of [null, undefined] as const) {
      const s = scene(units === null ? { units: null } : {});
      const drift = deskUnitDrift(s.docs, s.clip.id);
      expect(drift.map((d) => d.status)).toEqual(['unknown', 'unknown', 'unknown']);
      expect(deskUnitBadge(drift)).toBeNull();
    }
    const none = scene({ deskState: false });
    expect(deskUnitDrift(none.docs, none.clip.id)).toEqual([]);
    for (const id of ['constructor', '__proto__', 'clp_00000000000none'])
      expect(deskUnitDrift(none.docs, id)).toEqual([]);
  });
});

describe('deskStateUses: what the stored states use, in the digest (docs/design/library.md#where-it-is-used)', () => {
  it('counts the clips whose stored state uses a version (staged unit, not local), and the approved ones', () => {
    const row = (ref: string, version: number, over: Partial<DeskStateUnitUse> = {}): DeskStateUnitUse => ({
      slot: `el:${ref}${version}`,
      ref,
      version,
      staged: 'unit',
      local: false,
      ...over,
    });
    const state = (units: DeskStateUnitUse[] | null) => ({
      format: '3d-editor.desk-state',
      version: 1,
      media: f.media(),
      updatedAt: '2026-11-02T10:00:00.000Z',
      units,
    });
    const clips = f.byId([
      f.clip({
        deskState: state([row(SET, 3, { slot: 'set' }), row(PROP, 1), row(PROP, 1, { slot: 'el:other' })]),
      }),
      f.clip({ status: 'approved', deskState: state([row(SET, 3, { slot: 'set' }), row(SET, 2)]) }),
      f.clip({
        deskState: state([
          row(FIGURE, 1, { local: true }),
          row(FIGURE, 2, { staged: 'pending', why: 'missing' }),
          row(FIGURE, 3, { staged: 'refused', why: 'too_new' }),
          // a ref that is no library item of this studio
          row('chr_notalibraryitem', 1),
        ]),
      }),
      f.clip({ deskState: state(null) }),
      f.clip({ deskState: null }),
    ]);
    const uses = deskStateUses(clips);
    const by = (itemId: string, version: number) =>
      uses.find((u) => u.itemId === itemId && u.version === version);
    expect(by(SET, 3)).toEqual({ itemId: SET, version: 3, via: 'deskState', clips: 2, approved: 1 });
    expect(by(SET, 2)).toEqual({ itemId: SET, version: 2, via: 'deskState', clips: 1, approved: 1 });
    // two slots of one clip using the same version: one clip
    expect(by(PROP, 1)).toEqual({ itemId: PROP, version: 1, via: 'deskState', clips: 1, approved: 0 });
    expect(uses.filter((u) => u.itemId === FIGURE)).toEqual([]);
    expect(uses).toHaveLength(3);

    // the project's digest rows: links, pins and what the stored states use, sorted
    const s = scene({ units: [] });
    const docs = { ...s.docs, clips: { ...s.docs.clips, ...clips } };
    const rows = libraryUses(docs);
    expect(rows.filter((u) => u.via === 'deskState')).toEqual(
      [by(PROP, 1), by(SET, 2), by(SET, 3)].sort((a, b) =>
        a!.itemId < b!.itemId ? -1 : a!.itemId > b!.itemId ? 1 : a!.version - b!.version,
      ),
    );
    expect(
      rows
        .filter((u) => u.via === 'deskUnit')
        .map((u) => u.itemId)
        .sort(),
    ).toEqual([FIGURE, PROP, SET].sort());
    // libraryUses without clips (R1's callers before the clips were passed) still works
    const { clips: _clips, ...withoutClips } = docs;
    expect(libraryUses(withoutClips).some((u) => u.via === 'deskState')).toBe(false);
  });

  it('maps each unit file kind to its library kind', () => {
    expect(DESK_UNIT_LIBRARY_KIND).toEqual({ set: 'desk-set', prop: 'desk-prop', figure: 'desk-figure' });
  });
});

describe('deskUnitPinsToSend: the files of an open (docs/design/director-desk.md#unit-bytes-in-open)', () => {
  const slot = (
    slot: string,
    kind: DeskBriefPinSlot['kind'],
    ref: string,
    version: number,
  ): DeskBriefPinSlot => ({
    slot,
    kind,
    pin: { ref, version, sha256: 'd'.repeat(64) },
  });
  const pins = [
    slot('set', 'set', SET, 3),
    slot('cast:a', 'figure', FIGURE, 2),
    slot('cast:b', 'figure', FIGURE, 2),
    slot('el:lamp', 'prop', PROP, 1),
  ];
  const use = (
    s: string,
    ref: string,
    version: number,
    over: Partial<DeskStateUnitUse> = {},
  ): DeskStateUnitUse => ({
    slot: s,
    ref,
    version,
    staged: 'unit',
    local: false,
    ...over,
  });

  it('sends every pin once per version, in slot order, when what the state uses is not known', () => {
    for (const uses of [null, undefined, []])
      expect(deskUnitPinsToSend(pins, uses).map((p) => p.slot)).toEqual(['set', 'cast:a', 'el:lamp']);
  });

  it('leaves out the pins whose slot the state already holds at that version, staged unit (made local too)', () => {
    const uses = [use('set', SET, 3), use('cast:a', FIGURE, 2, { local: true }), use('el:lamp', PROP, 1)];
    // cast:b has no row (a member new to the scene): the figure goes for it
    expect(deskUnitPinsToSend(pins, uses).map((p) => p.slot)).toEqual(['cast:b']);
    // another version, another item, pending or refused: the file goes again
    const other = [
      use('set', SET, 2),
      use('cast:a', 'lib_0000000000other', 2),
      use('cast:b', FIGURE, 2, { staged: 'pending', why: 'missing' }),
      use('el:lamp', PROP, 1, { staged: 'refused', why: 'unreadable' }),
    ];
    expect(deskUnitPinsToSend(pins, other).map((p) => p.slot)).toEqual(['set', 'cast:a', 'el:lamp']);
  });

  it('leaves out a slot made local whatever its pin is now: the desk never places a unit in it again', () => {
    // the set made local at v2 and pinned at v3 since; cast:a made local from another item than its pin
    const uses = [
      use('set', SET, 2, { local: true }),
      use('cast:a', 'lib_0000000000other', 2, { local: true }),
    ];
    // cast:b pins the same figure version and is not local: that file still goes, for cast:b
    expect(deskUnitPinsToSend(pins, uses).map((p) => p.slot)).toEqual(['cast:b', 'el:lamp']);
    // as the header says it: the set made local at v1, the place's pin moved to v2
    expect(
      deskUnitPinsToSend([slot('set', 'set', SET, 2)], parseDeskStateUnits(`set=${SET}@1:unit:local`)),
    ).toEqual([]);
  });
});
