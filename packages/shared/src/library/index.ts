import { isStale } from '../consistency';
import { deskStateUses } from '../desk/units';
import { newId } from '../ids';
import {
  approvedReferences,
  type Character,
  type CharacterReference,
  type Consent,
  REFERENCE_VIEW_PRIORITY,
  type Voice,
  voiceOf,
} from '../schemas/character';
import type { Clip } from '../schemas/clip';
import type { Actor, ErrorCode, MediaRef } from '../schemas/common';
import type { ProjectDocs } from '../schemas/documents';
import {
  approvedElementReferences,
  ELEMENT_VIEW_PRIORITY,
  type Element,
  type ElementReference,
} from '../schemas/element';
import {
  type CharacterSnapshot,
  type DeskUnitSnapshot,
  type DigestLibraryUse,
  type ElementSnapshot,
  LIBRARY_CHANGES,
  LIBRARY_LIMITS,
  type LibraryApplyInput,
  type LibraryApplyPlan,
  type LibraryItem,
  type LibraryKind,
  type LibraryMedia,
  type LibraryPayload,
  type LibrarySnapshotPin,
  type LibraryVersion,
  type ResourceSnapshot,
  type VoiceSnapshot,
} from '../schemas/library';
import { type DeskUnitPin, deskUnitKindFor, type LibraryOrigin } from '../schemas/library-link';
import type { Resource } from '../schemas/resource';
import { canonicalJson } from '../util/canonical-json';
import { slugify } from '../util/hash';
import { withArticle } from '../util/text';

/**
 * The studio library's pure rules (docs/design/library.md): snapshots of a project's entities, the snapshot digest,
 * what an apply does (`planApply`) and the document it writes (`applyVersion`), and where a project uses the library
 * (`libraryUses`). The server runs them; the web reads the same types.
 */

/** A refusal with a stable code (the server answers it as that code's status). */
export class LibraryError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly errors: unknown[] = [],
  ) {
    super(message);
    this.name = 'LibraryError';
  }
}

// ---------------------------------------------------------------- media

/** `Pick` over each member of a union (keeps a version's kind and payload together). */
type DistributivePick<T, K extends keyof T> = T extends unknown ? Pick<T, K> : never;
/** A version's kind and payload, still discriminated. */
export type LibraryVersionContent = DistributivePick<LibraryVersion, 'kind' | 'payload'>;

const MEDIA_FIELDS = [
  'width',
  'height',
  'durationSec',
  'hasAudio',
  'fps',
  'videoCodec',
  'audioCodec',
] as const;

function mediaFields(m: Partial<Pick<MediaRef, (typeof MEDIA_FIELDS)[number]>>) {
  const out: Partial<Pick<MediaRef, (typeof MEDIA_FIELDS)[number]>> = {};
  for (const k of MEDIA_FIELDS) if (m[k] !== undefined) (out as Record<string, unknown>)[k] = m[k];
  return out;
}

/** The stem of a project media path (`media/refs/mira-front-0123456789ab.png` → `mira-front`). */
export function mediaStem(path: string): string {
  const file = path.split('/').pop() ?? '';
  return slugify(file.replace(/\.[^.]+$/, '').replace(/-[0-9a-f]{12}$/, ''), 60);
}

/** A project's media file as the library names it (its poster is added by the server, which hashes it). */
export function libraryMediaOf(ref: MediaRef): LibraryMedia {
  return { hash: ref.hash, mime: ref.mime, size: ref.size, ...mediaFields(ref), name: mediaStem(ref.path) };
}

/** A library file copied into a project at `path` (and its poster at `poster`), with its media fields. */
export function projectMediaOf(
  m: LibraryMedia,
  path: string,
  poster?: { path: string; mime: string } | null,
): MediaRef {
  return {
    path,
    hash: m.hash,
    mime: m.mime,
    size: m.size,
    ...mediaFields(m),
    ...(poster ? { poster: { path: poster.path, mime: poster.mime } } : {}),
  };
}

/** A library file of a version: its sha256, type and size. */
export interface LibraryFileRef {
  hash: string;
  mime: string;
  size: number;
}

/** The media a version's payload names (its thumbnail left out). */
export function payloadMedia(v: LibraryVersionContent): LibraryMedia[] {
  switch (v.kind) {
    case 'character': {
      const p = v.payload;
      return [...p.references.map((r) => r.media), ...(p.voice?.sample ? [p.voice.sample] : [])];
    }
    case 'element':
      return v.payload.references.map((r) => r.media);
    case 'resource':
      return [v.payload.media];
    default:
      return [v.payload.payload];
  }
}

/** Every file a version names, its thumbnail and posters included, each once. */
export function versionFiles(
  v: DistributivePick<LibraryVersion, 'kind' | 'payload' | 'thumbnail'>,
): LibraryFileRef[] {
  const out = new Map<string, LibraryFileRef>();
  const add = (f: LibraryFileRef | null | undefined) => {
    if (f && !out.has(f.hash)) out.set(f.hash, { hash: f.hash, mime: f.mime, size: f.size });
  };
  for (const m of [...payloadMedia(v), ...(v.thumbnail ? [v.thumbnail] : [])]) {
    add(m);
    add(m.poster);
  }
  return [...out.values()];
}

// ---------------------------------------------------------------- snapshots

export interface LibrarySnapshot<P> {
  payload: P;
  /** The project media the payload names: what a save copies into the library. */
  files: MediaRef[];
}

function snapshotPin(p: DeskUnitPin | null | undefined): LibrarySnapshotPin | null {
  if (!p) return null;
  return {
    kind: p.kind,
    itemId: p.itemId,
    version: p.version,
    sha256: p.sha256,
    name: p.name,
    actorKind: p.actorKind,
    heightM: p.heightM,
  };
}

