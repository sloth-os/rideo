import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type Actor,
  type AgentToken,
  type Character,
  type Clip,
  characterSnapshot,
  type Element,
  isRealPersonSnapshot,
  type LibraryItem,
  LibraryUploadMetaSchema,
  type LibraryVersion,
  libraryDigest,
  newId,
  type ProjectAccess,
  ProjectAccessSchema,
} from '@rideo/shared';
import * as f from '@rideo/shared/testing';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type Principal, principalContext } from '../../src/auth/context';
import { loadConfig } from '../../src/config';
import { elementIdentityHash } from '../../src/domain/elements';
import type { LibraryUploadFiles } from '../../src/domain/library';
import { DESK_UNIT_MAGIC } from '../../src/domain/library-files';
import { LibraryStore } from '../../src/domain/library-store';
import { identityHash } from '../../src/domain/story';
import { createStudio, type Studio } from '../../src/domain/studio';
import type { StorageBackend } from '../../src/storage/backend';
import { FsBackend } from '../../src/storage/fs';
import { Layout } from '../../src/storage/layout';
import { MemoryBackend } from '../../src/storage/memory';
import { sha256 } from '../../src/util/crypto';

/** The studio library's store and service (docs/design/library.md#storage, #versions, #permissions). */

const quiet = () => {
  const log = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: () => log,
  };
  return log;
};
const NOW = '2026-11-20T10:00:00.000Z';
const author = { kind: 'user' as const, id: 'local', name: 'You' };
const actor: Actor = author;
const dirs: string[] = [];
const tmpDir = async () => {
  const d = await mkdtemp(join(tmpdir(), 'rideo-lib-'));
  dirs.push(d);
  return d;
};
afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

/** A 3D unit file: `3DUNIT` CR LF, container version 1, codec 0, the header's length and the JSON header. */
export function unitFile(
  kind: 'set' | 'prop' | 'figure',
  body = 'body',
  header: Record<string, unknown> = {},
) {
  const json = Buffer.from(
    JSON.stringify({ format: '3d-editor.desk-unit', version: 1, kind, name: 'Harbor', ...header }),
  );
  const prefix = Buffer.alloc(16);
  DESK_UNIT_MAGIC.copy(prefix, 0);
  prefix[8] = 1;
  prefix[9] = 0;
  prefix.writeUInt32LE(json.length, 12);
  return Buffer.concat([prefix, json, Buffer.from(body)]);
}

const META = {
  dimensionsM: [12, 8, 4],
  objects: 14,
  triangles: 20_000,
  actor: null,
  credits: [],
  deskVersion: '1.4.0',
  digest: 'a'.repeat(64),
};

function versionOf(itemId: string, n: number, hash: string): LibraryVersion {
  return {
    itemId,
    version: n,
    kind: 'desk-set',
    digest: hash,
    payload: {
      format: '3d-editor.desk-unit',
      formatVersion: 1,
      payload: { hash, mime: 'application/octet-stream', size: 10, name: 'harbor' },
      meta: META as never,
    },
    thumbnail: null,
    basedOn: null,
    note: '',
    source: null,
    realPerson: false,
    bytes: 10,
    createdBy: author,
    createdAt: NOW,
  };
}

function headOf(v: LibraryVersion, extra: Partial<LibraryItem> = {}): LibraryItem {
  return {
    id: v.itemId,
    kind: v.kind,
    name: 'Harbor',
    description: '',
    tags: [],
    entityId: null,
    current: v.version,
    latest: v.version,
    history: [
      {
        version: v.version,
        digest: v.digest,
        basedOn: null,
        note: '',
        realPerson: false,
        bytes: 10,
        createdBy: author,
        createdAt: NOW,
      },
    ],
    thumbnail: null,
    unit: null,
    realPerson: false,
    archived: false,
    ownerId: 'local',
    createdBy: author,
    createdAt: NOW,
    updatedBy: author,
    updatedAt: NOW,
    rev: 1,
    ...extra,
  };
}

