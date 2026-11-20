import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  type Actor,
  applyVersion,
  approvedElementReferences,
  approvedReferences,
  type Character,
  CharacterSchema,
  CharacterSnapshotSchema,
  canonicalJson,
  characterSnapshot,
  consentSubjects,
  DeskUnitMetaSchema,
  DeskUnitPinSchema,
  type Element,
  ElementSchema,
  ElementSnapshotSchema,
  elementIndex,
  elementSnapshot,
  isRealPersonSnapshot,
  isStale,
  LibraryApplyInputSchema,
  LibraryError,
  type LibraryItem,
  LibraryItemSchema,
  type LibraryKind,
  LibraryListQuerySchema,
  LibraryUploadMetaSchema,
  type LibraryVersion,
  LibraryVersionSchema,
  libraryDigest,
  libraryDigestInput,
  libraryUses,
  maxRecordedLock,
  newId,
  type ProjectDocs,
  planApply,
  ResourceSchema,
  type Voice,
  versionFiles,
} from '../src';
import * as f from '../src/testing/fixtures';

/** The studio library's pure rules (docs/design/library.md). */

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
/** The server's identity hashes (story.ts, elements.ts, voices.ts): the lock rules compare them. */
const identity = {
  character: (c: Character) =>
    sha256(
      canonicalJson({
        name: c.name,
        identity: c.identity,
        wardrobe: c.wardrobe.map(({ name, description }) => ({ name, description })),
        references: approvedReferences(c)
          .map((r) => r.media.hash)
          .sort(),
      }),
    ),
  element: (e: Element) =>
    sha256(
      canonicalJson({
        name: e.name,
        description: e.description,
        references: approvedElementReferences(e)
          .map((r) => r.media.hash)
          .sort(),
      }),
    ),
  voice: (v: Voice) =>
    sha256(
      canonicalJson({
        provider: v.provider,
        voiceId: v.voiceId,
        sample: v.sample?.hash ?? null,
        description: v.description,
      }),
    ),
};
const actor: Actor = { kind: 'user', id: 'usr_0000000000aaaaaa', name: 'Ana' };
const author = { kind: 'user' as const, id: actor.id, name: 'Ana' };
const NOW = '2026-11-20T10:00:00.000Z';
const HASH = (s: string) => sha256(s);

const unitMeta = (actorKind?: string, heightM?: number) => ({
  dimensionsM: [12, 8, 4] as [number, number, number],
  objects: 14,
  triangles: 20_000,
  actor: actorKind ? { kind: actorKind, heightM: heightM ?? 1.7 } : null,
  credits: [],
  deskVersion: '1.4.0',
  digest: HASH('body'),
});

function version(
  itemId: string,
  kind: LibraryKind,
  payload: LibraryVersion['payload'],
  n = 1,
  extra: Partial<LibraryVersion> = {},
): LibraryVersion {
  return LibraryVersionSchema.parse({
    itemId,
    version: n,
    kind,
    digest: libraryDigest(kind, payload, sha256),
    payload,
    thumbnail: null,
    basedOn: null,
    note: '',
    source: null,
    realPerson: isRealPersonSnapshot(kind, payload),
    bytes: 0,
    createdBy: author,
    createdAt: NOW,
    ...extra,
  });
}

function itemOf(v: LibraryVersion, extra: Partial<LibraryItem> = {}): LibraryItem {
  return LibraryItemSchema.parse({
    id: v.itemId,
    kind: v.kind,
    name: 'name' in v.payload ? v.payload.name : 'Harbor',
    entityId: null,
    current: v.version,
    latest: v.version,
    history: [
      {
        version: v.version,
        digest: v.digest,
        basedOn: null,
        note: '',
        realPerson: v.realPerson,
        bytes: 0,
        createdBy: author,
        createdAt: NOW,
      },
    ],
    ownerId: actor.id,
    createdBy: author,
    createdAt: NOW,
    updatedBy: author,
    updatedAt: NOW,
    rev: 1,
    ...extra,
  });
}

const deskVersion = (kind: 'desk-set' | 'desk-prop' | 'desk-figure', n = 1, actorKind?: string) =>
  version(
    'lib_0000000000deskaa',
    kind,
    {
      format: '3d-editor.desk-unit',
      formatVersion: 1,
      payload: { hash: HASH(`${kind}${n}`), mime: 'application/octet-stream', size: 1234, name: 'harbor' },
      meta: unitMeta(actorKind),
    },
    n,
  );

const docsWith = (over: Partial<ProjectDocs> = {}) => f.docs(over);
const ctx = (
  docs: ProjectDocs,
  item: LibraryItem,
  v: LibraryVersion,
  input: Record<string, unknown> = {},
) => ({
  docs,
  item,
  version: v,
  input: LibraryApplyInputSchema.parse({ itemId: item.id, ...input }),
  sha256,
  identity,
  actor,
  now: NOW,
});
const refusal = (fn: () => unknown) => {
  try {
    fn();
  } catch (err) {
    if (err instanceof LibraryError) return { code: err.code, errors: err.errors };
    throw err;
  }
  throw new Error('expected a refusal');
};