export function voiceSnapshot(v: Voice): LibrarySnapshot<VoiceSnapshot> {
  return {
    payload: {
      description: v.description,
      provider: v.provider,
      voiceId: v.voiceId,
      source: v.source,
      sample: v.sample ? libraryMediaOf(v.sample) : null,
      ...(v.consent ? { consent: v.consent } : {}),
      locked: v.lock.locked,
    },
    files: v.sample ? [v.sample] : [],
  };
}

/** A character's library-owned content: approved references only, voice candidates and lock bookkeeping left out. */
export function characterSnapshot(c: Character): LibrarySnapshot<CharacterSnapshot> {
  const refs = approvedReferences(c);
  const voice = c.voice ? voiceSnapshot(c.voice) : null;
  return {
    payload: {
      name: c.name,
      role: c.role,
      summary: c.summary,
      identity: c.identity,
      wardrobe: c.wardrobe,
      ...(c.personality !== undefined ? { personality: c.personality } : {}),
      references: refs.map((r) => ({
        id: r.id,
        view: r.view,
        media: libraryMediaOf(r.media),
        source: r.source,
        approved: true,
        ...(r.wardrobeId ? { wardrobeId: r.wardrobeId } : {}),
        createdAt: r.createdAt,
        ...(r.consent ? { consent: r.consent } : {}),
      })),
      voice: voice?.payload ?? null,
      seed: c.seed,
      locked: c.lock.locked,
      deskUnit: snapshotPin(c.deskUnit),
    },
    files: [...refs.map((r) => r.media), ...(voice?.files ?? [])],
  };
}

export function elementSnapshot(e: Element): LibrarySnapshot<ElementSnapshot> {
  const refs = approvedElementReferences(e);
  return {
    payload: {
      kind: e.kind,
      name: e.name,
      description: e.description,
      aliases: e.aliases,
      references: refs.map((r) => ({
        id: r.id,
        view: r.view,
        media: libraryMediaOf(r.media),
        source: r.source,
        approved: true,
        createdAt: r.createdAt,
      })),
      seed: e.seed,
      locked: e.lock.locked,
      deskUnit: snapshotPin(e.deskUnit),
    },
    files: refs.map((r) => r.media),
  };
}

export function resourceSnapshot(r: Resource): LibrarySnapshot<ResourceSnapshot> {
  return {
    payload: {
      kind: r.kind,
      role: r.role,
      name: r.name,
      ...(r.notes ? { notes: r.notes } : {}),
      media: libraryMediaOf(r.media),
    },
    files: [r.media],
  };
}

export type LibraryEntityKind = 'character' | 'element' | 'resource';
export type LibraryEntity = Character | Element | Resource;

export function entitySnapshot(
  kind: LibraryEntityKind,
  entity: LibraryEntity,
): LibrarySnapshot<LibraryPayload> {
  if (kind === 'character') return characterSnapshot(entity as Character);
  if (kind === 'element') return elementSnapshot(entity as Element);
  return resourceSnapshot(entity as Resource);
}

// ---------------------------------------------------------------- the snapshot digest

const mediaDigestInput = (m: { hash: string; mime: string } | null | undefined) =>
  m ? { hash: m.hash, mime: m.mime } : null;
const consentDigestInput = (c: Consent | undefined) => {
  if (!c) return null;
  const { recordedAt: _recordedAt, ...rest } = c;
  return rest;
};
const pinDigestInput = (p: LibrarySnapshotPin | null) =>
  p ? { kind: p.kind, itemId: p.itemId, version: p.version, sha256: p.sha256 } : null;

/**
 * What the snapshot digest hashes (docs/design/library.md#the-three-hashes): the content, without the ids a copy or a
 * writer's merge mints again (reference ids, wardrobe ids: a reference names its outfit by position), the references'
 * `createdAt`, `consent.recordedAt` and the files' names.
 */
export function libraryDigestInput(kind: LibraryKind, payload: LibraryPayload): unknown {
  switch (kind) {
    case 'character': {
      const p = payload as CharacterSnapshot;
      const outfit = new Map(p.wardrobe.map((w, i) => [w.id, i]));
      return {
        kind,
        name: p.name,
        role: p.role,
        summary: p.summary,
        identity: p.identity,
        wardrobe: p.wardrobe.map((w) => ({ name: w.name, description: w.description, default: !!w.default })),
        personality: p.personality ?? null,
        references: p.references.map((r) => ({
          view: r.view,
          media: mediaDigestInput(r.media),
          source: r.source,
          outfit: r.wardrobeId !== undefined ? (outfit.get(r.wardrobeId) ?? null) : null,
          consent: consentDigestInput(r.consent),
        })),
        voice: p.voice
          ? {
              description: p.voice.description,
              provider: p.voice.provider,
              voiceId: p.voice.voiceId,
              source: p.voice.source,
              sample: mediaDigestInput(p.voice.sample),
              consent: consentDigestInput(p.voice.consent),
              locked: p.voice.locked,
            }
          : null,
        seed: p.seed,
        locked: p.locked,
        deskUnit: pinDigestInput(p.deskUnit),
      };
    }
    case 'element': {
      const p = payload as ElementSnapshot;
      return {
        kind,
        elementKind: p.kind,
        name: p.name,
        description: p.description,
        aliases: p.aliases,
        references: p.references.map((r) => ({
          view: r.view,
          media: mediaDigestInput(r.media),
          source: r.source,
        })),
        seed: p.seed,
        locked: p.locked,
        deskUnit: pinDigestInput(p.deskUnit),
      };
    }
    case 'resource': {
      const p = payload as ResourceSnapshot;
      return {
        kind,
        resourceKind: p.kind,
        role: p.role,
        name: p.name,
        notes: p.notes ?? null,
        media: mediaDigestInput(p.media),
      };
    }
    default:
      return { kind, sha256: (payload as DeskUnitSnapshot).payload.hash };
  }
}