describe.each([
  ['memory', async () => new MemoryBackend() as StorageBackend],
  ['file', async () => new FsBackend(await tmpDir()) as StorageBackend],
])('the library store on the %s backend', (name, backend) => {
  const layout = new Layout('/rideo');
  let storage: StorageBackend;
  let log: ReturnType<typeof quiet>;
  let tmp: string;
  const store = () =>
    new LibraryStore({ storage, layout, log, tmp: (ext) => join(tmp, `${newId('job')}.${ext}`) });
  beforeEach(async () => {
    storage = await backend();
    log = quiet();
    tmp = await tmpDir();
  });

  it('writes each version once, skipping a manifest a crash left without its head', async () => {
    const s = store();
    const id = newId('libraryItem');
    const v1 = await s.writeVersion(id, 1, (n) => versionOf(id, n, sha256('one')));
    expect(v1.version).toBe(1);
    // a manifest some crash wrote for v2 that no head names
    await storage.write(layout.libraryVersion(id, 2), JSON.stringify(versionOf(id, 2, sha256('lost'))));
    const v = await s.writeVersion(id, 2, (n) => versionOf(id, n, sha256('two')));
    expect(v.version).toBe(3);
    expect(log.warn).toHaveBeenCalledWith(
      { itemId: id, version: 2 },
      'skipping a library manifest no head names',
    );
    // read back from a fresh store (no cache)
    expect((await store().version(id, 3))?.digest).toBe(sha256('two'));
    expect(await store().version(id, 4)).toBeNull();
  });

  it('keeps two versions written at once, each under its own number', async () => {
    const id = newId('libraryItem');
    // one server: the item's lock; two servers on one storage: the manifest's If-None-Match (the memory backend's
    // conditional write is not atomic, so only the file backend plays the second server)
    const s = store();
    const t = name === 'file' ? store() : s;
    const [a, b] = await Promise.all([
      s.lock(id, () => s.writeVersion(id, 1, (n) => versionOf(id, n, sha256('a')))),
      name === 'file'
        ? t.writeVersion(id, 1, (n) => versionOf(id, n, sha256('b')))
        : s.lock(id, () => s.writeVersion(id, 1, (n) => versionOf(id, n, sha256('b')))),
    ]);
    expect(new Set([a.version, b.version])).toEqual(new Set([1, 2]));
    const fresh = store();
    expect(new Set([(await fresh.version(id, 1))?.digest, (await fresh.version(id, 2))?.digest])).toEqual(
      new Set([sha256('a'), sha256('b')]),
    );
  });

  it('reads every head once and skips an invalid one with a warning', async () => {
    const a = versionOf(newId('libraryItem'), 1, sha256('a'));
    const b = versionOf(newId('libraryItem'), 1, sha256('b'));
    await store().saveHead(headOf(a));
    await store().saveHead(headOf(b, { name: 'Lamp room' }));
    const bad = newId('libraryItem');
    await storage.write(layout.libraryItem(bad), '{"id": "not an item"');
    // a head whose id is not its file's name
    await storage.write(layout.libraryItem(newId('libraryItem')), JSON.stringify(headOf(a)));
    const s = store();
    const [one, two] = await Promise.all([s.items(), s.items()]);
    expect(one.map((i) => i.name).sort()).toEqual(['Harbor', 'Lamp room']);
    expect(two).toHaveLength(2);
    await s.item(a.itemId);
    expect(s.headReads).toBe(4);
    expect(log.warn).toHaveBeenCalledTimes(2);
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ file: `${bad}.json` }),
      'skipping an invalid library item',
    );
  });

  it('fails the load when a head cannot be read, and reads every head again on the next call', async () => {
    const a = versionOf(newId('libraryItem'), 1, sha256('a'));
    const b = versionOf(newId('libraryItem'), 1, sha256('b'));
    await store().saveHead(headOf(a));
    await store().saveHead(headOf(b, { name: 'Lamp room' }));
    // the storage fails the first read of one head (a server error, a timeout, a dropped connection)
    const read = storage.read.bind(storage);
    let failing: string | null = layout.libraryItem(a.itemId);
    vi.spyOn(storage, 'read').mockImplementation(async (path) => {
      if (path !== failing) return read(path);
      failing = null;
      throw new Error('GET failed: 503 Service Unavailable');
    });
    const s = store();
    await expect(s.items()).rejects.toMatchObject({ code: 'storage_error', retryable: true });
    expect((await s.items()).map((i) => i.name).sort()).toEqual(['Harbor', 'Lamp room']);
    expect(await s.item(a.itemId)).toMatchObject({ id: a.itemId });
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('a manifest that does not parse is a storage error', async () => {
    const id = newId('libraryItem');
    await storage.write(layout.libraryVersion(id, 1), 'garbage');
    await expect(store().version(id, 1)).rejects.toMatchObject({ code: 'storage_error' });
  });

  it('stores the same bytes once, serves ranges and checks the hash of a copy', async () => {
    const s = store();
    const file = join(tmp, 'unit.bin');
    await writeFile(file, 'hello library');
    const hash = sha256('hello library');
    expect(await s.putFile(file, hash, 13, 'application/octet-stream')).toBe(true);
    expect(await s.putFile(file, hash, 13, 'application/octet-stream')).toBe(false);
    expect(await s.hasFile(hash)).toBe(true);
    const part = await s.readFile(hash, { start: 6, end: 12 });
    const chunks: Buffer[] = [];
    for await (const c of part!.stream) chunks.push(Buffer.from(c));
    expect(Buffer.concat(chunks).toString()).toBe('library');
    // a file whose bytes are not its name's hash
    await storage.write(layout.libraryFile(sha256('other')), 'tampered');
    await expect(s.fileToTmp(sha256('other'), 'bin')).rejects.toMatchObject({ code: 'storage_error' });
    await expect(s.fileToTmp(sha256('missing'), 'bin')).rejects.toMatchObject({ code: 'storage_error' });
  });
});