describe('library schemas', () => {
  it('parse a version of every kind and refuse a payload of another kind', () => {
    const mira = f.character();
    const chr = version('lib_0000000000mira00', 'character', characterSnapshot(mira).payload);
    const ele = version('lib_0000000000harb00', 'element', elementSnapshot(f.element()).payload);
    for (const k of ['desk-set', 'desk-prop', 'desk-figure'] as const) expect(deskVersion(k).kind).toBe(k);
    expect(chr.kind).toBe('character');
    expect(ele.kind).toBe('element');
    expect(LibraryVersionSchema.safeParse({ ...chr, kind: 'element' }).success).toBe(false);
    expect(LibraryVersionSchema.safeParse({ ...ele, kind: 'desk-set' }).success).toBe(false);
  });

  it('keep tags lower case and short, and at most 20', () => {
    const base = itemOf(deskVersion('desk-set'));
    expect(LibraryItemSchema.parse({ ...base, tags: ['Season 1'] }).tags).toEqual(['season 1']);
    expect(LibraryItemSchema.safeParse({ ...base, tags: ['x'.repeat(41)] }).success).toBe(false);
    expect(LibraryItemSchema.safeParse({ ...base, tags: ['-starts-with-dash'] }).success).toBe(false);
    expect(
      LibraryItemSchema.safeParse({ ...base, tags: Array.from({ length: 21 }, (_, i) => `t${i}`) }).success,
    ).toBe(false);
  });

  it('refuse more than 32 character references and 16 element references', () => {
    const many = Array.from({ length: 33 }, () => f.reference());
    expect(
      CharacterSnapshotSchema.safeParse(characterSnapshot(f.character({ references: many })).payload).success,
    ).toBe(false);
    const refs = Array.from({ length: 17 }, () => f.elementReference());
    expect(
      ElementSnapshotSchema.safeParse(elementSnapshot(f.element({ references: refs })).payload).success,
    ).toBe(false);
  });

  it('refuse desk meta over 16 KiB and more than 32 credits', () => {
    const credit = { name: 'a model', author: 'someone', license: 'CC-BY-4.0' };
    expect(DeskUnitMetaSchema.safeParse({ ...unitMeta(), credits: Array(33).fill(credit) }).success).toBe(
      false,
    );
    // every field within its limit, but 32 credits of three-byte characters are over 16 KiB of JSON
    const long = { name: '€'.repeat(120), author: '€'.repeat(200), license: '€'.repeat(64) };
    expect(DeskUnitMetaSchema.safeParse({ ...unitMeta(), credits: Array(32).fill(long) }).success).toBe(
      false,
    );
    expect(DeskUnitMetaSchema.safeParse({ ...unitMeta(), credits: Array(8).fill(long) }).success).toBe(true);
    expect(DeskUnitMetaSchema.safeParse(unitMeta('mannequin', 1.8)).success).toBe(true);
  });

  it('take a desk pin exactly as the spec writes it, nullable height and kind', () => {
    const pin = {
      kind: 'desk-figure',
      itemId: 'lib_0000000000mira00',
      version: 2,
      sha256: HASH('x'),
      name: 'Mira look',
      actorKind: 'mannequin',
      heightM: 1.7,
      pinnedAt: NOW,
      pinnedBy: actor,
    };
    expect(DeskUnitPinSchema.parse(pin)).toEqual(pin);
    expect(DeskUnitPinSchema.safeParse({ ...pin, actorKind: null, heightM: null }).success).toBe(true);
    expect(DeskUnitPinSchema.safeParse({ ...pin, sha256: 'a'.repeat(63) }).success).toBe(false);
    expect(DeskUnitPinSchema.safeParse({ ...pin, kind: 'set' }).success).toBe(false);
  });

  it('let old documents without the fields parse, and round-trip the new ones', () => {
    const mira = f.character();
    expect(CharacterSchema.parse(mira).library).toBeUndefined();
    const linked = {
      ...mira,
      library: {
        itemId: 'lib_0000000000mira00',
        version: 1,
        digest: HASH('d'),
        mode: 'used',
        at: NOW,
        by: actor,
      },
      deskUnit: null,
    };
    expect(CharacterSchema.parse(linked)).toEqual(linked);
    const harbor = { ...f.element(), library: null, deskUnit: null };
    expect(ElementSchema.parse(harbor)).toEqual(harbor);
    const resource = {
      id: newId('resource'),
      kind: 'image',
      role: 'reference',
      name: 'map.png',
      media: f.imageMedia(),
      createdAt: NOW,
      origin: 'library',
      status: 'ready',
    };
    expect(ResourceSchema.parse(resource).origin).toBe('library');
  });

  it('read list queries: kinds as CSV, archived as a string boolean', () => {
    const q = LibraryListQuerySchema.parse({ kinds: 'desk-set, desk-prop', archived: 'false', limit: '50' });
    expect(q).toMatchObject({
      kinds: ['desk-set', 'desk-prop'],
      archived: false,
      limit: 50,
      sort: 'updated',
    });
    expect(LibraryListQuerySchema.parse({ archived: '0' }).archived).toBe(false);
    expect(LibraryListQuerySchema.parse({ archived: 'true' }).archived).toBe(true);
    expect(LibraryListQuerySchema.safeParse({ kinds: 'voice' }).success).toBe(false);
    expect(LibraryListQuerySchema.safeParse({ limit: '201' }).success).toBe(false);
  });

  it('need a unit for 3D uploads and a resource for resource uploads', () => {
    const unit = { format: '3d-editor.desk-unit', formatVersion: 1, meta: unitMeta() };
    expect(LibraryUploadMetaSchema.safeParse({ kind: 'desk-set', name: 'Harbor', unit }).success).toBe(true);
    expect(LibraryUploadMetaSchema.safeParse({ kind: 'desk-set', name: 'Harbor' }).success).toBe(false);
    expect(
      LibraryUploadMetaSchema.safeParse({ kind: 'desk-set', unit: { ...unit, format: 'other' } }).success,
    ).toBe(false);
    expect(LibraryUploadMetaSchema.safeParse({ kind: 'resource', unit }).success).toBe(false);
    expect(LibraryUploadMetaSchema.safeParse({ kind: 'voice' as never, unit }).success).toBe(false);
  });
});