/** A version's digest: a 3D unit's file sha256, else sha256 of the canonical digest input. */
export function libraryDigest(
  kind: LibraryKind,
  payload: LibraryPayload,
  sha256: (text: string) => string,
): string {
  if (kind === 'desk-set' || kind === 'desk-prop' || kind === 'desk-figure')
    return (payload as DeskUnitSnapshot).payload.hash;
  return sha256(canonicalJson(libraryDigestInput(kind, payload)));
}

// ---------------------------------------------------------------- real people, thumbnails, locks

/** The version shows a real person: an approved reference that depicts one, or a cloned voice of one. */
export function isRealPersonSnapshot(kind: LibraryKind, payload: LibraryPayload): boolean {
  if (kind !== 'character') return false;
  const p = payload as CharacterSnapshot;
  return (
    p.references.some((r) => r.consent?.depictsRealPerson === true) ||
    (p.voice?.source === 'cloned' && p.voice.consent?.depictsRealPerson === true)
  );
}

/** The real people of a version and what their consent covers (never names in audit records: these go to the caller). */
export function consentSubjects(
  kind: LibraryKind,
  payload: LibraryPayload,
): { what: 'reference' | 'voice'; subject: string | null; scope: string | null }[] {
  if (kind !== 'character') return [];
  const p = payload as CharacterSnapshot;
  const out: { what: 'reference' | 'voice'; subject: string | null; scope: string | null }[] = [];
  for (const r of p.references)
    if (r.consent?.depictsRealPerson)
      out.push({ what: 'reference', subject: r.consent.subject ?? null, scope: r.consent.scope ?? null });
  if (p.voice?.source === 'cloned' && p.voice.consent?.depictsRealPerson)
    out.push({
      what: 'voice',
      subject: p.voice.consent.subject ?? null,
      scope: p.voice.consent.scope ?? null,
    });
  return out;
}

/**
 * The file a server-made thumbnail is drawn from: a character's or element's first approved reference by view
 * priority, an image resource, a video resource's poster (or the video); none for audio and LUTs.
 */
export function thumbnailSource(v: LibraryVersionContent): LibraryFileRef | null {
  switch (v.kind) {
    case 'character': {
      const order = (r: { view: string }) => REFERENCE_VIEW_PRIORITY.indexOf(r.view as never);
      return [...v.payload.references].sort((a, b) => order(a) - order(b))[0]?.media ?? null;
    }
    case 'element': {
      const order = (r: { view: string }) => ELEMENT_VIEW_PRIORITY.indexOf(r.view as never);
      return [...v.payload.references].sort((a, b) => order(a) - order(b))[0]?.media ?? null;
    }
    case 'resource': {
      const m = v.payload.media;
      if (v.payload.kind === 'image') return m;
      if (v.payload.kind === 'video') return m.poster ?? m;
      return null;
    }
    default:
      return null;
  }
}

export type LibraryApplyDocs = Pick<
  ProjectDocs,
  'characters' | 'elements' | 'resources' | 'clips' | 'localizations'
>;

/**
 * The highest lock version any take, board frame or dub of the project recorded for a character, element or voice:
 * a library entity created here starts above it, so no old take is current by accident (rule R9).
 */
export function maxRecordedLock(
  docs: Pick<ProjectDocs, 'clips' | 'localizations'>,
  kind: 'character' | 'element' | 'voice',
  id: string,
): number {
  return recordedLock(docs, kind, id) ?? 0;
}

/** The highest lock version recorded for that id, as `maxRecordedLock`; null when nothing recorded one, not even 0. */
function recordedLock(
  docs: Pick<ProjectDocs, 'clips' | 'localizations'>,
  kind: 'character' | 'element' | 'voice',
  id: string,
): number | null {
  let max: number | null = null;
  const seen = (locks: Record<string, number> | undefined) => {
    const v = locks?.[id];
    if (v !== undefined && (max === null || v > max)) max = v;
  };
  for (const clip of Object.values(docs.clips))
    for (const shot of clip.shots)
      for (const g of [...shot.takes, ...(shot.board ? [shot.board] : [])]) {
        if (kind === 'character') seen(g.characterLocks);
        else if (kind === 'element') seen(g.elementLocks);
        else seen(g.audio?.voiceLocks);
      }
  if (kind === 'voice')
    for (const loc of Object.values(docs.localizations))
      for (const dub of Object.values(loc.dubs)) seen(dub.voiceLocks);
  return max;
}

// ---------------------------------------------------------------- apply

/** The identity hashes of the lock rules (the server's `identityHash`, `elementIdentityHash`, `voiceIdentityHash`). */
export interface LibraryIdentityHashes {
  character(c: Character): string;
  element(e: Element): string;
  voice(v: Voice): string;
}

export interface LibraryApplyContext {
  docs: LibraryApplyDocs;
  item: LibraryItem;
  version: LibraryVersion;
  input: LibraryApplyInput;
  /** sha256 in hex of a UTF-8 text: the snapshot digests that tell local edits. */
  sha256: (text: string) => string;
  identity: LibraryIdentityHashes;
  actor: Actor;
  now: string;
  /** The media hashes the project already holds: files an apply does not copy. */
  present?: ReadonlySet<string>;
  /** The id a resource gets (Use in project). */
  resourceId?: string;
}

export interface LibraryApplyWrite {
  path: string;
  doc: LibraryEntity;
}

interface Resolved {
  plan: LibraryApplyPlan;
  /** The document the commit writes; null when the apply changes nothing. */
  write: LibraryApplyWrite | null;
  /** The commit's message. */
  message: string;
}

type MediaResolver = (m: LibraryMedia) => MediaRef;

/** A stand-in project file for planning: identity hashes read only `hash`. */
const plannedMedia: MediaResolver = (m) => projectMediaOf(m, `media/library/${m.hash.slice(0, 12)}.bin`);