// ------------------------------------------------------------------ the service

let studio: Studio;
let files: string;
const studios: Studio[] = [];
async function makeStudio(storage: StorageBackend = new MemoryBackend()) {
  const dataDir = await tmpDir();
  const config = loadConfig({
    RIDEO_DATA_DIR: dataDir,
    RIDEO_STORAGE: 'embedded',
    NODE_ENV: 'test',
    RIDEO_WATERMARK_KEY: 'unit-test-key',
    RIDEO_LOG_LEVEL: 'warn',
  });
  const s = createStudio(config, { log: quiet(), storage });
  await s.deps.accounts.init();
  studios.push(s);
  return s;
}
afterEach(async () => {
  for (const s of studios.splice(0)) await s.stop().catch(() => undefined);
});

async function upload(
  meta: Record<string, unknown>,
  bytes: Buffer,
  thumbnail?: Buffer,
): Promise<LibraryUploadFiles> {
  const path = join(files, `${newId('job')}.bin`);
  await writeFile(path, bytes);
  let thumb: LibraryUploadFiles['thumbnail'] = null;
  if (thumbnail) {
    const t = join(files, `${newId('job')}.png`);
    await writeFile(t, thumbnail);
    thumb = { path: t, size: thumbnail.length, mime: 'image/png' };
  }
  return {
    meta: LibraryUploadMetaSchema.parse(meta),
    payload: { path, size: bytes.length, filename: 'harbor.unit', mime: 'application/octet-stream' },
    thumbnail: thumb,
  };
}
const setMeta = (extra: Record<string, unknown> = {}) => ({
  kind: 'desk-set',
  name: 'Harbor',
  unit: { format: '3d-editor.desk-unit', formatVersion: 1, meta: META },
  ...extra,
});
const figureMeta = (extra: Record<string, unknown> = {}) => ({
  kind: 'desk-figure',
  name: 'Mira look',
  unit: {
    format: '3d-editor.desk-unit',
    formatVersion: 1,
    meta: { ...META, actor: { kind: 'mannequin', heightM: 1.7 } },
  },
  ...extra,
});
const code = (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (err: { code?: string }) => err.code ?? String(err),
  );

/** People and tokens (docs/design/accounts.md): the subject `libraryAllows` reads. */
const person = (id: string, admin = false): Principal => ({
  kind: 'user',
  user: { id, email: `${id}@studio.test`, name: id, studioRole: admin ? 'admin' : 'member', disabled: false },
  admin,
  token: null,
  actor: { kind: 'user', id, name: id },
});
const tokenOf = (owner: Principal, role: AgentToken['role'], projectIds: string[] | null): Principal => ({
  kind: 'token',
  user: owner.user,
  admin: false,
  token: {
    id: newId('token'),
    name: 'agent',
    role,
    projectIds,
    userId: owner.user.id,
  } as unknown as AgentToken,
  actor: { kind: 'agent', id: 'tok', name: 'agent', onBehalfOf: owner.actor as never },
});
const as = <T>(p: Principal, fn: () => Promise<T>) => principalContext.run(p, fn);