describe('snapshots and the digest', () => {
  it('keep approved references with their consent, the seed and the wardrobe ids; leave candidates out', () => {
    const consent = {
      depictsRealPerson: true,
      subject: 'Mira Actor',
      grantedBy: 'Mira Actor',
      grantedAt: NOW,
      scope: 'this production',
      recordedBy: actor,
      recordedAt: NOW,
    };
    const mira = f.character({
      references: [f.reference({ consent }), f.reference({ approved: false })],
      voice: {
        description: 'warm',
        provider: 'elevenlabs',
        voiceId: 'v1',
        source: 'designed',
        sample: f.media({ mime: 'audio/wav', path: 'media/voices/mira-sample-0123456789ab.wav' }),
        candidates: [{ id: newId('reference'), voiceId: 'c', sample: f.media(), createdAt: NOW }],
        lock: { locked: true, version: 1 },
      },
    });
    const snap = characterSnapshot(mira);
    expect(snap.payload.references).toHaveLength(1);
    expect(snap.payload.references[0]!.consent).toEqual(consent);
    expect(snap.payload.references[0]!.media).not.toHaveProperty('path');
    expect(snap.payload.seed).toBe(mira.seed);
    expect(snap.payload.wardrobe[0]!.id).toBe(mira.wardrobe[0]!.id);
    expect(snap.payload.voice).toMatchObject({
      voiceId: 'v1',
      locked: true,
      sample: { name: 'mira-sample' },
    });
    expect(snap.payload.voice).not.toHaveProperty('candidates');
    expect(snap.files.map((m) => m.hash)).toEqual([mira.references[0]!.media.hash, mira.voice!.sample!.hash]);
    expect(isRealPersonSnapshot('character', snap.payload)).toBe(true);
  });

  it('call a cloned real-person voice a real person too', () => {
    const consent = {
      depictsRealPerson: true,
      subject: 'X',
      grantedBy: 'X',
      grantedAt: NOW,
      recordedBy: actor,
      recordedAt: NOW,
    };
    const mira = f.character({
      voice: {
        ...f.character().voice!,
        ...{
          description: '',
          provider: 'p',
          voiceId: 'v',
          source: 'cloned',
          sample: null,
          candidates: [],
          consent,
          lock: { locked: false, version: 0 },
        },
      } as Voice,
    });
    expect(isRealPersonSnapshot('character', characterSnapshot(mira).payload)).toBe(true);
    expect(isRealPersonSnapshot('character', characterSnapshot(f.character()).payload)).toBe(false);
  });

  it('is the same under new reference and wardrobe ids, createdAt and consent.recordedAt', () => {
    const consent = { depictsRealPerson: false, recordedBy: actor, recordedAt: NOW };
    const outfit = newId('wardrobe');
    const ref = f.reference({ wardrobeId: outfit, consent });
    const mira = f.character({
      wardrobe: [{ id: outfit, name: 'Coat', description: 'long coat', default: true }],
      references: [ref],
    });
    const digest = (c: Character) => libraryDigest('character', characterSnapshot(c).payload, sha256);
    const outfit2 = newId('wardrobe');
    const copy = f.character({
      ...mira,
      wardrobe: [{ id: outfit2, name: 'Coat', description: 'long coat', default: true }],
      references: [
        {
          ...ref,
          id: newId('reference'),
          wardrobeId: outfit2,
          createdAt: '2027-01-01T00:00:00.000Z',
          consent: { ...consent, recordedAt: '2027-01-01T00:00:00.000Z' },
        },
      ],
    });
    expect(digest(copy)).toBe(digest(mira));
    expect(digest({ ...mira, identity: { ...mira.identity, hair: 'red curls' } })).not.toBe(digest(mira));
    expect(digest({ ...mira, wardrobe: [{ ...mira.wardrobe[0]!, description: 'short coat' }] })).not.toBe(
      digest(mira),
    );
    expect(digest({ ...mira, references: [{ ...ref, media: f.imageMedia() }] })).not.toBe(digest(mira));
    expect(digest({ ...mira, seed: mira.seed + 1 })).not.toBe(digest(mira));
    const pin = DeskUnitPinSchema.parse({
      kind: 'desk-figure',
      itemId: 'lib_0000000000mira00',
      version: 1,
      sha256: HASH('a'),
      name: 'Mira look',
      actorKind: null,
      heightM: null,
      pinnedAt: NOW,
      pinnedBy: actor,
    });
    expect(digest({ ...mira, deskUnit: pin })).not.toBe(digest(mira));
    // who pinned it and when is not content
    expect(digest({ ...mira, deskUnit: { ...pin, pinnedAt: '2027-01-01T00:00:00.000Z' } })).toBe(
      digest({ ...mira, deskUnit: pin }),
    );
    expect(libraryDigestInput('character', characterSnapshot(mira).payload)).not.toHaveProperty(
      'references.0.id',
    );
  });

  it('is the unit file sha256 for 3D units', () => {
    const v = deskVersion('desk-set');
    expect(v.digest).toBe(HASH('desk-set1'));
    expect(versionFiles(v).map((x) => x.hash)).toEqual([HASH('desk-set1')]);
  });
});

describe('maxRecordedLock', () => {
  it('reads takes, board frames, take audio and dubs', () => {
    const mira = f.character();
    const t = f.take({
      characterLocks: { [mira.id]: 3 },
      audio: { mode: 'tts', dialogue: null, lines: [], voiceLocks: { [mira.id]: 2 }, lipSync: 'none' },
    });
    const board = {
      ...f.take(),
      keyframe: f.imageMedia(),
      promptHash: 'h',
      sheet: null,
      approved: false,
      approvedAt: null,
      approvedBy: null,
      seen: null,
      characterLocks: { [mira.id]: 5 },
    };
    const clip = f.clip({ shots: [f.shot({ characterIds: [mira.id], takes: [t], board: board as never })] });
    const docs = docsWith({
      clips: { [clip.id]: clip },
      localizations: {
        es: {
          id: 'es',
          name: 'Spanish',
          lines: [],
          dubs: {
            x: {
              takeId: t.id,
              shotId: 'sht_0000000000aaaaaa',
              clipId: clip.id,
              dialogue: f.media(),
              lines: [],
              voiceLocks: { [mira.id]: 7 },
              video: null,
              watermarkId: null,
              contentCredentials: null,
              createdAt: NOW,
            },
          },
          createdAt: NOW,
          updatedAt: NOW,
        } as never,
      },
    });
    expect(maxRecordedLock(docs, 'character', mira.id)).toBe(5);
    expect(maxRecordedLock(docs, 'voice', mira.id)).toBe(7);
    expect(maxRecordedLock(docs, 'element', mira.id)).toBe(0);
  });
});