const NOUN: Record<'desk-set' | 'desk-prop' | 'desk-figure', string> = {
  'desk-set': 'set',
  'desk-prop': 'prop',
  'desk-figure': 'figure',
};

/**
 * What applying a version does (docs/design/library.md#use-in-project-update-and-link-apply): create, update, link or
 * pin; the lock versions before and after; the takes it makes stale and the approved clips whose selected takes go
 * stale (`needs: 'project.approve'`); the files to copy. Throws `LibraryError` for what it refuses.
 */
export function planApply(ctx: LibraryApplyContext): LibraryApplyPlan {
  return resolveApply(ctx, plannedMedia).plan;
}

/**
 * The document an apply writes, with its plan and commit message: `copied` maps each library file's sha256 to its
 * copy in the project. Run inside the commit, on the documents at its tip.
 */
export function applyVersion(ctx: LibraryApplyContext & { copied: ReadonlyMap<string, MediaRef> }): Resolved {
  return resolveApply(ctx, (m) => {
    const ref = ctx.copied.get(m.hash);
    if (!ref)
      throw new LibraryError('storage_error', `the library file ${m.hash} was not copied into the project`);
    return ref;
  });
}

function resolveApply(ctx: LibraryApplyContext, media: MediaResolver): Resolved {
  const { item, version } = ctx;
  if (version.itemId !== item.id || version.kind !== item.kind)
    throw new LibraryError('validation_error', `version ${version.version} is not a version of ${item.name}`);
  switch (version.kind) {
    case 'desk-set':
    case 'desk-prop':
    case 'desk-figure':
      return resolvePin(ctx, version.kind, version.payload);
    case 'resource':
      return resolveResource(ctx, version.payload, media);
    case 'character':
      return resolveCharacter(ctx, version.payload, media);
    case 'element':
      return resolveElement(ctx, version.payload, media);
  }
}

function filesOf(ctx: LibraryApplyContext, copiedHere: boolean): LibraryApplyPlan['files'] {
  if (!copiedHere) {
    const bytes = versionFiles(ctx.version)
      .filter((f) => f.hash === (ctx.version.payload as DeskUnitSnapshot).payload?.hash)
      .reduce((s, f) => s + f.size, 0);
    return { count: 1, bytes, toCopy: 0, bytesToCopy: 0 };
  }
  const files = new Map<string, number>();
  for (const m of payloadMedia(ctx.version)) {
    files.set(m.hash, m.size);
    if (m.poster) files.set(m.poster.hash, m.poster.size);
  }
  let toCopy = 0;
  let bytesToCopy = 0;
  let bytes = 0;
  for (const [hash, size] of files) {
    bytes += size;
    if (!ctx.present?.has(hash)) {
      toCopy++;
      bytesToCopy += size;
    }
  }
  return { count: files.size, bytes, toCopy, bytesToCopy };
}

function origin(ctx: LibraryApplyContext, mode: LibraryOrigin['mode']): LibraryOrigin {
  return {
    itemId: ctx.item.id,
    version: ctx.version.version,
    digest: ctx.version.digest,
    mode,
    at: ctx.now,
    by: ctx.actor,
  };
}

function itemOf(ctx: LibraryApplyContext): LibraryApplyPlan['item'] {
  return {
    id: ctx.item.id,
    kind: ctx.item.kind,
    name: ctx.item.name,
    version: ctx.version.version,
    digest: ctx.version.digest,
    current: ctx.item.current,
  };
}

/** An archived item is applied only to an entity that already uses it (docs/design/library.md#use-in-project-update-and-link-apply). */
function refuseArchived(ctx: LibraryApplyContext, usesIt: boolean): void {
  if (ctx.item.archived && !usesIt)
    throw new LibraryError(
      'conflict',
      `${ctx.item.name} is archived: unarchive it before using it in another place`,
      [{ reason: 'archived', itemId: ctx.item.id }],
    );
}

function resolvePin(
  ctx: LibraryApplyContext,
  kind: 'desk-set' | 'desk-prop' | 'desk-figure',
  payload: DeskUnitSnapshot,
): Resolved {
  const noun = NOUN[kind];
  const target = ctx.input.target;
  if (!target)
    throw new LibraryError(
      'validation_error',
      `a 3D ${noun} is pinned on ${kind === 'desk-figure' ? 'a character' : kind === 'desk-set' ? 'a location' : 'a prop'}: give its target`,
    );
  const entity: Character | Element | undefined =
    target.kind === 'character' ? own(ctx.docs.characters, target.id) : own(ctx.docs.elements, target.id);
  if (!entity) throw new LibraryError('not_found', `${target.kind} ${target.id} not found`);
  const fits =
    target.kind === 'character'
      ? deskUnitKindFor({ kind: 'character' })
      : deskUnitKindFor({ kind: 'element', elementKind: (entity as Element).kind });
  if (fits === null)
    throw new LibraryError('validation_error', `${entity.name} is a style: a style has no 3D unit`);
  if (fits !== kind)
    throw new LibraryError(
      'validation_error',
      `a 3D ${noun} cannot be pinned on ${entity.name}, which takes a 3D ${NOUN[fits]}`,
    );
  const current = entity.deskUnit ?? null;
  refuseArchived(ctx, current?.itemId === ctx.item.id);
  if (current && current.itemId !== ctx.item.id && !ctx.input.replacePin)
    throw new LibraryError('conflict', `${entity.name} uses another library ${noun} (${current.name})`, [
      { reason: 'pinned', itemId: current.itemId },
    ]);
  const same =
    !!current &&
    current.itemId === ctx.item.id &&
    current.version === ctx.version.version &&
    current.sha256 === ctx.version.digest;
  const actor = kind === 'desk-figure' ? payload.meta.actor : null;
  const pin: DeskUnitPin = {
    kind,
    itemId: ctx.item.id,
    version: ctx.version.version,
    sha256: ctx.version.digest,
    name: ctx.item.name,
    actorKind: actor?.kind ?? null,
    heightM: actor?.heightM ?? null,
    pinnedAt: ctx.now,
    pinnedBy: ctx.actor,
  };
  const plan: LibraryApplyPlan = {
    mode: 'pin',
    item: itemOf(ctx),
    entity: { kind: target.kind, id: entity.id, name: entity.name, exists: true },
    keepsLibraryId: false,
    changes: same ? [] : ['deskUnit'],
    lock: { locked: entity.lock.locked, from: entity.lock.version, to: entity.lock.version },
    voiceLock: null,
    staleTakes: 0,
    approvedClips: [],
    localChanges: false,
    realPerson: false,
    files: filesOf(ctx, false),
    warnings: [],
    needs: 'project.edit',
  };
  const path = target.kind === 'character' ? `characters/${entity.id}.json` : `elements/${entity.id}.json`;
  return {
    plan,
    write: same ? null : { path, doc: { ...entity, deskUnit: pin } },
    message: `Use the 3D ${noun} ${ctx.item.name} v${ctx.version.version} for ${entity.name}`,
  };
}