async function projectWith(
  s: Studio,
  docs: { characters?: Character[]; elements?: Element[]; clips?: Clip[]; access?: ProjectAccess },
) {
  const project = { ...f.project(), ...(docs.access ? { access: docs.access } : {}) };
  const h = s.deps.projects.handle(project.id);
  await h.repo.init(
    {
      'project.json': project,
      ...Object.fromEntries((docs.characters ?? []).map((c) => [`characters/${c.id}.json`, c])),
      ...Object.fromEntries((docs.elements ?? []).map((e) => [`elements/${e.id}.json`, e])),
      ...Object.fromEntries((docs.clips ?? []).map((c) => [`clips/${c.id}.json`, c])),
    },
    author,
    'Create project',
  );
  await h.worktree.idle();
  return project.id;
}

describe('the library service', () => {
  beforeEach(async () => {
    studio = await makeStudio();
    files = await tmpDir();
  });

  it('publishes a 3D set, makes no version for the same file, and refuses a stale basedOn or If-Match', async () => {
    const lib = studio.library;
    const m = studio.deps.metrics.library;
    const first = await lib.create(
      actor,
      await upload(setMeta({ tags: ['Harbour', 'season 1'] }), unitFile('set')),
    );
    const { item, version } = first;
    expect(item).toMatchObject({
      id: expect.stringMatching(/^lib_/),
      kind: 'desk-set',
      current: 1,
      latest: 1,
      rev: 1,
      tags: ['harbour', 'season 1'],
      ownerId: 'local',
      unit: { sha256: version.digest, format: '3d-editor.desk-unit', formatVersion: 1, actorKind: null },
    });
    // a 3D unit's digest is its file's sha256
    expect(version.digest).toBe(sha256(unitFile('set')));
    expect(m.get({ event: 'created', kind: 'desk-set' })).toBe(1);

    // the same bytes again: no version
    const same = await lib.addVersion(
      actor,
      item.id,
      await upload(setMeta({ name: undefined }), unitFile('set')),
    );
    expect(same).toMatchObject({ unchanged: true, item: { rev: 1, latest: 1 }, version: { version: 1 } });
    expect(m.get({ event: 'unchanged', kind: 'desk-set' })).toBe(1);

    const v2 = await lib.addVersion(
      actor,
      item.id,
      await upload(setMeta({ basedOn: 1, note: 'the pier is longer' }), unitFile('set', 'v2')),
      '"r1"',
    );
    expect(v2).toMatchObject({
      unchanged: false,
      item: { current: 2, latest: 2, rev: 2 },
      version: { version: 2 },
    });

    // made from v1 while v2 exists: 412 with the latest
    const stale = lib.addVersion(
      actor,
      item.id,
      await upload(setMeta({ basedOn: 1 }), unitFile('set', 'v3')),
    );
    await expect(stale).rejects.toMatchObject({ code: 'library_conflict', errors: [{ latest: 2 }] });
    // an If-Match of the old revision: 412 naming the current ETag
    const ifMatch = lib.addVersion(actor, item.id, await upload(setMeta(), unitFile('set', 'v3')), '"r1"');
    await expect(ifMatch).rejects.toMatchObject({
      code: 'library_conflict',
      etag: '"r2"',
      errors: [{ rev: 2, latest: 2 }],
    });
    expect(await lib.store.version(item.id, 3)).toBeNull();
    expect((await lib.get(item.id)).latest).toBe(2);
    expect(m.get({ event: 'conflict', kind: 'desk-set' })).toBe(2);
  });

  it('answers a retryable storage error while a head cannot be read, and never loses the item', async () => {
    const storage = new MemoryBackend();
    const one = await makeStudio(storage);
    const mira = f.character({ references: [], lock: { locked: false, version: 0 } });
    const pid = await projectWith(one, { characters: [mira] });
    const first = await one.library.save(actor, pid, { entity: { kind: 'character', id: mira.id } });
    // another server on the same storage, whose first read of the item's head fails
    const two = await makeStudio(storage);
    const read = storage.read.bind(storage);
    let failing: string | null = two.deps.layout.libraryItem(first.item.id);
    vi.spyOn(storage, 'read').mockImplementation(async (path) => {
      if (path !== failing) return read(path);
      failing = null;
      throw new Error('GET failed: 503 Service Unavailable');
    });
    await expect(two.library.list({})).rejects.toMatchObject({ code: 'storage_error', retryable: true });
    expect((await two.library.list({})).items.map((i) => i.id)).toEqual([first.item.id]);
    // Mira is saved into the item she is linked to, not into a new one
    const again = await two.library.save(actor, pid, { entity: { kind: 'character', id: mira.id } });
    expect(again.item.id).toBe(first.item.id);
    expect((await two.library.list({})).items).toHaveLength(1);
  });

  it('keeps two versions published at once', async () => {
    const lib = studio.library;
    const { item } = await lib.create(actor, await upload(setMeta(), unitFile('set')));
    const [a, b] = await Promise.all([
      lib.addVersion(actor, item.id, await upload(setMeta(), unitFile('set', 'a'))),
      lib.addVersion(actor, item.id, await upload(setMeta(), unitFile('set', 'b'))),
    ]);
    expect(new Set([a.version.version, b.version.version])).toEqual(new Set([2, 3]));
    const head = await lib.get(item.id);
    expect(head).toMatchObject({ latest: 3, current: 3, rev: 3 });
    expect(head.history.map((h) => h.version)).toEqual([1, 2, 3]);
  });

  it('renames, moves the current version, archives and unarchives, with the revision as precondition', async () => {
    const lib = studio.library;
    const { item } = await lib.create(actor, await upload(setMeta(), unitFile('set')));
    await lib.addVersion(actor, item.id, await upload(setMeta(), unitFile('set', 'v2')));
    const renamed = await lib.update(actor, item.id, { name: 'Old harbour' }, '"r2"');
    expect(renamed).toMatchObject({ name: 'Old harbour', rev: 3 });
    await expect(lib.update(actor, item.id, { name: 'x' }, 2)).rejects.toMatchObject({
      code: 'library_conflict',
    });
    const back = await lib.update(actor, item.id, { current: 1 }, 3);
    expect(back).toMatchObject({ current: 1, latest: 2, unit: { sha256: sha256(unitFile('set')) } });
    // nothing to change: the same head
    expect((await lib.update(actor, item.id, { name: 'Old harbour' })).rev).toBe(4);
    await lib.update(actor, item.id, { archived: true });
    expect((await lib.list({ archived: false, sort: 'updated', limit: 100 })).items).toEqual([]);
    expect((await lib.list({ archived: true, sort: 'updated', limit: 100 })).items.map((i) => i.id)).toEqual([
      item.id,
    ]);
    // still read and served
    expect((await lib.get(item.id)).archived).toBe(true);
    expect((await lib.fileInfo(item.id, 1, sha256(unitFile('set')))).size).toBe(unitFile('set').length);
    const changes = studio.deps.metrics.library;
    expect(changes.get({ event: 'current', kind: 'desk-set' })).toBe(1);
    expect(changes.get({ event: 'archived', kind: 'desk-set' })).toBe(1);
  });

  it('lets people and unscoped editor tokens publish, and only owners and admins manage', async () => {
    const lib = studio.library;
    const ana = person('usr_ana');
    const ben = person('usr_ben');
    const mira = person('usr_mira', true);
    const project = newId('project');
    const { item } = await as(ana, async () => lib.create(actor, await upload(setMeta(), unitFile('set'))));
    expect(item.ownerId).toBe('usr_ana');
    // tokens: scoped to projects, or below editor, only read
    for (const t of [tokenOf(ana, 'editor', [project]), tokenOf(ana, 'reviewer', null)]) {
      expect(
        await code(as(t, async () => lib.create(actor, await upload(setMeta(), unitFile('set', 'x'))))),
      ).toBe('forbidden');
      expect(
        (await as(t, () => lib.list({ archived: false, sort: 'updated', limit: 100 }))).items,
      ).toHaveLength(1);
    }
    expect(
      await code(
        as(tokenOf(ben, 'editor', null), async () =>
          lib.create(actor, await upload(setMeta(), unitFile('set', 'y'))),
        ),
      ),
    ).toBe('ok');
    // managing: the owner (and her unscoped editor token), an admin, never someone else or an admin's token
    expect(await code(as(ben, () => lib.update(actor, item.id, { name: 'Mine now' })))).toBe('forbidden');
    expect(
      await code(as(tokenOf(mira, 'director', null), () => lib.update(actor, item.id, { tags: ['x'] }))),
    ).toBe('forbidden');
    expect(
      await code(as(tokenOf(ana, 'editor', null), () => lib.update(actor, item.id, { tags: ['dock'] }))),
    ).toBe('ok');
    expect(await code(as(mira, () => lib.update(actor, item.id, { archived: true })))).toBe('ok');
    expect(await code(as(ana, () => lib.update(actor, item.id, { archived: false })))).toBe('ok');
    // the refusals are audited
    const denied = await studio.deps.accounts.audit.query({ type: 'auth.denied', limit: 20 });
    expect(denied.map((e) => e.detail.library)).toEqual(
      expect.arrayContaining(['publish', 'publish', 'manage', 'manage']),
    );
  });

  it('pins a set on a location and a figure on a character without touching locks or identity, then unpins', async () => {
    const lib = studio.library;
    const mira = f.character();
    const lamp = f.element();
    const key = f.element({ kind: 'prop', name: 'Brass key' });
    const pid = await projectWith(studio, { characters: [mira], elements: [lamp, key] });
    const set = await lib.create(actor, await upload(setMeta(), unitFile('set')));
    const figure = await lib.create(actor, await upload(figureMeta(), unitFile('figure')));

    const pinned = await lib.apply(actor, pid, {
      itemId: set.item.id,
      target: { kind: 'element', id: lamp.id },
    });
    expect(pinned).toMatchObject({
      applied: true,
      plan: { mode: 'pin', changes: ['deskUnit'] },
      commit: expect.any(String),
    });
    await lib.apply(actor, pid, { itemId: figure.item.id, target: { kind: 'character', id: mira.id } });
    let docs = await studio.deps.projects.docs(pid);
    expect(docs.elements[lamp.id]!.deskUnit).toMatchObject({
      kind: 'desk-set',
      itemId: set.item.id,
      version: 1,
      sha256: set.version.digest,
      name: 'Harbor',
      pinnedBy: actor,
    });
    expect(docs.characters[mira.id]!.deskUnit).toMatchObject({
      kind: 'desk-figure',
      actorKind: 'mannequin',
      heightM: 1.7,
    });
    // pins are not identity
    expect(docs.elements[lamp.id]!.lock).toEqual(lamp.lock);
    expect(elementIdentityHash(docs.elements[lamp.id]!)).toBe(elementIdentityHash(lamp));
    expect(identityHash(docs.characters[mira.id]!)).toBe(identityHash(mira));
    // a set is no prop; replacePin: false keeps another item's pin
    expect(
      await code(lib.apply(actor, pid, { itemId: set.item.id, target: { kind: 'element', id: key.id } })),
    ).toBe('validation_error');
    const other = await lib.create(actor, await upload(setMeta({ name: 'Pier' }), unitFile('set', 'pier')));
    await expect(
      lib.apply(actor, pid, {
        itemId: other.item.id,
        target: { kind: 'element', id: lamp.id },
        replacePin: false,
      }),
    ).rejects.toMatchObject({ code: 'conflict', errors: [{ reason: 'pinned', itemId: set.item.id }] });

    // the status and the uses follow the pins; a new version makes them behind
    await lib.addVersion(actor, set.item.id, await upload(setMeta(), unitFile('set', 'v2')));
    const status = await lib.status(pid);
    expect(status.behind).toBe(1);
    expect(status.links.find((l) => l.itemId === set.item.id)).toMatchObject({
      via: 'deskUnit',
      entity: { kind: 'element', id: lamp.id },
      version: 1,
      state: 'behind',
      item: { current: 2 },
    });
    const uses = await lib.uses(set.item.id);
    expect(uses).toMatchObject({
      incomplete: false,
      projects: [
        { projectId: pid, role: 'director', uses: [{ itemId: set.item.id, version: 1, via: 'deskUnit' }] },
      ],
    });

    const detached = await lib.detach(actor, pid, {
      target: { kind: 'element', id: lamp.id },
      what: 'deskUnit',
    });
    expect(detached.commit).toEqual(expect.any(String));
    docs = await studio.deps.projects.docs(pid);
    expect(docs.elements[lamp.id]!.deskUnit).toBeNull();
    expect((await lib.uses(set.item.id)).projects).toEqual([]);
    expect(studio.deps.metrics.library.get({ event: 'pinned', kind: 'desk-set' })).toBe(1);
    expect(studio.deps.metrics.library.get({ event: 'detached', kind: 'element' })).toBe(1);
    const applied = await studio.deps.accounts.audit.query({ type: 'library.apply', limit: 10 });
    expect(applied.map((e) => e.detail.mode)).toEqual(['pin', 'pin']);
  });

  it('asks a director to update a character whose approved clip goes stale, never an editor, and lets an editor see the plan', async () => {
    const lib = studio.library;
    const base = f.character();
    const mira: Character = { ...base, lock: { ...base.lock, identityHash: identityHash(base) } };
    const clip = f.clip({ status: 'approved', title: 'Opening', shots: [f.readyShot([mira])] });
    const access = ProjectAccessSchema.parse({
      members: [
        { userId: 'usr_ana1234567', role: 'director' },
        { userId: 'usr_ben1234567', role: 'editor' },
      ],
    });
    // an item made from Mira (v1) and a v2 with new hair; the project uses v1
    const id = newId('libraryItem');
    const v = (n: number, c: Character): LibraryVersion => {
      const payload = characterSnapshot(c).payload;
      return {
        itemId: id,
        version: n,
        kind: 'character',
        digest: libraryDigest('character', payload, sha256),
        payload,
        thumbnail: null,
        basedOn: n > 1 ? n - 1 : null,
        note: '',
        source: null,
        realPerson: isRealPersonSnapshot('character', payload),
        bytes: 0,
        createdBy: author,
        createdAt: NOW,
      };
    };
    const v1 = await lib.store.writeVersion(id, 1, () => v(1, mira));
    const v2 = await lib.store.writeVersion(id, 2, () =>
      v(2, { ...mira, identity: { ...mira.identity, hair: 'silver crop' } }),
    );
    await lib.store.saveHead({
      ...headOf(v1, { kind: 'character', name: 'Mira', entityId: mira.id, ownerId: 'usr_ana1234567' }),
      current: 2,
      latest: 2,
      history: [...headOf(v1).history, { ...headOf(v2).history[0]!, version: 2, basedOn: 1 }],
    });
    const linked = {
      ...mira,
      library: { itemId: id, version: 1, digest: v1.digest, mode: 'used' as const, at: NOW, by: actor },
    };
    const pid = await projectWith(studio, { characters: [linked], clips: [clip], access });
    const input = { itemId: id, target: { kind: 'character' as const, id: mira.id } };

    // the plan: an editor may read it, with what the apply will need
    const plan = await as(person('usr_ben1234567'), () => lib.apply(actor, pid, { ...input, dryRun: true }));
    expect(plan.plan).toMatchObject({
      mode: 'update',
      needs: 'project.approve',
      staleTakes: 1,
      lock: { from: 1, to: 2 },
    });
    expect(plan.plan.approvedClips).toEqual([{ id: clip.id, index: 0, title: 'Opening' }]);
    // the apply: refused for the editor (audited), done for the director
    expect(await code(as(person('usr_ben1234567'), () => lib.apply(actor, pid, input)))).toBe('forbidden');
    const denied = await studio.deps.accounts.audit.query({ type: 'auth.denied', limit: 5 });
    expect(denied[0]).toMatchObject({
      projectId: pid,
      detail: { permission: 'project.approve', role: 'editor' },
    });
    const done = await as(person('usr_ana1234567'), () => lib.apply(actor, pid, input));
    expect(done).toMatchObject({ applied: true, plan: { needs: 'project.approve' } });
    const after = (await studio.deps.projects.docs(pid)).characters[mira.id]!;
    expect(after).toMatchObject({
      identity: { hair: 'silver crop' },
      lock: { locked: true, version: 2 },
      library: { version: 2 },
    });
    expect(after.lock.identityHash).toBe(identityHash(after));
  });
});