describe('planApply', () => {
  const miraItem = () => {
    const mira = f.character();
    const v = version('lib_0000000000mira00', 'character', characterSnapshot(mira).payload);
    return { mira, v, item: itemOf(v, { entityId: mira.id }) };
  };

  it('creates with the library id and seed, locked above every version the project recorded', () => {
    const { mira, v, item } = miraItem();
    // an older take of the same id at lock 3 (an episode copied from another)
    const clip = f.clip({
      shots: [f.shot({ characterIds: [mira.id], takes: [f.take({ characterLocks: { [mira.id]: 3 } })] })],
    });
    const docs = docsWith({ clips: { [clip.id]: clip } });
    const plan = planApply(ctx(docs, item, v));
    expect(plan).toMatchObject({
      mode: 'create',
      keepsLibraryId: true,
      entity: { id: mira.id, exists: false },
      lock: { locked: true, to: 4 },
      // that take is stale once Mira is back at 4; its clip is not approved, so an editor may
      staleTakes: 1,
      approvedClips: [],
      needs: 'project.edit',
    });
    const out = applyVersion({
      ...ctx(docs, item, v),
      copied: new Map(mira.references.map((r) => [r.media.hash, r.media])),
    });
    const doc = CharacterSchema.parse(out.write!.doc);
    expect(doc.id).toBe(mira.id);
    expect(doc.seed).toBe(mira.seed);
    expect(doc.lock).toMatchObject({ locked: true, version: 4, identityHash: identity.character(doc) });
    expect(doc.library).toMatchObject({ itemId: item.id, version: 1, digest: v.digest, mode: 'used' });
    expect(out.message).toBe('Use Mira from the library (v1)');
  });

  it('counts the takes a create makes stale, and asks a director when an approved clip holds one', () => {
    const { mira, v, item } = miraItem();
    // Mira was removed here (or the episode was copied from another): an approved clip keeps a take that recorded her
    const approved = f.clip({ shots: [f.readyShot([mira])], status: 'approved', title: 'Harbor dawn' });
    expect(planApply(ctx(docsWith({ clips: { [approved.id]: approved } }), item, v))).toMatchObject({
      mode: 'create',
      lock: { locked: true, from: null, to: 2 },
      staleTakes: 1,
      approvedClips: [{ id: approved.id, index: 0, title: 'Harbor dawn' }],
      needs: 'project.approve',
    });
    // an element alike
    const harbor = f.element({ name: 'Harbor' });
    const ev = version('lib_0000000000harb00', 'element', elementSnapshot(harbor).payload);
    const take = f.take({ elementLocks: { [harbor.id]: 1 } });
    const docks = f.clip({
      status: 'approved',
      title: 'Docks',
      shots: [f.shot({ elementIds: [harbor.id], takes: [take], selectedTakeId: take.id, status: 'ready' })],
    });
    expect(
      planApply(ctx(docsWith({ clips: { [docks.id]: docks } }), itemOf(ev, { entityId: harbor.id }), ev)),
    ).toMatchObject({
      mode: 'create',
      lock: { locked: true, from: null, to: 2 },
      staleTakes: 1,
      approvedClips: [{ id: docks.id, index: 0, title: 'Docks' }],
      needs: 'project.approve',
    });
  });

  it('creates a version saved unlocked above every version the project recorded too, its voice likewise', () => {
    const voice: Voice = {
      description: 'warm',
      provider: 'elevenlabs',
      voiceId: 'v1',
      source: 'designed',
      sample: f.media({ mime: 'audio/wav' }),
      candidates: [],
      lock: { locked: false, version: 0 },
    };
    const mira = f.character({ lock: { locked: false, version: 0 }, voice });
    const v = version('lib_0000000000mira00', 'character', characterSnapshot(mira).payload);
    const item = itemOf(v, { entityId: mira.id });
    // a take of an earlier Mira of the same id, made while she was unlocked at 3, that spoke with her voice at 2
    const old = f.take({
      characterLocks: { [mira.id]: 3 },
      audio: { mode: 'tts', dialogue: null, lines: [], voiceLocks: { [mira.id]: 2 }, lipSync: 'none' },
    });
    const shot = f.shot({ characterIds: [mira.id], takes: [old], selectedTakeId: old.id });
    const clip = f.clip({ shots: [shot] });
    const docs = docsWith({ clips: { [clip.id]: clip } });
    expect(planApply(ctx(docs, item, v))).toMatchObject({
      lock: { locked: false, from: null, to: 4 },
      voiceLock: { locked: false, from: null, to: 3 },
    });
    const out = applyVersion({
      ...ctx(docs, item, v),
      copied: new Map([...mira.references.map((r) => r.media), voice.sample!].map((m) => [m.hash, m])),
    });
    const doc = CharacterSchema.parse(out.write!.doc);
    expect(doc.lock).toEqual({ locked: false, version: 4 });
    expect(doc.voice!.lock).toEqual({ locked: false, version: 3 });
    // the old take is no take of this Mira, locked or not
    expect(isStale(old, shot, { [doc.id]: doc })).toBe(true);
    // where nothing recorded the id, an unlocked one starts at 0 as any new character
    expect(planApply(ctx(docsWith(), item, v)).lock).toEqual({ locked: false, from: null, to: 0 });
  });

  it('creates a version saved unlocked above a version 0 a take recorded, its voice likewise', () => {
    const voice: Voice = {
      description: 'warm',
      provider: 'elevenlabs',
      voiceId: 'v1',
      source: 'designed',
      sample: f.media({ mime: 'audio/wav' }),
      candidates: [],
      lock: { locked: false, version: 0 },
    };
    const mira = f.character({ lock: { locked: false, version: 0 }, voice });
    const v = version('lib_0000000000mira00', 'character', characterSnapshot(mira).payload);
    const item = itemOf(v, { entityId: mira.id });
    // a take of an earlier Mira of the same id, made while she and her voice were never locked
    const old = f.take({
      characterLocks: { [mira.id]: 0 },
      audio: { mode: 'tts', dialogue: null, lines: [], voiceLocks: { [mira.id]: 0 }, lipSync: 'none' },
    });
    const shot = f.shot({ characterIds: [mira.id], takes: [old], selectedTakeId: old.id });
    const clip = f.clip({ shots: [shot] });
    const docs = docsWith({ clips: { [clip.id]: clip } });
    expect(planApply(ctx(docs, item, v))).toMatchObject({
      lock: { locked: false, from: null, to: 1 },
      voiceLock: { locked: false, from: null, to: 1 },
      staleTakes: 1,
    });
    const out = applyVersion({
      ...ctx(docs, item, v),
      copied: new Map([...mira.references.map((r) => r.media), voice.sample!].map((m) => [m.hash, m])),
    });
    const doc = CharacterSchema.parse(out.write!.doc);
    expect(isStale(old, shot, { [doc.id]: doc })).toBe(true);
  });

  it('refuses a create whose id or name is taken, and only warns for an alias', () => {
    const { mira, v, item } = miraItem();
    expect(refusal(() => planApply(ctx(docsWith({ characters: { [mira.id]: mira } }), item, v)))).toEqual({
      code: 'conflict',
      errors: [{ reason: 'exists', entityId: mira.id }],
    });
    const other = f.character({ name: 'MIRA' });
    expect(refusal(() => planApply(ctx(docsWith({ characters: { [other.id]: other } }), item, v)))).toEqual({
      code: 'conflict',
      errors: [{ reason: 'name', entityId: other.id }],
    });
    const harbor = f.element({ name: 'Harbor', aliases: ['the docks'] });
    const ev = version('lib_0000000000harb00', 'element', elementSnapshot(harbor).payload);
    const eItem = itemOf(ev, { entityId: harbor.id });
    const sameName = f.element({ name: 'harbor' });
    expect(
      refusal(() => planApply(ctx(docsWith({ elements: { [sameName.id]: sameName } }), eItem, ev))).code,
    ).toBe('conflict');
    // the same name as another kind is free
    const prop = f.element({ name: 'Harbor', kind: 'prop' });
    expect(planApply(ctx(docsWith({ elements: { [prop.id]: prop } }), eItem, ev)).mode).toBe('create');
    const docks = f.element({ name: 'Pier', aliases: ['The Docks'] });
    const plan = planApply(ctx(docsWith({ elements: { [docks.id]: docks } }), eItem, ev));
    expect(plan.warnings.join(' ')).toContain('the docks');
  });

  it("warns when an alias is another element's name: that element no longer answers to its own name", () => {
    const harbor = f.element({ name: 'Harbor', aliases: ['Docks'] });
    const ev = version('lib_0000000000harb00', 'element', elementSnapshot(harbor).payload);
    const eItem = itemOf(ev, { entityId: harbor.id });
    const docks = f.element({ name: 'docks' });
    const docs = docsWith({ elements: { [docks.id]: docks } });
    expect(planApply(ctx(docs, eItem, ev)).warnings).toEqual([
      '“Docks” is also the name of docks: neither answers to it in the screenplay',
    ]);
    // what the warning says: after the apply the name resolves to neither
    const out = applyVersion({
      ...ctx(docs, eItem, ev),
      copied: new Map(harbor.references.map((r) => [r.media.hash, r.media])),
    });
    expect(elementIndex([docks, out.write!.doc as Element])('location', 'Docks')).toBeNull();
    // a prop of that name is another kind: nothing to say
    const prop = f.element({ name: 'Docks', kind: 'prop' });
    expect(planApply(ctx(docsWith({ elements: { [prop.id]: prop } }), eItem, ev)).warnings).toEqual([]);
  });

  it('keeps the lock version when the identity is unchanged and stales no take', () => {
    const { mira, v, item } = miraItem();
    const linked = {
      ...mira,
      lock: { ...mira.lock, identityHash: identity.character(mira) },
      library: { itemId: item.id, version: 1, digest: v.digest, mode: 'used' as const, at: NOW, by: actor },
    };
    const shot = f.readyShot([linked]);
    const clip = f.clip({ shots: [shot], status: 'approved' });
    const docs = docsWith({ characters: { [mira.id]: linked }, clips: { [clip.id]: clip } });
    const plan = planApply(ctx(docs, item, v, { target: { kind: 'character', id: mira.id } }));
    expect(plan).toMatchObject({
      mode: 'update',
      lock: { from: 1, to: 1 },
      staleTakes: 0,
      approvedClips: [],
      needs: 'project.edit',
      localChanges: false,
      changes: [],
    });
    const copied = new Map(mira.references.map((r) => [r.media.hash, r.media]));
    expect(
      applyVersion({ ...ctx(docs, item, v, { target: { kind: 'character', id: mira.id } }), copied }).write,
    ).toBeNull();
  });

  it('raises the lock for a changed identity, counts the stale takes and asks a director for approved clips', () => {
    const { mira, v, item } = miraItem();
    const linked = {
      ...mira,
      lock: { ...mira.lock, identityHash: identity.character(mira) },
      library: { itemId: item.id, version: 1, digest: v.digest, mode: 'used' as const, at: NOW, by: actor },
    };
    const v2 = version(
      item.id,
      'character',
      characterSnapshot({ ...mira, identity: { ...mira.identity, hair: 'silver crop' } }).payload,
      2,
    );
    const item2 = { ...item, current: 2, latest: 2 };
    const shot = f.readyShot([linked]);
    const extra = f.take({ characterLocks: { [mira.id]: 1 } });
    const approved = f.clip({
      shots: [{ ...shot, takes: [...shot.takes, extra] }],
      status: 'approved',
      title: 'Opening',
    });
    const docs = docsWith({ characters: { [mira.id]: linked }, clips: { [approved.id]: approved } });
    const plan = planApply(ctx(docs, item2, v2, { target: { kind: 'character', id: mira.id } }));
    expect(plan).toMatchObject({
      mode: 'update',
      lock: { locked: true, from: 1, to: 2 },
      staleTakes: 2,
      needs: 'project.approve',
      changes: ['identity'],
    });
    expect(plan.approvedClips).toEqual([{ id: approved.id, index: 0, title: 'Opening' }]);
    const out = applyVersion({
      ...ctx(docs, item2, v2, { target: { kind: 'character', id: mira.id } }),
      copied: new Map(mira.references.map((r) => [r.media.hash, r.media])),
    });
    expect(out.message).toBe('Update Mira from the library (v1 → v2)');
    expect(CharacterSchema.parse(out.write!.doc).library).toMatchObject({ version: 2, mode: 'updated' });
  });

  it('keeps every outfit its own id when one was renamed and a new one took its old name', () => {
    const dress = newId('wardrobe');
    const base = f.character({
      wardrobe: [{ id: dress, name: 'Dress', description: 'red dress', default: true }],
    });
    const v1 = version('lib_0000000000mira00', 'character', characterSnapshot(base).payload);
    const linked = {
      ...base,
      lock: { ...base.lock, identityHash: identity.character(base) },
      library: {
        itemId: v1.itemId,
        version: 1,
        digest: v1.digest,
        mode: 'used' as const,
        at: NOW,
        by: actor,
      },
    };
    const docs = docsWith({ characters: { [base.id]: linked } });
    // saved in another episode: the dress became a coat, and a new dress was added with a reference wearing it
    const coat = { id: dress, name: 'Coat', description: 'long grey coat', default: true };
    const blue = { id: newId('wardrobe'), name: 'Dress', description: 'blue dress' };
    const worn = f.reference({ view: 'full_body', wardrobeId: blue.id });
    const apply = (wardrobe: Character['wardrobe'], references = [...base.references, worn]) => {
      const v2 = version(
        v1.itemId,
        'character',
        characterSnapshot({ ...base, wardrobe, references }).payload,
        2,
      );
      const out = applyVersion({
        ...ctx(docs, itemOf(v2), v2, { target: { kind: 'character', id: base.id } }),
        copied: new Map(references.map((r) => [r.media.hash, r.media])),
      });
      return CharacterSchema.parse(out.write!.doc);
    };
    for (const wardrobe of [
      [coat, blue],
      [blue, coat],
    ]) {
      const doc = apply(wardrobe);
      expect(doc.wardrobe.map((w) => [w.id, w.name])).toEqual(wardrobe.map((w) => [w.id, w.name]));
      expect(doc.references.find((r) => r.id === worn.id)!.wardrobeId).toBe(blue.id);
    }
    // an outfit whose id was minted again (a writer's merge) still takes the target's by name
    const again = { ...blue, id: newId('wardrobe') };
    expect(apply([again], base.references).wardrobe.map((w) => w.id)).toEqual([dress]);
  });

  it('refuses relock: false on a locked target and an unlocked version onto a locked one', () => {
    const { mira, v, item } = miraItem();
    const docs = docsWith({ characters: { [mira.id]: mira } });
    expect(
      refusal(() =>
        planApply(ctx(docs, item, v, { target: { kind: 'character', id: mira.id }, relock: false })),
      ).code,
    ).toBe('character_locked');
    const harbor = f.element();
    const unlocked = version(
      'lib_0000000000harb00',
      'element',
      elementSnapshot({ ...harbor, lock: { locked: false, version: 0 } }).payload,
    );
    expect(
      refusal(() =>
        planApply(
          ctx(docsWith({ elements: { [harbor.id]: harbor } }), itemOf(unlocked), unlocked, {
            target: { kind: 'element', id: harbor.id },
          }),
        ),
      ).code,
    ).toBe('element_locked');
  });

  it('names both kinds with their articles when a version is applied to another kind of entity', () => {
    const { mira, v, item } = miraItem();
    const harbor = f.element();
    const docs = docsWith({ characters: { [mira.id]: mira }, elements: { [harbor.id]: harbor } });
    expect(() => planApply(ctx(docs, item, v, { target: { kind: 'element', id: harbor.id } }))).toThrow(
      'a library character applies to a character, not to an element',
    );
    const place = version('lib_0000000000harb00', 'element', elementSnapshot(harbor).payload);
    expect(() =>
      planApply(ctx(docs, itemOf(place), place, { target: { kind: 'character', id: mira.id } })),
    ).toThrow('a library element applies to an element, not to a character');
  });

  it('bumps a voice lock whose voice changed and stales the takes that spoke with it', () => {
    const voiceOld: Voice = {
      description: 'warm',
      provider: 'elevenlabs',
      voiceId: 'v1',
      source: 'designed',
      sample: f.media({ mime: 'audio/wav' }),
      candidates: [],
      lock: { locked: true, version: 1, identityHash: '' },
    };
    voiceOld.lock.identityHash = identity.voice(voiceOld);
    const mira = f.character({ voice: voiceOld });
    const withVoice2 = { ...mira, voice: { ...voiceOld, voiceId: 'v2' } };
    const v = version('lib_0000000000mira00', 'character', characterSnapshot(withVoice2).payload);
    const linked = { ...mira, lock: { ...mira.lock, identityHash: identity.character(mira) } };
    const spoken = f.take({
      characterLocks: { [mira.id]: 1 },
      audio: { mode: 'tts', dialogue: null, lines: [], voiceLocks: { [mira.id]: 1 }, lipSync: 'none' },
    });
    const clip = f.clip({
      shots: [f.shot({ characterIds: [mira.id], takes: [spoken], selectedTakeId: spoken.id })],
    });
    const docs = docsWith({ characters: { [mira.id]: linked }, clips: { [clip.id]: clip } });
    const plan = planApply(ctx(docs, itemOf(v), v, { target: { kind: 'character', id: mira.id } }));
    expect(plan.voiceLock).toEqual({ locked: true, from: 1, to: 2 });
    expect(plan.lock).toMatchObject({ from: 1, to: 1 });
    expect(plan.staleTakes).toBe(1);
    expect(plan.mode).toBe('link');
  });

  it('pins 3D units on the right targets only, never touching locks', () => {
    const mira = f.character();
    const harbor = f.element();
    const key = f.element({ kind: 'prop', name: 'Brass key' });
    const style = f.element({ kind: 'style', name: 'Noir' });
    const docs = docsWith({
      characters: { [mira.id]: mira },
      elements: { [harbor.id]: harbor, [key.id]: key, [style.id]: style },
    });
    const fig = deskVersion('desk-figure', 1, 'mannequin');
    const plan = planApply(ctx(docs, itemOf(fig), fig, { target: { kind: 'character', id: mira.id } }));
    expect(plan).toMatchObject({
      mode: 'pin',
      changes: ['deskUnit'],
      lock: { from: 1, to: 1 },
      staleTakes: 0,
      needs: 'project.edit',
    });
    const out = applyVersion({
      ...ctx(docs, itemOf(fig), fig, { target: { kind: 'character', id: mira.id } }),
      copied: new Map(),
    });
    const pinned = CharacterSchema.parse(out.write!.doc);
    expect(pinned.deskUnit).toMatchObject({
      kind: 'desk-figure',
      itemId: fig.itemId,
      version: 1,
      sha256: fig.digest,
      actorKind: 'mannequin',
      heightM: 1.7,
    });
    expect(pinned.lock).toEqual(mira.lock);
    expect(identity.character(pinned)).toBe(identity.character(mira));
    const set = deskVersion('desk-set');
    expect(planApply(ctx(docs, itemOf(set), set, { target: { kind: 'element', id: harbor.id } })).mode).toBe(
      'pin',
    );
    const prop = deskVersion('desk-prop');
    expect(planApply(ctx(docs, itemOf(prop), prop, { target: { kind: 'element', id: key.id } })).mode).toBe(
      'pin',
    );
    expect(
      refusal(() => planApply(ctx(docs, itemOf(set), set, { target: { kind: 'element', id: key.id } }))).code,
    ).toBe('validation_error');
    expect(
      refusal(() => planApply(ctx(docs, itemOf(set), set, { target: { kind: 'element', id: style.id } })))
        .code,
    ).toBe('validation_error');
    expect(refusal(() => planApply(ctx(docs, itemOf(set), set))).code).toBe('validation_error');
    expect(
      refusal(() => planApply(ctx(docs, itemOf(fig), fig, { target: { kind: 'element', id: harbor.id } })))
        .code,
    ).toBe('validation_error');
  });

  it('refuses to re-point another item pin with replacePin: false', () => {
    const harbor = {
      ...f.element(),
      deskUnit: DeskUnitPinSchema.parse({
        kind: 'desk-set',
        itemId: 'lib_0000000000otherx',
        version: 3,
        sha256: HASH('o'),
        name: 'Old harbor',
        actorKind: null,
        heightM: null,
        pinnedAt: NOW,
        pinnedBy: actor,
      }),
    };
    const docs = docsWith({ elements: { [harbor.id]: harbor } });
    const set = deskVersion('desk-set');
    expect(
      refusal(() =>
        planApply(
          ctx(docs, itemOf(set), set, { target: { kind: 'element', id: harbor.id }, replacePin: false }),
        ),
      ),
    ).toEqual({
      code: 'conflict',
      errors: [{ reason: 'pinned', itemId: 'lib_0000000000otherx' }],
    });
    expect(
      planApply(ctx(docs, itemOf(set), set, { target: { kind: 'element', id: harbor.id } })).changes,
    ).toEqual(['deskUnit']);
  });

  it('refuses with replacePin: false an update or link whose version pins another item there too', () => {
    const figure = (itemId: string, version: number) =>
      DeskUnitPinSchema.parse({
        kind: 'desk-figure',
        itemId,
        version,
        sha256: HASH(`${itemId}${version}`),
        name: 'Mira look',
        actorKind: 'mannequin',
        heightM: 1.7,
        pinnedAt: NOW,
        pinnedBy: actor,
      });
    const carried = ({ pinnedAt: _at, pinnedBy: _by, ...pin }: ReturnType<typeof figure>) => pin;
    const { mira, v, item } = miraItem();
    const linked = {
      ...mira,
      lock: { ...mira.lock, identityHash: identity.character(mira) },
      library: { itemId: item.id, version: 1, digest: v.digest, mode: 'used' as const, at: NOW, by: actor },
      deskUnit: figure('lib_0000000000figaaa', 1),
    };
    const payload = characterSnapshot(mira).payload;
    const other = version(
      item.id,
      'character',
      { ...payload, deskUnit: carried(figure('lib_0000000000figbbb', 2)) },
      2,
    );
    const target = { target: { kind: 'character', id: mira.id } };
    for (const entity of [linked, { ...linked, library: null }]) {
      const docs = docsWith({ characters: { [mira.id]: entity } });
      expect(
        refusal(() => planApply(ctx(docs, itemOf(other), other, { ...target, replacePin: false }))),
      ).toEqual({
        code: 'conflict',
        errors: [{ reason: 'pinned', itemId: 'lib_0000000000figaaa' }],
      });
      // by default the version's pin takes its place
      const out = applyVersion({
        ...ctx(docs, itemOf(other), other, target),
        copied: new Map(mira.references.map((r) => [r.media.hash, r.media])),
      });
      expect((out.write!.doc as Character).deskUnit).toMatchObject({
        itemId: 'lib_0000000000figbbb',
        version: 2,
      });
    }
    // another version of the item it pins is no other item's pin: it moves either way
    const same = version(
      item.id,
      'character',
      { ...payload, deskUnit: carried(figure('lib_0000000000figaaa', 2)) },
      2,
    );
    const docs = docsWith({ characters: { [mira.id]: linked } });
    expect(planApply(ctx(docs, itemOf(same), same, { ...target, replacePin: false })).changes).toContain(
      'deskUnit',
    );
  });

  it('keeps the entity pin for a version without one and moves it for a version with one', () => {
    const pin = DeskUnitPinSchema.parse({
      kind: 'desk-set',
      itemId: 'lib_0000000000deskaa',
      version: 1,
      sha256: HASH('p'),
      name: 'Harbor',
      actorKind: null,
      heightM: null,
      pinnedAt: NOW,
      pinnedBy: actor,
    });
    const harbor = { ...f.element(), lock: { locked: false, version: 0 }, deskUnit: pin };
    const docs = docsWith({ elements: { [harbor.id]: harbor } });
    const bare = version(
      'lib_0000000000harb00',
      'element',
      elementSnapshot({ ...harbor, deskUnit: null, lock: { locked: false, version: 0 } }).payload,
    );
    const kept = applyVersion({
      ...ctx(docs, itemOf(bare), bare, { target: { kind: 'element', id: harbor.id } }),
      copied: new Map(harbor.references.map((r) => [r.media.hash, r.media])),
    });
    expect((kept.write!.doc as Element).deskUnit).toEqual(pin);
    const v2pin = { ...pin, version: 2, sha256: HASH('p2') };
    const moved = version(
      'lib_0000000000harb00',
      'element',
      elementSnapshot({ ...harbor, deskUnit: v2pin }).payload,
      2,
    );
    const plan = planApply(ctx(docs, itemOf(moved), moved, { target: { kind: 'element', id: harbor.id } }));
    expect(plan.changes).toContain('deskUnit');
  });

  it('always makes a resource a new resource, with origin library', () => {
    const r = {
      id: newId('resource'),
      kind: 'image' as const,
      role: 'reference' as const,
      name: 'map.png',
      media: f.imageMedia(),
      createdAt: NOW,
      origin: 'upload' as const,
      status: 'ready' as const,
    };
    const v = version('lib_0000000000resou0', 'resource', {
      kind: 'image',
      role: 'reference',
      name: 'map.png',
      media: { hash: r.media.hash, mime: 'image/png', size: 500, name: 'map' },
    });
    const docs = docsWith({ resources: { [r.id]: r } });
    const out = applyVersion({
      ...ctx(docs, itemOf(v), v),
      copied: new Map([[r.media.hash, r.media]]),
      resourceId: newId('resource'),
    });
    const doc = ResourceSchema.parse(out.write!.doc);
    expect(doc.id).not.toBe(r.id);
    expect(doc.origin).toBe('library');
    expect(doc.library).toMatchObject({ mode: 'used', version: 1 });
    expect(
      refusal(() =>
        planApply(ctx(docs, itemOf(v), v, { target: { kind: 'character', id: f.character().id } })),
      ).code,
    ).toBe('validation_error');
  });

  it('refuses an archived item where it is not used yet, and lets its users move between versions', () => {
    const { mira, v, item } = miraItem();
    const archived = { ...item, archived: true };
    expect(refusal(() => planApply(ctx(docsWith(), archived, v))).errors).toEqual([
      { reason: 'archived', itemId: item.id },
    ]);
    const linked = {
      ...mira,
      library: { itemId: item.id, version: 1, digest: v.digest, mode: 'used' as const, at: NOW, by: actor },
    };
    expect(
      planApply(
        ctx(docsWith({ characters: { [mira.id]: linked } }), archived, v, {
          target: { kind: 'character', id: mira.id },
        }),
      ).mode,
    ).toBe('update');
  });

  it('says when a version shows a real person, and whose consent it carries', () => {
    const consent = {
      depictsRealPerson: true,
      subject: 'Mira Actor',
      grantedBy: 'Mira Actor',
      grantedAt: NOW,
      scope: 'the studio',
      recordedBy: actor,
      recordedAt: NOW,
    };
    const real = f.character({ references: [f.reference({ consent })] });
    const v = version('lib_0000000000mira00', 'character', characterSnapshot(real).payload);
    expect(v.realPerson).toBe(true);
    expect(planApply(ctx(docsWith(), itemOf(v, { entityId: real.id }), v)).realPerson).toBe(true);
    expect(consentSubjects('character', v.payload)).toEqual([
      { what: 'reference', subject: 'Mira Actor', scope: 'the studio' },
    ]);
    const { v: plain, item } = miraItem();
    expect(planApply(ctx(docsWith(), item, plain)).realPerson).toBe(false);
    expect(consentSubjects('character', plain.payload)).toEqual([]);
  });

  it('reports local edits since the linked version', () => {
    const { mira, v, item } = miraItem();
    const edited = {
      ...mira,
      lock: { locked: false, version: 1 },
      summary: 'A pilot of the harbour.',
      library: { itemId: item.id, version: 1, digest: v.digest, mode: 'used' as const, at: NOW, by: actor },
    };
    const plan = planApply(
      ctx(docsWith({ characters: { [mira.id]: edited } }), item, v, {
        target: { kind: 'character', id: mira.id },
      }),
    );
    expect(plan.localChanges).toBe(true);
    expect(plan.changes).toContain('summary');
  });

  it('counts no edit made here for a pin or a voice the apply keeps', () => {
    const { mira, v, item } = miraItem();
    const used = {
      ...mira,
      lock: { ...mira.lock, identityHash: identity.character(mira) },
      library: { itemId: item.id, version: 1, digest: v.digest, mode: 'used' as const, at: NOW, by: actor },
    };
    const figure = (version: number) =>
      DeskUnitPinSchema.parse({
        kind: 'desk-figure',
        itemId: 'lib_0000000000figaaa',
        version,
        sha256: HASH(`figure${version}`),
        name: 'Mira look',
        actorKind: 'mannequin',
        heightM: 1.7,
        pinnedAt: NOW,
        pinnedBy: actor,
      });
    // a 3D figure pinned here after Use: the pin is shape, which no version without a pin replaces
    const pinned: Character = { ...used, deskUnit: figure(1) };
    const plan = (c: Character, ver: LibraryVersion) =>
      planApply(
        ctx(docsWith({ characters: { [mira.id]: c } }), itemOf(ver), ver, {
          target: { kind: 'character', id: mira.id },
        }),
      );
    expect(plan(pinned, v)).toMatchObject({ mode: 'update', changes: [], localChanges: false });
    const silver = characterSnapshot({
      ...mira,
      identity: { ...mira.identity, hair: 'silver crop' },
    }).payload;
    const v2 = version(item.id, 'character', silver, 2);
    expect(plan(pinned, v2)).toMatchObject({ changes: ['identity'], localChanges: false });
    const kept = applyVersion({
      ...ctx(docsWith({ characters: { [mira.id]: pinned } }), itemOf(v2), v2, {
        target: { kind: 'character', id: mira.id },
      }),
      copied: new Map(mira.references.map((r) => [r.media.hash, r.media])),
    });
    expect((kept.write!.doc as Character).deskUnit).toEqual(pinned.deskUnit);
    // a version carrying that very pin keeps it too; one carrying another replaces it, and says so
    const { pinnedAt: _at, pinnedBy: _by, ...carried } = figure(1);
    expect(
      plan(pinned, version(item.id, 'character', { ...silver, deskUnit: carried }, 2)).localChanges,
    ).toBe(false);
    const moved = version(item.id, 'character', { ...silver, deskUnit: { ...carried, version: 2 } }, 2);
    expect(plan(pinned, moved)).toMatchObject({ changes: ['identity', 'deskUnit'], localChanges: true });
    // an edit made here besides the pin is still said
    expect(plan({ ...pinned, summary: 'A pilot of the harbour.' }, v2).localChanges).toBe(true);
    // a voice designed here, which a version without a voice leaves as it is
    const voice: Voice = {
      description: 'warm alto',
      provider: 'elevenlabs',
      voiceId: 'v-designed',
      source: 'designed',
      sample: f.media({ mime: 'audio/mpeg' }),
      candidates: [],
      lock: { locked: false, version: 0 },
    };
    expect(plan({ ...pinned, voice }, v2).localChanges).toBe(false);
    // linking a character that differs from the version only by what the link keeps
    expect(plan({ ...pinned, voice, library: null }, v)).toMatchObject({ mode: 'link', localChanges: false });
  });
});

describe('libraryUses', () => {
  it('lists links and pins in a stable order', () => {
    const pin = DeskUnitPinSchema.parse({
      kind: 'desk-figure',
      itemId: 'lib_0000000000fig000',
      version: 2,
      sha256: HASH('f'),
      name: 'Look',
      actorKind: null,
      heightM: null,
      pinnedAt: NOW,
      pinnedBy: actor,
    });
    const mira = {
      ...f.character(),
      library: {
        itemId: 'lib_0000000000mira00',
        version: 1,
        digest: HASH('d'),
        mode: 'used' as const,
        at: NOW,
        by: actor,
      },
      deskUnit: pin,
    };
    const rows = libraryUses(docsWith({ characters: { [mira.id]: mira } }));
    expect(rows).toEqual([
      {
        itemId: 'lib_0000000000fig000',
        version: 2,
        via: 'deskUnit',
        entity: { kind: 'character', id: mira.id, name: 'Mira' },
      },
      {
        itemId: 'lib_0000000000mira00',
        version: 1,
        via: 'library',
        entity: { kind: 'character', id: mira.id, name: 'Mira' },
      },
    ]);
    expect(libraryUses(docsWith())).toEqual([]);
  });
});