function resolveResource(
  ctx: LibraryApplyContext,
  payload: ResourceSnapshot,
  media: MediaResolver,
): Resolved {
  if (ctx.input.target)
    throw new LibraryError('validation_error', 'a library resource is always used as a new resource');
  refuseArchived(ctx, false);
  const id = ctx.resourceId ?? newId('resource');
  const doc: Resource = {
    id,
    kind: payload.kind,
    role: payload.role,
    name: payload.name,
    media: media(payload.media),
    createdAt: ctx.now,
    origin: 'library',
    status: 'ready',
    ...(payload.notes ? { notes: payload.notes } : {}),
    library: origin(ctx, 'used'),
  };
  return {
    plan: {
      mode: 'create',
      item: itemOf(ctx),
      entity: { kind: 'resource', id, name: payload.name, exists: false },
      keepsLibraryId: false,
      changes: ['media'],
      lock: { locked: false, from: null, to: null },
      voiceLock: null,
      staleTakes: 0,
      approvedClips: [],
      localChanges: false,
      realPerson: ctx.version.realPerson,
      files: filesOf(ctx, true),
      warnings: [],
      needs: 'project.edit',
    },
    write: { path: `resources/${id}.json`, doc },
    message: `Use ${payload.name} from the library (v${ctx.version.version})`,
  };
}

/** The takes an apply makes stale, and the approved clips whose selected takes go stale. */
function staleness(
  docs: LibraryApplyDocs,
  after: Pick<ProjectDocs, 'characters' | 'elements'>,
): Pick<LibraryApplyPlan, 'staleTakes' | 'approvedClips'> {
  let staleTakes = 0;
  const approved = new Map<string, Clip>();
  for (const clip of Object.values(docs.clips))
    for (const shot of clip.shots)
      for (const take of shot.takes) {
        if (isStale(take, shot, docs.characters, docs.elements)) continue;
        if (!isStale(take, shot, after.characters, after.elements)) continue;
        staleTakes++;
        if (clip.status === 'approved' && shot.selectedTakeId === take.id) approved.set(clip.id, clip);
      }
  return {
    staleTakes,
    approvedClips: [...approved.values()]
      .sort((a, b) => a.index - b.index)
      .slice(0, 500)
      .map((c) => ({ id: c.id, index: c.index, title: c.title })),
  };
}

interface LockOutcome {
  lock: Character['lock'];
  from: number | null;
}

/**
 * The lock an apply leaves (docs/design/library.md#use-in-project-update-and-link-apply): a create is locked only if
 * the version was saved locked, and locked or not it is above every version the project recorded, 0 included (an
 * unlocked one that nothing recorded starts at 0), so no old take of that id is current by accident; an update relocks
 * with the existing rule (the version kept when the identity hash is unchanged, else raised); `relock: false` on a
 * locked entity, or an unlocked version onto a locked one, is refused. `recorded` is null when nothing recorded the id.
 */
function relock(
  current: Character['lock'] | null,
  versionLocked: boolean,
  hash: string,
  recorded: number | null,
  ctx: LibraryApplyContext,
  refuse: (why: string) => LibraryError,
): LockOutcome {
  if (!current) {
    return versionLocked
      ? {
          lock: {
            locked: true,
            version: (recorded ?? 0) + 1,
            lockedAt: ctx.now,
            lockedBy: ctx.actor,
            identityHash: hash,
          },
          from: null,
        }
      : { lock: { locked: false, version: recorded === null ? 0 : recorded + 1 }, from: null };
  }
  if (current.locked && !ctx.input.relock) throw refuse('relock it (relock: true) or unlock it first');
  if (current.locked && !versionLocked)
    throw refuse('this version was saved unlocked; unlock it first to take an unlocked version');
  if (!current.locked && !versionLocked) return { lock: current, from: current.version };
  const keep = current.identityHash === hash && current.version > 0;
  if (keep && current.locked) return { lock: current, from: current.version };
  return {
    lock: {
      locked: true,
      version: keep ? current.version : Math.max(current.version, recorded ?? 0) + 1,
      lockedAt: ctx.now,
      lockedBy: ctx.actor,
      identityHash: hash,
    },
    from: current.version,
  };
}

const own = <T>(map: Record<string, T>, id: string): T | undefined =>
  Object.hasOwn(map, id) ? map[id] : undefined;

/** The changed fields among `keys` of two digest inputs. */
function changed(before: unknown, after: unknown, keys: readonly string[]): LibraryApplyPlan['changes'] {
  const a = (before ?? {}) as Record<string, unknown>;
  const b = after as Record<string, unknown>;
  return keys.filter(
    (k) => (LIBRARY_CHANGES as readonly string[]).includes(k) && canonicalJson(a[k]) !== canonicalJson(b[k]),
  ) as LibraryApplyPlan['changes'];
}

