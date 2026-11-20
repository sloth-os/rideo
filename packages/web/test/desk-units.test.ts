import { createHash } from 'node:crypto';
import {
  type DeskBriefPinSlot,
  type DeskUnitPin,
  type DeskUnitPublishMessage,
  deskUnitPinsToSend,
  LibraryUploadMetaSchema,
  ProjectSettingsSchema,
  parseDeskStateUnits,
  type Scene,
} from '@rideo/shared';
import * as f from '@rideo/shared/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DESK_UNIT_FETCH_IDLE_MS,
  type DeskApiFetch,
  type DeskPublishContext,
  deskPublishAllowed,
  deskPublishRefusal,
  deskUnitHeader,
  fetchDeskUnits,
  publishDeskUnit,
} from '../src/features/desk/units';
import { ApiError } from '../src/lib/api';

/** Library units in the desk, the studio's side (docs/design/director-desk.md#library-units), with a mocked library. */

const sha = (data: ArrayBuffer | Uint8Array) =>
  createHash('sha256')
    .update(data instanceof Uint8Array ? data : new Uint8Array(data))
    .digest('hex');

/** A unit file as the 3D-Editor writes one: `3DUNIT\r\n`, container 1, the header's length at 12, its JSON at 16. */
function unitFile(kind: 'set' | 'prop' | 'figure', body: string, version = 1): ArrayBuffer {
  const json = new TextEncoder().encode(JSON.stringify({ format: '3d-editor.desk-unit', version, kind }));
  const out = new Uint8Array(16 + json.length + body.length);
  out.set(new TextEncoder().encode('3DUNIT\r\n'), 0);
  out[8] = 1;
  new DataView(out.buffer).setUint32(12, json.length, true);
  out.set(json, 16);
  out.set(new TextEncoder().encode(body), 16 + json.length);
  return out.buffer;
}

const slot = (s: string, kind: DeskBriefPinSlot['kind'], ref: string, data: ArrayBuffer, version = 1) => ({
  slot: s,
  kind,
  pin: { ref, version, sha256: sha(data) },
});