function targetOf(ctx: LibraryApplyContext, kind: 'character' | 'element') {
  const target = ctx.input.target;
  if (!target) return null;
  if (target.kind !== kind)
    throw new LibraryError(
      'validation_error',
      `a library ${kind} applies to ${withArticle(kind)}, not to ${withArticle(target.kind)}`,
    );
  return target.id;
}

/** An update or link keeps the entity's pin: the version carries none, or the very pin the entity has. */
const keepsPin = (snapshot: LibrarySnapshotPin | null, current: DeskUnitPin | null | undefined) =>
  !snapshot || (!!current && current.itemId === snapshot.itemId && current.version === snapshot.version);

/**
 * The entity's pin after an update, link or create: the version's pin when it carries one, else the entity's own. A
 * pin of another item is re-pointed only with `replacePin`, as in mode pin; a new version of the same item moves it.
 */
function pinAfter(
  snapshot: LibrarySnapshotPin | null,
  current: DeskUnitPin | null | undefined,
  name: string,
  ctx: LibraryApplyContext,
): DeskUnitPin | null {
  if (!snapshot || keepsPin(snapshot, current)) return current ?? null;
  if (current && current.itemId !== snapshot.itemId && !ctx.input.replacePin)
    throw new LibraryError(
      'conflict',
      `${name} uses another library ${NOUN[current.kind]} (${current.name})`,
      [{ reason: 'pinned', itemId: current.itemId }],
    );
  return { ...snapshot, pinnedAt: ctx.now, pinnedBy: ctx.actor };
}

function resolveCharacter(
  ctx: LibraryApplyContext,
  payload: CharacterSnapshot,
  media: MediaResolver,
): Resolved {
  const targetId = targetOf(ctx, 'character');
  const base = targetId ? own(ctx.docs.characters, targetId) : undefined;
  if (targetId && !base) throw new LibraryError('not_found', `character ${targetId} not found`);
  const mode: LibraryApplyPlan['mode'] = !base
    ? 'create'
    : base.library?.itemId === ctx.item.id
      ? 'update'
      : 'link';
  refuseArchived(ctx, base?.library?.itemId === ctx.item.id);
  const warnings: string[] = [];
  const id = base?.id ?? ctx.item.entityId;
  if (!id) throw new LibraryError('validation_error', `${ctx.item.name} has no character id to use`);
  if (!base) {
    if (own(ctx.docs.characters, id))
      throw new LibraryError('conflict', `${own(ctx.docs.characters, id)!.name} is already in this project`, [
        { reason: 'exists', entityId: id },
      ]);
    const named = Object.values(ctx.docs.characters).find(
      (c) => c.name.trim().toLowerCase() === payload.name.trim().toLowerCase(),
    );
    if (named)
      throw new LibraryError('conflict', `a character named ${named.name} is already in this project`, [
        { reason: 'name', entityId: named.id },
      ]);
  }
  // outfits keep the target's ids where they are the same outfit (shots name outfits by id): the same id first, then
  // the same name among the target's outfits no id claimed; each is claimed once, so no two outfits share an id
  const outfitIds = new Map<string, string>();
  const claimed = new Set<string>();
  for (const w of payload.wardrobe)
    if (base?.wardrobe.some((x) => x.id === w.id)) {
      outfitIds.set(w.id, w.id);
      claimed.add(w.id);
    }
  const outfitName = (n: string) => n.trim().toLowerCase();
  for (const w of payload.wardrobe) {
    if (outfitIds.has(w.id)) continue;
    const same = base?.wardrobe.find((x) => !claimed.has(x.id) && outfitName(x.name) === outfitName(w.name));
    if (same) claimed.add(same.id);
    outfitIds.set(w.id, same?.id ?? w.id);
  }
  const versionRefs: CharacterReference[] = payload.references.map((r) => ({
    id: r.id,
    view: r.view,
    media: media(r.media),
    source: r.source,
    approved: true,
    ...(r.wardrobeId ? { wardrobeId: outfitIds.get(r.wardrobeId) ?? r.wardrobeId } : {}),
    createdAt: r.createdAt,
    ...(r.consent ? { consent: r.consent } : {}),
  }));
  const taken = new Set(versionRefs.map((r) => r.id));
  const draft: Character = {
    ...(base ?? {}),
    id,
    name: payload.name,
    role: payload.role,
    summary: payload.summary,
    identity: payload.identity,
    wardrobe: payload.wardrobe.map((w) => ({ ...w, id: outfitIds.get(w.id) ?? w.id })),
    // the target's own candidates stay candidates
    references: [...versionRefs, ...(base?.references ?? []).filter((r) => !r.approved && !taken.has(r.id))],
    seed: payload.seed,
    lock: { locked: false, version: 0 },
  };
  if (payload.personality !== undefined) draft.personality = payload.personality;
  else delete draft.personality;
  const refuse = (why: string) =>
    new LibraryError('character_locked', `${base?.name ?? payload.name} is locked: ${why}`);
  const { lock, from } = relock(
    base?.lock ?? null,
    payload.locked,
    ctx.identity.character(draft),
    recordedLock(ctx.docs, 'character', id),
    ctx,
    refuse,
  );
  // the voice: a version without one leaves the entity's as it is
  let voice: Voice | undefined = base?.voice;
  let voiceLock: LibraryApplyPlan['voiceLock'] = base?.voice
    ? {
        locked: base.voice.lock.locked,
        from: base.voice.lock.version,
        to: base.voice.lock.version,
      }
    : null;
  if (payload.voice) {
    const v = payload.voice;
    const draftVoice: Voice = {
      description: v.description,
      provider: v.provider,
      voiceId: v.voiceId,
      source: v.source,
      sample: v.sample ? media(v.sample) : null,
      candidates: [],
      ...(v.consent ? { consent: v.consent } : {}),
      lock: { locked: false, version: 0 },
    };
    const current = base?.voice ? voiceOf(base).lock : null;
    const out = relock(
      current,
      v.locked,
      ctx.identity.voice(draftVoice),
      recordedLock(ctx.docs, 'voice', id),
      ctx,
      (why) => new LibraryError('voice_locked', `${base?.name ?? payload.name}'s voice is locked: ${why}`),
    );
    voice = { ...draftVoice, lock: out.lock };
    voiceLock = { locked: out.lock.locked, from: out.from, to: out.lock.version };
  }
  const next: Character = {
    ...draft,
    ...(voice ? { voice } : {}),
    lock,
    library: origin(ctx, mode === 'create' ? 'used' : mode === 'update' ? 'updated' : 'linked'),
    deskUnit: pinAfter(payload.deskUnit, base?.deskUnit, base?.name ?? payload.name, ctx),
  };
  if (!voice) delete next.voice;
  const keys = [
    'name',
    'role',
    'summary',
    'identity',
    'wardrobe',
    'personality',
    'references',
    'voice',
    'seed',
  ];
  let changes = changed(
    base ? libraryDigestInput('character', characterSnapshot(base).payload) : null,
    libraryDigestInput('character', characterSnapshot(next).payload),
    keys,
  );
  if (!base) changes = changes.filter((k) => k !== 'personality' || payload.personality !== undefined);
  if (
    (base?.deskUnit?.itemId ?? null) !== (next.deskUnit?.itemId ?? null) ||
    (base?.deskUnit?.version ?? null) !== (next.deskUnit?.version ?? null)
  )
    changes.push('deskUnit');
  const unchanged =
    !!base &&
    changes.length === 0 &&
    lock === base.lock &&
    base.library?.itemId === ctx.item.id &&
    base.library.version === ctx.version.version;
  const localChanges = localEdits(ctx, 'character', base, mode, payload);
  // a create counts too: takes that recorded this id before (the character removed and used again, or an episode
  // copied from another) go stale once it is back
  const stale = staleness(ctx.docs, {
    characters: { ...ctx.docs.characters, [id]: next },
    elements: ctx.docs.elements,
  });
  return {
    plan: {
      mode,
      item: itemOf(ctx),
      entity: { kind: 'character', id, name: next.name, exists: !!base },
      keepsLibraryId: !base,
      changes,
      lock: { locked: lock.locked, from, to: lock.version },
      voiceLock,
      ...stale,
      localChanges,
      realPerson: ctx.version.realPerson,
      files: filesOf(ctx, true),
      warnings,
      needs: stale.approvedClips.length ? 'project.approve' : 'project.edit',
    },
    write: unchanged ? null : { path: `characters/${id}.json`, doc: next },
    message: applyMessage(mode, next.name, base?.library?.version, ctx.version.version),
  };
}

function resolveElement(ctx: LibraryApplyContext, payload: ElementSnapshot, media: MediaResolver): Resolved {
  const targetId = targetOf(ctx, 'element');
  const base = targetId ? own(ctx.docs.elements, targetId) : undefined;
  if (targetId && !base) throw new LibraryError('not_found', `element ${targetId} not found`);
  if (base && base.kind !== payload.kind)
    throw new LibraryError(
      'validation_error',
      `a library ${payload.kind} cannot update ${base.name}, which is a ${base.kind}`,
    );
  const mode: LibraryApplyPlan['mode'] = !base
    ? 'create'
    : base.library?.itemId === ctx.item.id
      ? 'update'
      : 'link';
  refuseArchived(ctx, base?.library?.itemId === ctx.item.id);
  const id = base?.id ?? ctx.item.entityId;
  if (!id) throw new LibraryError('validation_error', `${ctx.item.name} has no element id to use`);
  const warnings: string[] = [];
  if (!base) {
    if (own(ctx.docs.elements, id))
      throw new LibraryError('conflict', `${own(ctx.docs.elements, id)!.name} is already in this project`, [
        { reason: 'exists', entityId: id },
      ]);
    const key = (n: string) => n.trim().toLowerCase();
    const named = Object.values(ctx.docs.elements).find(
      (e) => e.kind === payload.kind && key(e.name) === key(payload.name),
    );
    if (named)
      throw new LibraryError('conflict', `a ${payload.kind} named ${named.name} is already in this project`, [
        { reason: 'name', entityId: named.id },
      ]);
    // a name or alias another element of the kind answers to too (as its name or an alias) resolves to none
    // (elementIndex): said, not refused
    for (const alias of [payload.name, ...payload.aliases]) {
      const other = Object.values(ctx.docs.elements).find(
        (e) =>
          e.kind === payload.kind &&
          (key(e.name) === key(alias) || e.aliases.some((a) => key(a) === key(alias))),
      );
      if (other)
        warnings.push(
          `“${alias}” is also ${key(other.name) === key(alias) ? 'the name' : 'a name'} of ${other.name}: neither answers to it in the screenplay`,
        );
    }
  }
  const versionRefs: ElementReference[] = payload.references.map((r) => ({
    id: r.id,
    view: r.view,
    media: media(r.media),
    source: r.source,
    approved: true,
    createdAt: r.createdAt,
  }));
  const taken = new Set(versionRefs.map((r) => r.id));
  const draft: Element = {
    ...(base ?? {}),
    id,
    kind: payload.kind,
    name: payload.name,
    description: payload.description,
    aliases: payload.aliases,
    references: [...versionRefs, ...(base?.references ?? []).filter((r) => !r.approved && !taken.has(r.id))],
    seed: payload.seed,
    lock: { locked: false, version: 0 },
  };
  const { lock, from } = relock(
    base?.lock ?? null,
    payload.locked,
    ctx.identity.element(draft),
    recordedLock(ctx.docs, 'element', id),
    ctx,
    (why) => new LibraryError('element_locked', `${base?.name ?? payload.name} is locked: ${why}`),
  );
  const next: Element = {
    ...draft,
    lock,
    library: origin(ctx, mode === 'create' ? 'used' : mode === 'update' ? 'updated' : 'linked'),
    deskUnit: pinAfter(payload.deskUnit, base?.deskUnit, base?.name ?? payload.name, ctx),
  };
  const changes = changed(
    base ? libraryDigestInput('element', elementSnapshot(base).payload) : null,
    libraryDigestInput('element', elementSnapshot(next).payload),
    ['name', 'description', 'aliases', 'references', 'seed'],
  );
  if (
    (base?.deskUnit?.itemId ?? null) !== (next.deskUnit?.itemId ?? null) ||
    (base?.deskUnit?.version ?? null) !== (next.deskUnit?.version ?? null)
  )
    changes.push('deskUnit');
  const unchanged =
    !!base &&
    changes.length === 0 &&
    lock === base.lock &&
    base.library?.itemId === ctx.item.id &&
    base.library.version === ctx.version.version;
  const stale = staleness(ctx.docs, {
    characters: ctx.docs.characters,
    elements: { ...ctx.docs.elements, [id]: next },
  });
  return {
    plan: {
      mode,
      item: itemOf(ctx),
      entity: { kind: 'element', id, name: next.name, exists: !!base },
      keepsLibraryId: !base,
      changes,
      lock: { locked: lock.locked, from, to: lock.version },
      voiceLock: null,
      ...stale,
      localChanges: localEdits(ctx, 'element', base, mode, payload),
      realPerson: ctx.version.realPerson,
      files: filesOf(ctx, true),
      warnings,
      needs: stale.approvedClips.length ? 'project.approve' : 'project.edit',
    },
    write: unchanged ? null : { path: `elements/${id}.json`, doc: next },
    message: applyMessage(mode, next.name, base?.library?.version, ctx.version.version),
  };
}