/** A library whose files are these (a number: the status it answers), each answering after `delays[ref]` ms. */
function library(files: Record<string, ArrayBuffer | number>, delays: Record<string, number> = {}) {
  const requests: string[] = [];
  let inFlight = 0;
  let most = 0;
  const fetch: DeskApiFetch = async (path, init) => {
    requests.push(path);
    inFlight += 1;
    most = Math.max(most, inFlight);
    try {
      const ref = /\/library\/items\/([^/]+)\//.exec(path)?.[1] ?? '';
      await new Promise((r) => setTimeout(r, delays[ref] ?? 1));
      if (init?.signal?.aborted) throw new DOMException('aborted', 'AbortError');
      const file = files[ref];
      if (file === undefined) return new Response('{"code":"not_found"}', { status: 404 });
      if (typeof file === 'number') return new Response('', { status: file });
      return new Response(new Uint8Array(file), { status: 200 });
    } finally {
      inFlight -= 1;
    }
  };
  return { fetch, requests, most: () => most };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('the files of an open (docs/design/director-desk.md#unit-bytes-in-open)', () => {
  it('fetches them 2 at a time from the file route, checks their sha256 and keeps slot order', async () => {
    const set = unitFile('set', 'harbor');
    const mira = unitFile('figure', 'mira', 2);
    const lamp = unitFile('prop', 'lamp');
    const crate = unitFile('prop', 'crate');
    const lib = library({ lib_set: set, lib_mira: mira, lib_lamp: lamp, lib_crate: crate });
    const progress: [number, number][] = [];
    const pins = [
      slot('set', 'set', 'lib_set', set, 3),
      slot('cast:mira', 'figure', 'lib_mira', mira, 2),
      slot('el:lamp', 'prop', 'lib_lamp', lamp),
      slot('el:crate', 'prop', 'lib_crate', crate),
    ];
    const got = await fetchDeskUnits(pins, {
      fetch: lib.fetch,
      onProgress: (d, t) => progress.push([d, t]),
    });
    expect(lib.requests[0]).toBe(`/library/items/lib_set/versions/3/files/${sha(set)}`);
    expect(lib.most()).toBe(2);
    expect(got.left).toEqual([]);
    expect(got.units.map((u) => [u.ref, u.version, u.sha256])).toEqual([
      ['lib_set', 3, sha(set)],
      ['lib_mira', 2, sha(mira)],
      ['lib_lamp', 1, sha(lamp)],
      ['lib_crate', 1, sha(crate)],
    ]);
    // the format and version its header names
    expect(got.units[1]!.unit).toMatchObject({ format: '3d-editor.desk-unit', version: 2 });
    expect(sha(got.units[0]!.unit.data)).toBe(sha(set));
    expect(progress.at(-1)).toEqual([4, 4]);
  });

  it('leaves out a file that does not match, does not come, or that the library answers otherwise', async () => {
    const set = unitFile('set', 'harbor');
    const lamp = unitFile('prop', 'lamp');
    const other = unitFile('prop', 'not the pinned bytes');
    const lib = library({ lib_set: 503, lib_lamp: lamp, lib_odd: other });
    const got = await fetchDeskUnits(
      [
        slot('set', 'set', 'lib_set', set),
        slot('el:gone', 'prop', 'lib_gone', lamp),
        { ...slot('el:odd', 'prop', 'lib_odd', lamp) },
        slot('el:lamp', 'prop', 'lib_lamp', lamp),
      ],
      { fetch: lib.fetch },
    );
    expect(got.units.map((u) => u.ref)).toEqual(['lib_lamp']);
    expect(got.left.map((l) => [l.slot, l.why])).toEqual([
      ['set', 'failed'],
      ['el:gone', 'failed'],
      ['el:odd', 'mismatch'],
    ]);
    // offline: every fetch fails, and the open goes on without them
    const offline = await fetchDeskUnits([slot('set', 'set', 'lib_set', set)], {
      fetch: async () => {
        throw new TypeError('Failed to fetch');
      },
    });
    expect(offline).toEqual({ units: [], left: [expect.objectContaining({ slot: 'set', why: 'failed' })] });
  });

  it('never passes 48 MiB: the first file that would, and every one after it, is left out', async () => {
    const big = (n: number, tag: string) => {
      const data = new Uint8Array(n);
      data.set(new TextEncoder().encode(tag));
      return data.buffer;
    };
    const mib = 1024 * 1024;
    const a = big(20 * mib, 'a');
    const b = big(20 * mib, 'b');
    const c = big(10 * mib, 'c');
    const d = big(1 * mib, 'd');
    const lib = library({ lib_a: a, lib_b: b, lib_c: c, lib_d: d });
    const got = await fetchDeskUnits(
      [
        slot('set', 'set', 'lib_a', a),
        slot('el:b', 'prop', 'lib_b', b),
        slot('el:c', 'prop', 'lib_c', c),
        slot('el:d', 'prop', 'lib_d', d),
      ],
      { fetch: lib.fetch },
    );
    expect(got.units.map((u) => u.ref)).toEqual(['lib_a', 'lib_b']);
    // c would pass 48 MiB: it and d (which would fit) are left out
    expect(got.left.map((l) => [l.slot, l.why])).toEqual([
      ['el:c', 'over_budget'],
      ['el:d', 'over_budget'],
    ]);
    const total = got.units.reduce((n, u) => n + u.unit.data.byteLength, 0);
    expect(total).toBeLessThanOrEqual(48 * mib);

    // once the cut is known no fetch starts after it (a budget of 100 bytes: 60 + 60 cuts at the second file, while
    // the third is still on its way; the fourth never starts)
    const e = big(60, 'e');
    const g = big(60, 'g');
    const small = big(10, 's');
    const two = library(
      { lib_e: e, lib_g: g, lib_s1: small, lib_s2: small },
      { lib_e: 1, lib_g: 10, lib_s1: 200, lib_s2: 1 },
    );
    const cut = await fetchDeskUnits(
      [
        slot('set', 'set', 'lib_e', e),
        slot('el:g', 'prop', 'lib_g', g),
        slot('el:s1', 'prop', 'lib_s1', small),
        slot('el:s2', 'prop', 'lib_s2', small),
      ],
      { fetch: two.fetch, budget: 100 },
    );
    expect(cut.units.map((u) => u.ref)).toEqual(['lib_e']);
    expect(cut.left.map((l) => l.why)).toEqual(['over_budget', 'over_budget', 'over_budget']);
    expect(two.requests.map((r) => /items\/([^/]+)/.exec(r)?.[1])).toEqual(['lib_e', 'lib_g', 'lib_s1']);
  });

  it('fetches no file for a slot made local, which so takes no share of the 48 MiB from a slot that needs one', async () => {
    // the set made local at v1, the place's pin moved to v2 since; Mira's figure is not staged yet (a budget of 100
    // bytes for 48 MiB, 60-byte files for a 30 MiB set and a 20 MiB figure)
    const file = (tag: string) => {
      const data = new Uint8Array(60);
      data.set(new TextEncoder().encode(tag));
      return data.buffer;
    };
    const setV2 = file('set v2');
    const mira = file('mira figure');
    const lib = library({ lib_set: setV2, lib_mira: mira });
    const pins = deskUnitPinsToSend(
      [slot('set', 'set', 'lib_set', setV2, 2), slot('cast:chr_mira', 'figure', 'lib_mira', mira)],
      parseDeskStateUnits('set=lib_set@1:unit:local'),
    );
    const got = await fetchDeskUnits(pins, { fetch: lib.fetch, budget: 100 });
    expect(got.units.map((u) => [u.ref, u.version])).toEqual([['lib_mira', 1]]);
    expect(got.left).toEqual([]);
    expect(lib.requests).toEqual(['/library/items/lib_mira/versions/1/files/' + sha(mira)]);
  });

  it('leaves out a file that sends nothing for 30 seconds, and stops all when told to', async () => {
    vi.useFakeTimers();
    const set = unitFile('set', 'harbor');
    const stalled: DeskApiFetch = (_path, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    const pending = fetchDeskUnits([slot('set', 'set', 'lib_set', set)], { fetch: stalled });
    await vi.advanceTimersByTimeAsync(DESK_UNIT_FETCH_IDLE_MS - 1);
    let done = false;
    void pending.then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect((await pending).left).toEqual([expect.objectContaining({ why: 'timeout' })]);

    const stop = new AbortController();
    const cancelled = fetchDeskUnits(
      [slot('set', 'set', 'lib_set', set), slot('el:b', 'prop', 'lib_b', set, 2)],
      { fetch: stalled, signal: stop.signal },
    );
    stop.abort();
    expect((await cancelled).left.map((l) => l.why)).toEqual(['cancelled', 'cancelled']);
  });

  it("reads a unit file's header, and nothing from bytes that are not one", () => {
    expect(deskUnitHeader(unitFile('set', 'x', 3))).toEqual({ format: '3d-editor.desk-unit', version: 3 });
    expect(deskUnitHeader(new TextEncoder().encode('a short text, not a unit file').buffer)).toBeNull();
  });
});

// ---------------------------------------------------------------- publishing and linking

const PIN_OF = (itemId: string, name: string, kind: DeskUnitPin['kind'] = 'desk-set'): DeskUnitPin => ({
  kind,
  itemId,
  version: 1,
  sha256: 'e'.repeat(64),
  name,
  actorKind: null,
  heightM: null,
  pinnedAt: '2026-11-01T10:00:00.000Z',
  pinnedBy: { kind: 'user', id: 'usr_1', name: 'Ada' },
});

function project(opts: { harborPin?: DeskUnitPin | null; place?: boolean } = {}) {
  const harbor = f.element({ kind: 'location', name: 'Harbor', deskUnit: opts.harborPin ?? null });
  const mira = f.character({ name: 'Mira' });
  const lamp = f.element({ kind: 'prop', name: 'Oil lamp' });
  const scene: Scene = {
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
    locationId: opts.place === false ? null : harbor.id,
    elementIds: [lamp.id],
    estDurationSec: 10,
    continuity: '',
  };
  const clip = f.clip({ sceneId: scene.id, shots: [f.shot({ characterIds: [mira.id] })] });
  const docs = f.docs({
    project: f.project({ settings: ProjectSettingsSchema.parse({}) }),
    screenplay: f.screenplay({ scenes: [scene] }),
    characters: f.byId([mira]),
    elements: f.byId([harbor, lamp]),
    clips: f.byId([clip]),
  });
  return { docs, clip, harbor, mira, lamp };
}

function publishMessage(over: Partial<DeskUnitPublishMessage> = {}): DeskUnitPublishMessage {
  const data = unitFile('set', 'harbor v1');
  return {
    type: 'unit-publish',
    id: 'pub-1',
    kind: 'set',
    name: 'Harbor',
    description: 'The docks at dawn',
    from: { castId: null, elementId: null, set: true },
    unit: { format: '3d-editor.desk-unit', version: 1, data },
    sha256: sha(data),
    thumbnail: null,
    meta: {
      dimensionsM: [40, 30, 12],
      objects: 22,
      triangles: 48_000,
      actor: null,
      credits: [],
      deskVersion: '1.4.0',
      digest: 'c'.repeat(64),
    },
    ...over,
  } as DeskUnitPublishMessage;
}

/** The library's REST answers: an upload (create or version) and the apply, each request recorded. */
function libraryApi(
  opts: {
    upload?: (
      path: string,
      meta: Record<string, unknown>,
      payload: ArrayBuffer,
    ) => Response | Promise<Response>;
    apply?: (body: Record<string, unknown>) => Response;
  } = {},
) {
  const calls: {
    path: string;
    method: string;
    meta?: Record<string, unknown>;
    body?: Record<string, unknown>;
  }[] = [];
  const fetch: DeskApiFetch = async (path, init = {}) => {
    if (path.endsWith('/library/apply')) {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      calls.push({ path, method: String(init.method), body });
      return opts.apply?.(body) ?? Response.json({ applied: true });
    }
    const form = init.body as FormData;
    const meta = JSON.parse(String(form.get('meta'))) as Record<string, unknown>;
    const payload = await (form.get('payload') as Blob).arrayBuffer();
    calls.push({ path, method: String(init.method), meta });
    if (opts.upload) return opts.upload(path, meta, payload);
    const version = typeof meta.basedOn === 'number' ? meta.basedOn + 1 : 1;
    return Response.json(
      {
        item: {
          id: path.includes('/versions') ? 'lib_0000000000harbor' : 'lib_0000000000newset',
          name: 'Harbor',
        },
        version: { version, digest: sha(payload) },
        unchanged: false,
      },
      { status: 201 },
    );
  };
  return { fetch, calls };
}

const problem = (status: number, code: string, detail: string, errors?: unknown[]) =>
  Response.json(
    { status, code, detail, title: code, type: 'about:blank', ...(errors ? { errors } : {}) },
    { status },
  );

const ctx = (
  docs: ReturnType<typeof project>['docs'],
  clipId: string,
  over: Partial<DeskPublishContext> = {},
) => ({
  projectId: 'prj_0000000000000001',
  clipId,
  readOnly: false,
  mayEdit: true,
  docs: () => docs,
  ...over,
});

describe('a unit-publish (docs/design/director-desk.md#publishing-and-linking)', () => {
  it("creates an item, links the scene's place with one apply that never replaces a pin, and acks linked", async () => {
    const { docs, clip, harbor } = project();
    const api = libraryApi();
    const out = await publishDeskUnit(publishMessage(), ctx(docs, clip.id), { fetch: api.fetch });
    expect(api.calls.map((c) => [c.method, c.path])).toEqual([
      ['POST', '/library/items'],
      ['POST', '/projects/prj_0000000000000001/library/apply'],
    ]);
    expect(api.calls[0]!.meta).toEqual({
      kind: 'desk-set',
      name: 'Harbor',
      description: 'The docks at dawn',
      unit: { format: '3d-editor.desk-unit', formatVersion: 1, meta: publishMessage().meta },
    });
    expect(api.calls[1]!.body).toEqual({
      itemId: 'lib_0000000000newset',
      version: 1,
      target: { kind: 'element', id: harbor.id },
      replacePin: false,
    });
    expect(out.ack).toEqual({
      type: 'unit-ack',
      id: 'pub-1',
      ok: true,
      ref: 'lib_0000000000newset',
      version: 1,
      linked: true,
    });
    expect(out).toMatchObject({
      notice: "Saved Harbor v1 to the library; linked to the scene's place (Harbor)",
      level: 'success',
    });
  });

  it('saves a new version on the one it was made from (basedOn), and moves the pin of the same item', async () => {
    const { docs, clip } = project({ harborPin: PIN_OF('lib_0000000000harbor', 'Harbor') });
    const api = libraryApi();
    const out = await publishDeskUnit(
      publishMessage({ newVersionOf: { ref: 'lib_0000000000harbor', version: 1 } }),
      ctx(docs, clip.id),
      { fetch: api.fetch },
    );
    expect(api.calls[0]!.path).toBe('/library/items/lib_0000000000harbor/versions');
    // a version is not a new item: the item keeps its name, and the description is the version's note
    expect(api.calls[0]!.meta).toEqual({
      kind: 'desk-set',
      unit: { format: '3d-editor.desk-unit', formatVersion: 1, meta: publishMessage().meta },
      basedOn: 1,
      note: 'The docks at dawn',
    });
    expect(LibraryUploadMetaSchema.safeParse(api.calls[0]!.meta).success).toBe(true);
    expect(api.calls[1]!.body).toMatchObject({ itemId: 'lib_0000000000harbor', version: 2 });
    expect(out.ack).toMatchObject({ ok: true, ref: 'lib_0000000000harbor', version: 2, linked: true });

    // a note is at most the library's 500 characters, never cut inside a character; no description, no note
    const version = (description: string | undefined) => async () => {
      const lib = libraryApi();
      await publishDeskUnit(
        publishMessage({ newVersionOf: { ref: 'lib_0000000000harbor', version: 1 }, description }),
        ctx(docs, clip.id),
        { fetch: lib.fetch },
      );
      return lib.calls[0]!.meta!;
    };
    const long = await version(`${'x'.repeat(499)}🏮 and a lamp post by the steps`)();
    expect(long.note).toBe('x'.repeat(499));
    expect(LibraryUploadMetaSchema.safeParse(long).success).toBe(true);
    expect(await version('  added a lamp post  ')()).toMatchObject({ note: 'added a lamp post' });
    for (const none of [undefined, '', '   ']) expect(await version(none)()).not.toHaveProperty('note');
  });

  it('says so when the bytes are the current version already, and links that version', async () => {
    const { docs, clip } = project();
    const api = libraryApi({
      upload: (_p, _m, payload) =>
        Response.json({
          item: { id: 'lib_0000000000harbor', name: 'Harbor' },
          version: { version: 3, digest: sha(payload) },
          unchanged: true,
        }),
    });
    const out = await publishDeskUnit(
      publishMessage({ newVersionOf: { ref: 'lib_0000000000harbor', version: 3 } }),
      ctx(docs, clip.id),
      { fetch: api.fetch },
    );
    expect(out.ack).toMatchObject({ ok: true, version: 3, linked: true });
    expect(out.notice).toBe("Harbor v3 is already in the library; linked to the scene's place (Harbor)");
  });

  it("never links a read-only open, a person who may not edit, another item's pin or a scene without a place", async () => {
    const cases: [string, Partial<DeskPublishContext>, ReturnType<typeof project>, string][] = [
      ['read-only', { readOnly: true }, project(), 'the scene is read-only'],
      ['no edit', { mayEdit: false }, project(), 'you may not edit this project'],
      [
        'pinned',
        {},
        project({ harborPin: PIN_OF('lib_0000000000oldharbor', 'Old harbor') }),
        'Harbor uses another library set (Old harbor)',
      ],
      ['no place', {}, project({ place: false }), 'the scene has no place'],
    ];
    for (const [name, over, p, reason] of cases) {
      const api = libraryApi();
      const out = await publishDeskUnit(publishMessage(), ctx(p.docs, p.clip.id, over), { fetch: api.fetch });
      // published all the same, never linked: no apply
      expect(
        api.calls.map((c) => c.path),
        name,
      ).toEqual(['/library/items']);
      expect(out.ack, name).toMatchObject({ ok: true, linked: false, message: reason });
      expect(out.notice, name).toBe(`Saved Harbor v1 to the library; not linked: ${reason}`);
    }
    // someone pinned another item meanwhile: the apply's 409 is the rule again
    const { docs, clip } = project();
    const api = libraryApi({
      apply: () =>
        problem(409, 'conflict', 'Harbor uses another library set (Quay)', [
          { reason: 'pinned', itemId: 'lib_0000000000quay' },
        ]),
    });
    const out = await publishDeskUnit(publishMessage(), ctx(docs, clip.id), { fetch: api.fetch });
    expect(out.ack).toMatchObject({
      ok: true,
      linked: false,
      message: 'Harbor uses another library set (Quay)',
    });
  });

  it('links a figure to its character and a prop to its element', async () => {
    const { docs, clip, mira, lamp } = project();
    for (const [from, kind, target, label] of [
      [
        { castId: mira.id, elementId: null, set: false },
        'figure',
        { kind: 'character', id: mira.id },
        'Mira',
      ],
      [
        { castId: null, elementId: lamp.id, set: false },
        'prop',
        { kind: 'element', id: lamp.id },
        'Oil lamp',
      ],
    ] as const) {
      const data = unitFile(kind, `${kind} bytes`);
      const api = libraryApi();
      const out = await publishDeskUnit(
        publishMessage({
          kind,
          from,
          unit: { format: '3d-editor.desk-unit', version: 1, data },
          sha256: sha(data),
        }),
        ctx(docs, clip.id),
        { fetch: api.fetch },
      );
      expect(api.calls[0]!.meta).toMatchObject({ kind: `desk-${kind}` });
      expect(api.calls[1]!.body).toMatchObject({ target });
      expect(out.notice).toMatch(new RegExp(`linked to ${label}$`));
    }
  });

  it('refuses bytes that do not hash to the sha256, and maps what the library answered to a code', async () => {
    const { docs, clip } = project();
    const api = libraryApi();
    const bad = await publishDeskUnit(publishMessage({ sha256: 'f'.repeat(64) }), ctx(docs, clip.id), {
      fetch: api.fetch,
    });
    expect(bad.ack).toMatchObject({ ok: false, code: 'invalid' });
    expect(api.calls).toEqual([]);

    const answers: [Response | Error, string, string?][] = [
      [
        problem(
          412,
          'library_conflict',
          'Harbor has a later version (v3) than the one this was made from (v2)',
        ),
        'conflict',
        'v3',
      ],
      [problem(413, 'validation_error', 'a 3D unit is at most 32 MiB'), 'too_large'],
      [problem(422, 'validation_error', 'not a 3D unit file: it is too short'), 'invalid'],
      [problem(422, 'consent_required', 'confirm the consent'), 'invalid'],
      [problem(403, 'forbidden', 'agent tokens limited to projects cannot publish'), 'refused'],
      [problem(503, 'storage_error', 'the library storage is down'), 'unavailable'],
      [problem(500, 'internal_error', 'boom'), 'failed'],
      [new TypeError('Failed to fetch'), 'unavailable'],
    ];
    for (const [answer, code, says] of answers) {
      const lib = libraryApi({
        upload: () => {
          if (answer instanceof Error) throw answer;
          return answer.clone();
        },
      });
      const out = await publishDeskUnit(publishMessage(), ctx(docs, clip.id), { fetch: lib.fetch });
      expect(out.ack, code).toMatchObject({ type: 'unit-ack', id: 'pub-1', ok: false, code });
      if (says) expect(out.ack.message).toContain(says);
      expect(out.notice.startsWith('Not saved to the library: ')).toBe(true);
      expect(lib.calls.filter((c) => c.path.endsWith('/apply'))).toEqual([]);
    }
    // the library stored other bytes than the desk sent
    const other = libraryApi({
      upload: () =>
        Response.json(
          {
            item: { id: 'lib_0000000000newset', name: 'Harbor' },
            version: { version: 1, digest: 'a'.repeat(64) },
          },
          { status: 201 },
        ),
    });
    expect(
      (await publishDeskUnit(publishMessage(), ctx(docs, clip.id), { fetch: other.fetch })).ack,
    ).toMatchObject({
      ok: false,
      code: 'invalid',
    });
  });

  it('maps errors as the contract says: offline is unavailable', () => {
    expect(deskPublishRefusal(new ApiError(412, { code: 'library_conflict' } as never))).toBe('conflict');
    expect(deskPublishRefusal(new ApiError(409, { code: 'conflict' } as never))).toBe('failed');
    vi.stubGlobal('navigator', { onLine: false });
    expect(deskPublishRefusal(new Error('anything'))).toBe('unavailable');
  });
});

describe('who may publish (open.options.units.publish)', () => {
  it('follows libraryAllows for the signed-in principal', () => {
    expect(deskPublishAllowed(null)).toBe(true);
    const person = {
      mode: 'oidc' as const,
      provider: 'Sign in',
      user: { id: 'usr_1', name: 'Ada', email: 'ada@example.com' } as never,
      token: null,
      admin: false,
    };
    expect(deskPublishAllowed(person)).toBe(true);
    expect(deskPublishAllowed({ ...person, token: { id: 'tok_1', name: 'agent', role: 'editor' } })).toBe(
      true,
    );
    expect(deskPublishAllowed({ ...person, token: { id: 'tok_1', name: 'agent', role: 'reviewer' } })).toBe(
      false,
    );
  });
});