/**
 * The entity was edited here since its version (update), or differs from the version it gets linked to (link), in what
 * the apply replaces: its snapshot digest is not that version's, counted with or without what the apply keeps (the pin
 * when the version carries none or the very same one, the voice when the version has none).
 */
function localEdits(
  ctx: LibraryApplyContext,
  kind: 'character' | 'element',
  base: Character | Element | undefined,
  mode: LibraryApplyPlan['mode'],
  version: CharacterSnapshot | ElementSnapshot,
): boolean {
  if (!base) return false;
  const reference = mode === 'update' ? base.library?.digest : ctx.version.digest;
  if (!reference) return false;
  let candidates = [entitySnapshot(kind, base).payload as CharacterSnapshot | ElementSnapshot];
  if (base.deskUnit && keepsPin(version.deskUnit, base.deskUnit))
    candidates = [...candidates, ...candidates.map((c) => ({ ...c, deskUnit: null }))];
  if (kind === 'character' && (base as Character).voice && !(version as CharacterSnapshot).voice)
    candidates = [...candidates, ...candidates.map((c) => ({ ...(c as CharacterSnapshot), voice: null }))];
  return candidates.every((c) => libraryDigest(kind, c, ctx.sha256) !== reference);
}

function applyMessage(
  mode: LibraryApplyPlan['mode'],
  name: string,
  from: number | undefined,
  to: number,
): string {
  if (mode === 'create') return `Use ${name} from the library (v${to})`;
  if (mode === 'update' && from !== undefined && from !== to)
    return `Update ${name} from the library (v${from} → v${to})`;
  if (mode === 'update') return `Update ${name} from the library (v${to})`;
  return `Link ${name} to the library (v${to})`;
}

// ---------------------------------------------------------------- where it is used

/**
 * The library uses of a project's documents, as its digest keeps them (docs/design/library.md#where-it-is-used): a
 * `library` row per linked character, element and resource, a `deskUnit` row per pin, a `deskState` row per version
 * the clips' stored desk states use (`deskStateUses`); at most 1000, in a stable order.
 */
export function libraryUses(
  docs: Pick<ProjectDocs, 'characters' | 'elements' | 'resources'> & Partial<Pick<ProjectDocs, 'clips'>>,
): DigestLibraryUse[] {
  const rows: DigestLibraryUse[] = [];
  const entity = (kind: LibraryEntityKind, e: { id: string; name: string }) => ({
    kind,
    id: e.id,
    name: e.name.slice(0, 200),
  });
  for (const c of Object.values(docs.characters)) {
    if (c.library)
      rows.push({
        itemId: c.library.itemId,
        version: c.library.version,
        via: 'library',
        entity: entity('character', c),
      });
    if (c.deskUnit)
      rows.push({
        itemId: c.deskUnit.itemId,
        version: c.deskUnit.version,
        via: 'deskUnit',
        entity: entity('character', c),
      });
  }
  for (const e of Object.values(docs.elements)) {
    if (e.library)
      rows.push({
        itemId: e.library.itemId,
        version: e.library.version,
        via: 'library',
        entity: entity('element', e),
      });
    if (e.deskUnit)
      rows.push({
        itemId: e.deskUnit.itemId,
        version: e.deskUnit.version,
        via: 'deskUnit',
        entity: entity('element', e),
      });
  }
  for (const r of Object.values(docs.resources))
    if (r.library)
      rows.push({
        itemId: r.library.itemId,
        version: r.library.version,
        via: 'library',
        entity: entity('resource', r),
      });
  rows.push(...deskStateUses(docs.clips ?? {}));
  const key = (u: DigestLibraryUse) =>
    `${u.itemId}\u0000${u.via}\u0000${u.entity?.kind ?? ''}\u0000${u.entity?.id ?? ''}\u0000${String(u.version).padStart(4, '0')}`;
  return rows
    .sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0))
    .slice(0, LIBRARY_LIMITS.usesRows);
}
