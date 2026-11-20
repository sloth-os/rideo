import { createWriteStream } from 'node:fs';
import { readFile, rm, stat, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { pipeline } from 'node:stream/promises';
import {
  type Actor,
  applyVersion,
  authorOf,
  type Character,
  CharacterSnapshotSchema,
  type Clip,
  consentSubjects,
  DESK_UNIT_FILE_KIND,
  DESK_UNIT_FORMAT,
  type DeskUnitSnapshot,
  type DigestLibraryUse,
  type Element,
  ElementSnapshotSchema,
  entitySnapshot,
  isDeskUnitKind,
  isRealPersonSnapshot,
  kindFromMime,
  LIBRARY_LIMITS,
  type LibraryAction,
  type LibraryApplyDocs,
  LibraryApplyInputSchema,
  type LibraryApplyResult,
  LibraryDetachInputSchema,
  type LibraryDetachResult,
  type LibraryEntity,
  LibraryError,
  type LibraryFileRef,
  type LibraryItem,
  type LibraryItemPatch,
  type LibraryKind,
  type LibraryLinkStatus,
  LibraryListInputSchema,
  type LibraryListResult,
  type LibraryMedia,
  type LibraryPayload,
  type LibraryProjectStatus,
  LibrarySaveInputSchema,
  type LibrarySaveResult,
  type LibraryUploadMeta,
  type LibraryUploadResult,
  type LibraryUses,
  type LibraryVersion,
  type Localization,
  libraryAllows,
  libraryDigest,
  libraryEtag,
  librarySummary,
  libraryUses,
  type MediaRef,
  newId,
  type ProjectDocs,
  parseCube,
  planApply,
  projectMediaOf,
  type Resource,
  type ResourceSnapshot,
  ResourceSnapshotSchema,
  slugify,
  thumbnailSource,
  versionFiles,
} from '@rideo/shared';
import type { z } from 'zod';
import { currentPrincipal, type Principal } from '../auth/context';
import { AppError, invalid, notFound, toAppError, tooLarge } from '../errors';
import { extFor, type MediaKind } from '../media/store';
import { workspaceContext } from '../storage/workspaces';
import { sha256, sha256File } from '../util/crypto';
import { eachLimit } from '../util/limit';
import type { Tx } from '../vcs/repo';
import { Service } from './base';
import type { Deps } from './deps';
import { elementIdentityHash } from './elements';
import { pngSize, readDeskUnitHeader } from './library-files';
import { LibraryStore } from './library-store';
import { identityHash } from './story';
import { voiceIdentityHash } from './voices';

/** Projects whose uses are read at once (docs/design/library.md#where-it-is-used). */
const DIGESTS_AT_ONCE = 8;

const IDENTITY = { character: identityHash, element: elementIdentityHash, voice: voiceIdentityHash };

/** An upload as the REST route received it: `meta`, then the `payload` file, then an optional `thumbnail`. */
export interface LibraryUploadFiles {
  meta: LibraryUploadMeta;
  payload: { path: string; size: number; filename: string; mime: string };
  thumbnail: { path: string; size: number; mime: string } | null;
}

/** A version about to be published. */
interface Draft {
  kind: LibraryKind;
  payload: LibraryPayload;
  thumbnail: LibraryMedia | null;
  digest: string;
  realPerson: boolean;
  bytes: number;
  note: string;
  /** The precondition: the version it was made from (412 unless it is the item's latest). */
  basedOn: number | null;
  source: LibraryVersion['source'];
}

/** A rule of the library (shared) refused: its code as an AppError. */
function rule<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof LibraryError) throw new AppError(err.code, err.message, err.errors);
    throw err;
  }
}

function headThumbnail(v: LibraryVersion): LibraryItem['thumbnail'] {
  if (!v.thumbnail) return null;
  return {
    version: v.version,
    hash: v.thumbnail.hash,
    mime: 'image/png',
    ...(v.thumbnail.width ? { width: v.thumbnail.width } : {}),
    ...(v.thumbnail.height ? { height: v.thumbnail.height } : {}),
  };
}

/** A 3D unit version as pickers show it. */
function unitInfo(v: LibraryVersion): LibraryItem['unit'] {
  if (!isDeskUnitKind(v.kind)) return null;
  const p = v.payload as DeskUnitSnapshot;
  return {
    sha256: p.payload.hash,
    bytes: p.payload.size,
    format: p.format,
    formatVersion: p.formatVersion,
    actorKind: p.meta.actor?.kind ?? null,
    heightM: p.meta.actor?.heightM ?? null,
    dimensionsM: p.meta.dimensionsM,
  };
}

function historyEntry(v: LibraryVersion): LibraryItem['history'][number] {
  return {
    version: v.version,
    digest: v.digest,
    basedOn: v.basedOn,
    note: v.note,
    realPerson: v.realPerson,
    bytes: v.bytes,
    createdBy: v.createdBy,
    createdAt: v.createdAt,
  };
}

/** The media fields of a probe (width, height, duration, audio, frame rate, codecs). */
function probeFields(p: Partial<MediaRef>): Partial<LibraryMedia> {
  const out: Partial<LibraryMedia> = {};
  for (const k of ['width', 'height', 'durationSec', 'hasAudio', 'fps', 'videoCodec', 'audioCodec'] as const)
    if (p[k] !== undefined) (out as Record<string, unknown>)[k] = p[k];
  return out;
}

/** The files a project's characters, elements and resources hold, by sha256: an apply copies only the others. */
function projectMedia(
  docs: Pick<ProjectDocs, 'characters' | 'elements' | 'resources'>,
): Map<string, MediaRef> {
  const out = new Map<string, MediaRef>();
  for (const c of Object.values(docs.characters)) {
    for (const r of c.references) out.set(r.media.hash, r.media);
    if (c.voice?.sample) out.set(c.voice.sample.hash, c.voice.sample);
  }
  for (const e of Object.values(docs.elements)) for (const r of e.references) out.set(r.media.hash, r.media);
  for (const r of Object.values(docs.resources)) out.set(r.media.hash, r.media);
  return out;
}

/** The documents an apply reads, at the transaction's tip. */
function txDocs(tx: Tx): LibraryApplyDocs {
  const byId = <T extends { id: string }>(xs: T[]) => Object.fromEntries(xs.map((x) => [x.id, x]));
  return {
    characters: byId(tx.list<Character>('characters/')),
    elements: byId(tx.list<Element>('elements/')),
    resources: byId(tx.list<Resource>('resources/')),
    clips: byId(tx.list<Clip>('clips/')),
    localizations: byId(tx.list<Localization>('localizations/')),
  };
}

const ENTITY_PATH = {
  character: (id: string) => `characters/${id}.json`,
  element: (id: string) => `elements/${id}.json`,
  resource: (id: string) => `resources/${id}.json`,
};

const DESK_NOUN = { 'desk-set': 'set', 'desk-prop': 'prop', 'desk-figure': 'figure' } as const;

const RESOURCE_BYTES = {
  image: LIBRARY_LIMITS.imageBytes,
  lut: LIBRARY_LIMITS.lutBytes,
  video: LIBRARY_LIMITS.mediaBytes,
  audio: LIBRARY_LIMITS.mediaBytes,
} as const;

/** The largest `payload` an upload's meta allows. */
export function uploadPayloadLimit(meta: LibraryUploadMeta): number {
  if (meta.kind !== 'resource') return LIBRARY_LIMITS.deskUnitBytes;
  return RESOURCE_BYTES[meta.resource?.kind ?? 'video'];
}

/**
 * The studio library (docs/design/library.md): items in versions on the storage backend, published by uploads (3D
 * units, resources) and by Save to library, applied to projects by copy (characters, elements, resources) or by pin
 * (3D units). One service behind REST and MCP.
 */
export class LibraryService extends Service {
  readonly store: LibraryStore;
  private gaugeSet = false;

  constructor(deps: Deps) {
    super(deps);
    this.store = new LibraryStore({
      storage: deps.storage,
      layout: deps.layout,
      log: deps.log,
      tmp: (ext) => deps.media.tmp(ext),
    });
  }

  // ------------------------------------------------------------ permissions, refusals, metrics

  private principal(): Principal {
    return currentPrincipal() ?? this.deps.accounts.studioPrincipal();
  }

  /** `libraryAllows`, else `forbidden` (403) recorded as `auth.denied`. */
  private async allow(action: LibraryAction, ownerId?: string, detail: Record<string, unknown> = {}) {
    const p = this.principal();
    if (libraryAllows(this.deps.accounts.subject(p), action, ownerId)) return;
    this.deps.metrics.auth.inc({ event: 'denied', outcome: 'denied' });
    await this.deps.accounts.record(p, 'auth.denied', {
      outcome: 'denied',
      detail: { library: action, ...detail },
    });
    throw new AppError(
      'forbidden',
      action === 'publish'
        ? 'This caller may not publish to the studio library: a token limited to some projects, or below editor, only reads it'
        : "Only the item's owner or an admin changes it",
    );
  }

  /** Counts and logs a refused upload; returns the error to throw. */
  refused(kind: string, reason: string, err: AppError): AppError {
    this.deps.metrics.library.inc({ event: 'refused', kind });
    this.deps.log.info({ kind, reason, error: err.message }, 'library upload refused');
    return err;
  }

  private async countItems(): Promise<void> {
    const counts = new Map<string, number>();
    for (const i of await this.store.items()) counts.set(i.kind, (counts.get(i.kind) ?? 0) + 1);
    for (const kind of ['character', 'element', 'resource', 'desk-set', 'desk-prop', 'desk-figure'])
      this.deps.metrics.libraryItems.set({ kind }, counts.get(kind) ?? 0);
    this.gaugeSet = true;
  }

  private async loaded(): Promise<void> {
    await this.store.load();
    if (!this.gaugeSet) await this.countItems();
  }

  /** `If-Match` (an ETag `"r<rev>"`, `*`, or MCP's `expectedRev`) against the head; `412 library_conflict` when stale. */
  private precondition(item: LibraryItem, ifMatch: string | number | undefined): void {
    if (ifMatch === undefined || ifMatch === '') return;
    const ok =
      typeof ifMatch === 'number'
        ? ifMatch === item.rev
        : ifMatch
            .split(',')
            .map((t) => t.trim())
            .some(
              (t) => t === '*' || (!t.startsWith('W/') && t.replace(/^"(.*)"$/, '$1') === `r${item.rev}`),
            );
    if (ok) return;
    this.deps.metrics.library.inc({ event: 'conflict', kind: item.kind });
    this.deps.log.info({ itemId: item.id, kind: item.kind, ifMatch, rev: item.rev }, 'library conflict');
    throw new LibraryConflictError(item, `${item.name} changed meanwhile: its revision is ${item.rev}`, [
      { rev: item.rev, latest: item.latest },
    ]);
  }

  // ------------------------------------------------------------ reading

  async list(raw: z.input<typeof LibraryListInputSchema>): Promise<LibraryListResult> {
    const input = LibraryListInputSchema.parse(raw);
    await this.loaded();
    const kinds = new Set<string>([...(input.kinds ?? []), ...(input.kind ? [input.kind] : [])]);
    const words = (input.q ?? '').toLowerCase().split(/\s+/).filter(Boolean);
    const items = (await this.store.items())
      .filter((i) => input.archived || !i.archived)
      .filter((i) => !kinds.size || kinds.has(i.kind))
      .filter((i) => !input.tag || i.tags.includes(input.tag))
      .filter((i) => {
        if (!words.length) return true;
        const text = `${i.name} ${i.description} ${i.tags.join(' ')}`.toLowerCase();
        return words.every((w) => text.includes(w));
      })
      .sort((a, b) =>
        input.sort === 'name'
          ? a.name.localeCompare(b.name) || a.id.localeCompare(b.id)
          : b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id),
      );
    const start = input.cursor ? Number(input.cursor) : 0;
    const end = start + input.limit;
    return {
      items: items.slice(start, end).map(librarySummary),
      next: end < items.length ? String(end) : null,
    };
  }

  async get(itemId: string): Promise<LibraryItem> {
    await this.loaded();
    const item = await this.store.item(itemId);
    if (!item) throw notFound(`library item ${itemId}`);
    return item;
  }

  /** A version's manifest: one the head names (a manifest a crash left behind is none). */
  async version(itemId: string, n: number): Promise<LibraryVersion> {
    const item = await this.get(itemId);
    if (!item.history.some((h) => h.version === n)) throw notFound(`version ${n} of ${item.name}`);
    const v = await this.store.version(itemId, n);
    if (!v)
      throw new AppError('storage_error', `version ${n} of ${item.name} is missing from storage`, [], true);
    return v;
  }

  /** A file the version names (`404` for any other). */
  async fileInfo(itemId: string, n: number, sha: string): Promise<LibraryFileRef> {
    const v = await this.version(itemId, n);
    const file = versionFiles(v).find((f) => f.hash === sha);
    if (!file) throw notFound(`file ${sha} of version ${n}`);
    return file;
  }

  async file(itemId: string, n: number, sha: string, range?: { start: number; end?: number }) {
    const info = await this.fileInfo(itemId, n, sha);
    const res = await this.store.readFile(sha, range);
    if (!res) throw new AppError('storage_error', `the library file ${sha} cannot be read`, [], true);
    return { ...res, mime: info.mime };
  }

  // ------------------------------------------------------------ publishing

  /** A new item from an upload (3D units, resources). */
  async create(actor: Actor, upload: LibraryUploadFiles): Promise<LibraryUploadResult> {
    await this.allow('publish');
    const { meta } = upload;
    if (!meta.name) throw this.refused(meta.kind, 'meta', invalid('name the new item (meta.name)'));
    const draft = await this.uploadDraft(meta, upload, meta.name);
    return this.publishItem(
      actor,
      { kind: meta.kind, name: meta.name, description: meta.description ?? '', tags: meta.tags ?? [] },
      draft,
    );
  }

  /** A new version of an item from an upload; `unchanged` when its file is the current version's. */
  async addVersion(
    actor: Actor,
    itemId: string,
    upload: LibraryUploadFiles,
    ifMatch?: string,
  ): Promise<LibraryUploadResult> {
    await this.allow('publish', undefined, { itemId });
    const item = await this.get(itemId);
    if (upload.meta.kind !== item.kind)
      throw this.refused(
        upload.meta.kind,
        'kind',
        invalid(`${item.name} is a ${item.kind} item, not a ${upload.meta.kind}`, [{ reason: 'kind' }]),
      );
    const draft = await this.uploadDraft(upload.meta, upload, item.name);
    return this.publishVersion(actor, item.id, draft, ifMatch);
  }

  private async uploadThumbnail(
    kind: string,
    f: NonNullable<LibraryUploadFiles['thumbnail']>,
  ): Promise<LibraryMedia> {
    if (f.size > LIBRARY_LIMITS.thumbnailBytes)
      throw this.refused(kind, 'thumbnail', tooLarge('a thumbnail is at most 64 KiB'));
    const buf = await readFile(f.path);
    const size = pngSize(buf);
    if (!size)
      throw this.refused(kind, 'thumbnail', invalid('a thumbnail is a PNG', [{ reason: 'thumbnail' }]));
    if (size.width > LIBRARY_LIMITS.thumbnailSide || size.height > LIBRARY_LIMITS.thumbnailSide)
      throw this.refused(
        kind,
        'thumbnail',
        invalid(`a thumbnail is at most 256 × 256 px, not ${size.width} × ${size.height}`, [
          { reason: 'thumbnail' },
        ]),
      );
    const hash = sha256(buf);
    if (await this.store.putFile(f.path, hash, buf.length, 'image/png'))
      this.deps.metrics.libraryBytes.inc({ op: 'upload' }, buf.length);
    return {
      hash,
      mime: 'image/png',
      size: buf.length,
      width: size.width,
      height: size.height,
      name: 'thumbnail',
    };
  }

  private async uploadDraft(
    meta: LibraryUploadMeta,
    files: LibraryUploadFiles,
    name: string,
  ): Promise<Draft> {
    const file = files.payload;
    if (meta.kind !== 'resource') {
      const unit = meta.unit!;
      const fileKind = DESK_UNIT_FILE_KIND[meta.kind];
      if (file.size > LIBRARY_LIMITS.deskUnitBytes)
        throw this.refused(meta.kind, 'size', tooLarge('a 3D unit file is at most 32 MiB'));
      let header: Awaited<ReturnType<typeof readDeskUnitHeader>>;
      try {
        header = await readDeskUnitHeader(file.path, file.size);
      } catch (err) {
        throw this.refused(meta.kind, 'unit', toAppError(err));
      }
      if (header.format !== DESK_UNIT_FORMAT)
        throw this.refused(
          meta.kind,
          'unit',
          invalid(`a 3D unit file of format ${DESK_UNIT_FORMAT}, not ${header.format}`, [{ reason: 'unit' }]),
        );
      if (header.version < 1 || header.version > 1000 || header.version !== unit.formatVersion)
        throw this.refused(
          meta.kind,
          'unit',
          invalid(`the file is format version ${header.version}, the meta says ${unit.formatVersion}`, [
            { reason: 'unit' },
          ]),
        );
      if (header.kind !== fileKind)
        throw this.refused(
          meta.kind,
          'kind',
          invalid(`the file is a 3D ${header.kind}, not a 3D ${fileKind}`, [{ reason: 'kind' }]),
        );
      const hash = await sha256File(file.path);
      const thumbnail = files.thumbnail ? await this.uploadThumbnail(meta.kind, files.thumbnail) : null;
      if (await this.store.putFile(file.path, hash, file.size, 'application/octet-stream'))
        this.deps.metrics.libraryBytes.inc({ op: 'upload' }, file.size);
      const payload: DeskUnitSnapshot = {
        format: DESK_UNIT_FORMAT,
        formatVersion: header.version,
        payload: { hash, mime: 'application/octet-stream', size: file.size, name: slugify(name, 60) },
        meta: unit.meta,
      };
      return {
        kind: meta.kind,
        payload,
        thumbnail,
        digest: hash,
        realPerson: false,
        bytes: file.size + (thumbnail?.size ?? 0),
        note: meta.note ?? '',
        basedOn: meta.basedOn ?? null,
        source: null,
      };
    }
    const r = meta.resource!;
    const limit = RESOURCE_BYTES[r.kind];
    if (file.size > limit)
      throw this.refused('resource', 'size', tooLarge(`a ${r.kind} resource is at most ${limit} bytes`));
    let mime = file.mime || 'application/octet-stream';
    if (r.kind === 'lut') {
      try {
        parseCube(await readFile(file.path, 'utf8'));
      } catch (err) {
        throw this.refused('resource', 'payload', invalid(`not a 3D LUT: ${(err as Error).message}`));
      }
      mime = 'application/x-cube';
    } else if (kindFromMime(mime) !== r.kind)
      throw this.refused(
        'resource',
        'payload',
        invalid(`a ${r.kind} resource needs a ${r.kind} file, not ${mime}`),
      );
    const hash = await sha256File(file.path);
    const probe = r.kind === 'lut' ? {} : await this.deps.media.probeRef(file.path, mime);
    if (await this.store.putFile(file.path, hash, file.size, mime))
      this.deps.metrics.libraryBytes.inc({ op: 'upload' }, file.size);
    const payload: ResourceSnapshot = {
      kind: r.kind,
      role: r.role,
      name: r.name,
      ...(r.notes ? { notes: r.notes } : {}),
      media: {
        hash,
        mime,
        size: file.size,
        ...probeFields(probe),
        name: slugify(r.name.replace(/\.[^.]+$/, ''), 60),
      },
    };
    const thumbnail = files.thumbnail
      ? await this.uploadThumbnail('resource', files.thumbnail)
      : await this.makeThumbnail({ kind: 'resource', payload }, new Map([[hash, file.path]]));
    return {
      kind: 'resource',
      payload,
      thumbnail,
      digest: libraryDigest('resource', payload, sha256),
      realPerson: false,
      bytes: file.size + (thumbnail?.size ?? 0),
      note: meta.note ?? '',
      basedOn: meta.basedOn ?? null,
      source: null,
    };
  }

  /** The server's thumbnail of a version (best effort: none when the picture cannot be made). */
  private async makeThumbnail(
    v: { kind: LibraryKind; payload: LibraryPayload },
    locals: Map<string, string>,
  ): Promise<LibraryMedia | null> {
    const source = thumbnailSource(v as LibraryVersion);
    if (!source) return null;
    let tmp: string | null = null;
    try {
      let local = locals.get(source.hash);
      if (!local) {
        tmp = await this.store.fileToTmp(source.hash, extFor(source.mime));
        local = tmp;
      }
      const png = await this.deps.media.filePng(local, LIBRARY_LIMITS.thumbnailSide);
      const size = pngSize(png);
      const hash = sha256(png);
      const file = this.deps.media.tmp('png');
      try {
        await writeFile(file, png);
        await this.store.putFile(file, hash, png.length, 'image/png');
      } finally {
        await rm(file, { force: true });
      }
      return { hash, mime: 'image/png', size: png.length, ...(size ?? {}), name: 'thumbnail' };
    } catch (err) {
      this.deps.log.warn({ kind: v.kind, err: (err as Error).message }, 'library thumbnail not made');
      return null;
    } finally {
      if (tmp) await rm(tmp, { force: true });
    }
  }

  private async publishItem(
    actor: Actor,
    head: { kind: LibraryKind; name: string; description: string; tags: string[]; entityId?: string | null },
    draft: Draft,
  ): Promise<LibraryUploadResult> {
    const id = newId('libraryItem');
    const p = this.principal();
    return this.store.lock(id, async () => {
      const now = new Date().toISOString();
      const version = await this.store.writeVersion(id, 1, (n) => this.versionOf(actor, id, n, draft, now));
      const item = await this.store.saveHead({
        id,
        kind: head.kind,
        name: head.name,
        description: head.description,
        tags: head.tags,
        entityId: head.entityId ?? null,
        current: version.version,
        latest: version.version,
        history: [historyEntry(version)],
        thumbnail: headThumbnail(version),
        unit: unitInfo(version),
        realPerson: version.realPerson,
        archived: false,
        ownerId: p.user.id,
        createdBy: authorOf(actor),
        createdAt: now,
        updatedBy: authorOf(actor),
        updatedAt: now,
        rev: 1,
      });
      this.deps.metrics.library.inc({ event: 'created', kind: item.kind });
      await this.countItems();
      this.deps.log.info(
        { itemId: item.id, kind: item.kind, version: version.version, projectId: draft.source?.projectId },
        'library item created',
      );
      await this.audit(p, 'library.publish', draft.source?.projectId ?? null, {
        itemId: item.id,
        kind: item.kind,
        version: version.version,
        realPerson: version.realPerson,
      });
      return { item, version, unchanged: false };
    });
  }

  private versionOf(actor: Actor, itemId: string, n: number, draft: Draft, now: string): LibraryVersion {
    return {
      itemId,
      version: n,
      kind: draft.kind,
      digest: draft.digest,
      payload: draft.payload,
      thumbnail: draft.thumbnail,
      basedOn: draft.basedOn,
      note: draft.note,
      source: draft.source,
      realPerson: draft.realPerson,
      bytes: draft.bytes,
      createdBy: authorOf(actor),
      createdAt: now,
    } as LibraryVersion;
  }

  /**
   * A new version under the item's lock: a stale `If-Match` is `412`; content equal to the current version's is
   * `unchanged` (no version); a `basedOn` that is not the latest is `412` with `errors: [{latest}]`. It becomes current.
   */
  private async publishVersion(
    actor: Actor,
    itemId: string,
    draft: Draft,
    ifMatch?: string | number,
  ): Promise<LibraryUploadResult> {
    const p = this.principal();
    return this.store.lock(itemId, async () => {
      const item = await this.get(itemId);
      this.precondition(item, ifMatch);
      if (item.kind !== draft.kind)
        throw invalid(`${item.name} is a ${item.kind} item, not a ${draft.kind}`, [{ reason: 'kind' }]);
      const current = item.history.find((h) => h.version === item.current);
      if (current?.digest === draft.digest) {
        this.deps.metrics.library.inc({ event: 'unchanged', kind: item.kind });
        this.deps.log.info({ itemId, kind: item.kind, version: item.current }, 'library version unchanged');
        return { item, version: await this.version(itemId, item.current), unchanged: true };
      }
      if (draft.basedOn !== null && draft.basedOn !== item.latest) {
        this.deps.metrics.library.inc({ event: 'conflict', kind: item.kind });
        this.deps.log.info(
          { itemId, kind: item.kind, basedOn: draft.basedOn, latest: item.latest },
          'library conflict',
        );
        throw new LibraryConflictError(
          item,
          `${item.name} has a later version (v${item.latest}) than the one this was made from (v${draft.basedOn})`,
          [{ latest: item.latest }],
        );
      }
      const now = new Date().toISOString();
      const version = await this.store.writeVersion(itemId, item.latest + 1, (n) =>
        this.versionOf(actor, itemId, n, draft, now),
      );
      const next = await this.store.saveHead({
        ...item,
        current: version.version,
        latest: version.version,
        history: [...item.history, historyEntry(version)],
        thumbnail: headThumbnail(version),
        unit: unitInfo(version),
        realPerson: version.realPerson,
        updatedBy: authorOf(actor),
        updatedAt: now,
        rev: item.rev + 1,
      });
      this.deps.metrics.library.inc({ event: 'version', kind: item.kind });
      this.deps.log.info(
        { itemId, kind: item.kind, version: version.version, projectId: draft.source?.projectId },
        'library version added',
      );
      await this.audit(p, 'library.publish', draft.source?.projectId ?? null, {
        itemId,
        kind: item.kind,
        version: version.version,
        realPerson: version.realPerson,
      });
      return { item: next, version, unchanged: false };
    });
  }

  private audit(
    p: Principal,
    type: 'library.publish' | 'library.apply' | 'library.change',
    projectId: string | null,
    detail: Record<string, unknown>,
  ): Promise<void> {
    return this.deps.accounts.record(p, type, { projectId, detail });
  }

  // ------------------------------------------------------------ managing

  /** Rename, describe, tag, make a version current, archive or unarchive (its owner or an admin). */
  async update(
    actor: Actor,
    itemId: string,
    patch: LibraryItemPatch,
    ifMatch?: string | number,
  ): Promise<LibraryItem> {
    const p = this.principal();
    return this.store.lock(itemId, async () => {
      const item = await this.get(itemId);
      await this.allow('manage', item.ownerId, { itemId });
      this.precondition(item, ifMatch);
      let next: LibraryItem = { ...item };
      const changes: { what: string; from: unknown; to: unknown }[] = [];
      if (patch.name !== undefined && patch.name !== item.name) next.name = patch.name;
      if (patch.description !== undefined && patch.description !== item.description)
        next.description = patch.description;
      if (patch.tags !== undefined) next.tags = [...new Set(patch.tags)];
      if (patch.current !== undefined && patch.current !== item.current) {
        const v = await this.version(itemId, patch.current);
        next = {
          ...next,
          current: v.version,
          thumbnail: headThumbnail(v),
          unit: unitInfo(v),
          realPerson: v.realPerson,
        };
        changes.push({ what: 'current', from: item.current, to: v.version });
      }
      if (patch.archived !== undefined && patch.archived !== item.archived) {
        next.archived = patch.archived;
        changes.push({
          what: patch.archived ? 'archived' : 'unarchived',
          from: item.archived,
          to: patch.archived,
        });
      }
      const same =
        next.name === item.name &&
        next.description === item.description &&
        JSON.stringify(next.tags) === JSON.stringify(item.tags) &&
        !changes.length;
      if (same) return item;
      const saved = await this.store.saveHead({
        ...next,
        updatedBy: authorOf(actor),
        updatedAt: new Date().toISOString(),
        rev: item.rev + 1,
      });
      for (const c of changes) {
        this.deps.metrics.library.inc({ event: c.what, kind: item.kind });
        await this.audit(p, 'library.change', null, { itemId, kind: item.kind, ...c });
      }
      this.deps.log.info(
        { itemId, kind: item.kind, changes: changes.map((c) => c.what), rev: saved.rev },
        'library item changed',
      );
      return saved;
    });
  }

  // ------------------------------------------------------------ projects

  /** Save to library (docs/design/library.md#save-to-library): a new item, or a new version of the linked one. */
  async save(
    actor: Actor,
    projectId: string,
    raw: z.input<typeof LibrarySaveInputSchema>,
  ): Promise<LibrarySaveResult> {
    const started = performance.now();
    const input = LibrarySaveInputSchema.parse(raw);
    const { kind, id } = input.entity;
    await this.allow('publish', undefined, { projectId });
    const docs = await this.deps.projects.docs(projectId);
    const collection =
      kind === 'character' ? docs.characters : kind === 'element' ? docs.elements : docs.resources;
    const entity: LibraryEntity | undefined = Object.hasOwn(collection, id) ? collection[id] : undefined;
    if (!entity) throw notFound(`${kind} ${id}`);
    const linkedId = input.newItem ? null : (input.itemId ?? entity.library?.itemId ?? null);
    const item = linkedId ? await this.store.item(linkedId) : null;
    if (input.itemId && !item) throw notFound(`library item ${input.itemId}`);
    if (item && item.kind !== kind)
      throw invalid(`a ${kind} is saved as a ${kind} item, not into ${item.name} (a ${item.kind})`);
    const snap = entitySnapshot(kind, entity);
    const schema =
      kind === 'character'
        ? CharacterSnapshotSchema
        : kind === 'element'
          ? ElementSnapshotSchema
          : ResourceSnapshotSchema;
    const checked = schema.safeParse(snap.payload);
    if (!checked.success)
      throw invalid(
        `${entity.name} cannot be saved to the library as it is`,
        checked.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      );
    const payload = snap.payload;
    const realPerson = isRealPersonSnapshot(kind, payload);
    if (realPerson && !input.acknowledgeConsent)
      throw new AppError(
        'consent_required',
        `${entity.name} shows a real person: confirm that the consent covers using this likeness or voice in other projects of the studio (acknowledgeConsent)`,
        consentSubjects(kind, payload),
      );
    // the files, project → library (each once)
    const locals = new Map<string, string>();
    let bytes = 0;
    for (const f of snap.files) {
      if (locals.has(f.hash)) continue;
      const local = await this.deps.media.localPath(projectId, f);
      locals.set(f.hash, local);
      bytes += f.size;
      if (await this.store.putFile(local, f.hash, f.size, f.mime))
        this.deps.metrics.libraryBytes.inc({ op: 'from_project' }, f.size);
    }
    if (kind === 'resource') {
      const poster = (entity as Resource).media.poster;
      if (poster) {
        const stored = await this.storePoster(projectId, poster);
        (payload as ResourceSnapshot).media.poster = stored;
        bytes += stored.size;
      }
    }
    const thumbnail = await this.makeThumbnail({ kind, payload }, locals);
    const h = await this.deps.projects.existing(projectId);
    const tip = await h.repo.readRef(await h.repo.currentBranch());
    const draft: Draft = {
      kind,
      payload,
      thumbnail,
      digest: libraryDigest(kind, payload, sha256),
      realPerson,
      bytes: bytes + (thumbnail?.size ?? 0),
      note: input.note ?? '',
      basedOn: input.basedOn ?? null,
      source: { projectId, entityId: entity.id, commit: tip },
    };
    const out = item
      ? await this.publishVersion(actor, item.id, draft)
      : await this.publishItem(
          actor,
          {
            kind,
            name: input.name ?? entity.name.slice(0, LIBRARY_LIMITS.name),
            description: input.description ?? '',
            tags: input.tags ?? [],
            entityId: kind === 'resource' ? null : entity.id,
          },
          draft,
        );
    const link = {
      itemId: out.item.id,
      version: out.version.version,
      digest: out.version.digest,
      mode: 'saved' as const,
      at: new Date().toISOString(),
      by: actor,
    };
    const { commit } = await this.mutate(
      actor,
      projectId,
      (tx) => {
        const path = ENTITY_PATH[kind](entity.id);
        const cur = tx.require<LibraryEntity>(path, `${kind} ${entity.id}`);
        const was = cur.library;
        if (was && was.itemId === link.itemId && was.version === link.version && was.digest === link.digest)
          return;
        tx.set(path, { ...cur, library: link });
      },
      { message: `Save ${entity.name} to the library (v${out.version.version})` },
    );
    this.deps.metrics.library.inc({ event: 'saved', kind });
    this.deps.metrics.libraryApplySeconds.observe({ op: 'save' }, (performance.now() - started) / 1000);
    this.deps.log.info(
      {
        projectId,
        itemId: out.item.id,
        kind,
        version: out.version.version,
        entityId: entity.id,
        unchanged: out.unchanged,
      },
      'library saved',
    );
    return { ...out, commit: commit?.id ?? null };
  }

  private async storePoster(projectId: string, poster: { path: string; mime: string }) {
    const res = await this.deps.media.stream(projectId, poster.path);
    if (!res)
      throw new AppError('storage_error', `the poster ${poster.path} is missing from storage`, [], true);
    const tmp = this.deps.media.tmp(extFor(poster.mime, poster.path));
    try {
      await pipeline(res.stream, createWriteStream(tmp));
      const hash = await sha256File(tmp);
      const size = (await stat(tmp)).size;
      if (await this.store.putFile(tmp, hash, size, poster.mime))
        this.deps.metrics.libraryBytes.inc({ op: 'from_project' }, size);
      return { hash, mime: poster.mime, size };
    } finally {
      await rm(tmp, { force: true });
    }
  }

  /** A library file into the project's media (and its poster), as a MediaRef with its media fields. */
  private async copyFile(projectId: string, m: LibraryMedia, kind: MediaKind): Promise<MediaRef> {
    const tmp = await this.store.fileToTmp(m.hash, extFor(m.mime));
    try {
      const ref = await this.deps.media.putFile(projectId, tmp, {
        kind,
        name: m.name,
        mime: m.mime,
        probe: false,
      });
      let poster: { path: string; mime: string } | null = null;
      if (m.poster) {
        const file = await this.store.fileToTmp(m.poster.hash, extFor(m.poster.mime));
        try {
          const p = await this.deps.media.putFile(projectId, file, {
            kind: 'posters',
            name: 'poster',
            stem: m.hash.slice(0, 12),
            mime: m.poster.mime,
            probe: false,
          });
          poster = { path: p.path, mime: p.mime };
        } finally {
          await rm(file, { force: true });
        }
      }
      this.deps.metrics.libraryBytes.inc({ op: 'to_project' }, m.size);
      return projectMediaOf(m, ref.path, poster);
    } finally {
      await rm(tmp, { force: true });
    }
  }

  /** The version's files in the project: the ones it already holds as they are, the others copied (each once). */
  private async copyIntoProject(
    projectId: string,
    v: LibraryVersion,
    held: Map<string, MediaRef>,
  ): Promise<Map<string, MediaRef>> {
    const copied = new Map<string, MediaRef>();
    const copy = async (m: LibraryMedia, kind: MediaKind) => {
      if (copied.has(m.hash)) return;
      const have = held.get(m.hash);
      copied.set(m.hash, have && (!m.poster || have.poster) ? have : await this.copyFile(projectId, m, kind));
    };
    if (v.kind === 'character') {
      for (const r of v.payload.references) await copy(r.media, 'refs');
      if (v.payload.voice?.sample) await copy(v.payload.voice.sample, 'voices');
    } else if (v.kind === 'element') {
      for (const r of v.payload.references) await copy(r.media, 'refs');
    } else if (v.kind === 'resource') {
      await copy(v.payload.media, v.payload.kind === 'lut' ? 'luts' : 'uploads');
    }
    return copied;
  }

  /**
   * Use in project, update, link or pin (docs/design/library.md#use-in-project-update-and-link-apply): the plan, then
   * (unless a dry run) the files copied and one commit, planned again on the documents at the commit's tip.
   */
  async apply(
    actor: Actor,
    projectId: string,
    raw: z.input<typeof LibraryApplyInputSchema>,
  ): Promise<LibraryApplyResult> {
    const started = performance.now();
    const input = LibraryApplyInputSchema.parse(raw);
    const item = await this.get(input.itemId);
    const version = await this.version(item.id, input.version ?? item.current);
    const docs = await this.deps.projects.docs(projectId);
    const now = new Date().toISOString();
    const held = projectMedia(docs);
    const ctx = {
      docs,
      item,
      version,
      input,
      sha256,
      identity: IDENTITY,
      actor,
      now,
      present: new Set(held.keys()),
    };
    const plan = rule(() => planApply(ctx));
    if ((version.kind === 'character' || version.kind === 'element') && version.payload.deskUnit) {
      const pin = version.payload.deskUnit;
      if (!(await this.store.item(pin.itemId)))
        plan.warnings.push(
          `the 3D ${DESK_NOUN[pin.kind]} ${pin.name} v${pin.version} is not in this studio's library: its scenes stage from the words`,
        );
    }
    const entityRef = { kind: plan.entity.kind, id: plan.entity.id };
    // a dry run answers the plan to anyone who may edit: its realPerson and needs say what the apply will ask
    if (input.dryRun) return { plan, applied: false, entity: entityRef, commit: null };
    if (plan.realPerson && !input.acknowledgeConsent)
      throw new AppError(
        'consent_required',
        `${item.name} shows a real person: confirm that the consent covers using this likeness or voice in this project (acknowledgeConsent)`,
        consentSubjects(version.kind, version.payload),
      );
    const p = this.principal();
    if (plan.needs === 'project.approve') await this.deps.accounts.authorize(p, projectId, 'project.approve');
    const copied = isDeskUnitKind(version.kind)
      ? new Map<string, MediaRef>()
      : await this.copyIntoProject(projectId, version, held);
    const resourceId = version.kind === 'resource' ? newId('resource') : undefined;
    const { result, commit } = await this.mutate(
      actor,
      projectId,
      (tx) => {
        const out = rule(() => applyVersion({ ...ctx, docs: txDocs(tx), copied, resourceId }));
        // a change made meanwhile that now needs a director: asked again, never applied unchecked
        if (out.plan.needs === 'project.approve' && plan.needs !== 'project.approve')
          throw new AppError(
            'conflict',
            'the project changed meanwhile: an approved clip is now affected; plan again',
          );
        if (out.write) tx.set(out.write.path, out.write.doc);
        return out;
      },
      { message: (out) => out.message },
    );
    const event = { create: 'used', update: 'updated', link: 'linked', pin: 'pinned' }[result.plan.mode];
    this.deps.metrics.library.inc({ event, kind: item.kind });
    this.deps.metrics.libraryApplySeconds.observe({ op: 'apply' }, (performance.now() - started) / 1000);
    if (result.write)
      await this.audit(p, 'library.apply', projectId, {
        itemId: item.id,
        kind: item.kind,
        version: version.version,
        mode: result.plan.mode,
        entity: entityRef,
        realPerson: version.realPerson,
      });
    this.deps.log.info(
      {
        projectId,
        itemId: item.id,
        kind: item.kind,
        version: version.version,
        entityId: entityRef.id,
        mode: result.plan.mode,
        staleTakes: result.plan.staleTakes,
        approvedClips: result.plan.approvedClips.length,
        applied: !!result.write,
      },
      'library applied',
    );
    return {
      plan: { ...result.plan, warnings: plan.warnings },
      applied: !!result.write,
      entity: entityRef,
      commit: commit?.id ?? null,
    };
  }

  /** Unlink an entity from the library, or remove its 3D pin (docs/design/library.md#detach). */
  async detach(
    actor: Actor,
    projectId: string,
    raw: z.input<typeof LibraryDetachInputSchema>,
  ): Promise<LibraryDetachResult> {
    const { target, what } = LibraryDetachInputSchema.parse(raw);
    if (what === 'deskUnit' && target.kind === 'resource') throw invalid('a resource has no 3D unit');
    const path = ENTITY_PATH[target.kind](target.id);
    const { result, commit } = await this.mutate(
      actor,
      projectId,
      (tx) => {
        const cur = tx.require<LibraryEntity & { deskUnit?: Character['deskUnit'] }>(
          path,
          `${target.kind} ${target.id}`,
        );
        const was = what === 'library' ? cur.library : cur.deskUnit;
        if (was) tx.set(path, { ...cur, [what]: null });
        return { name: cur.name, was: was ?? null };
      },
      {
        message: (r) =>
          what === 'library'
            ? `Unlink ${r.name} from the library`
            : `Remove the 3D ${r.was && 'kind' in r.was ? DESK_NOUN[r.was.kind] : 'unit'} from ${r.name}`,
      },
    );
    if (result.was) {
      this.deps.metrics.library.inc({ event: 'detached', kind: target.kind });
      this.deps.log.info(
        { projectId, entityId: target.id, what, itemId: result.was.itemId, version: result.was.version },
        'library detached',
      );
    }
    return { entity: target, commit: commit?.id ?? null };
  }

  /** The project's links and pins, each against its item's current version (docs/design/library.md#status). */
  async status(projectId: string): Promise<LibraryProjectStatus> {
    const docs = await this.deps.projects.docs(projectId);
    await this.loaded();
    const links: LibraryLinkStatus[] = [];
    const row = async (
      entity: { kind: 'character' | 'element' | 'resource'; id: string; name: string },
      via: 'library' | 'deskUnit',
      itemId: string,
      version: number,
      modified: boolean,
    ) => {
      const item = await this.store.item(itemId);
      links.push({
        entity,
        via,
        itemId,
        version,
        item: item
          ? { name: item.name, kind: item.kind, current: item.current, archived: item.archived }
          : null,
        state: !item
          ? 'missing'
          : version === item.current
            ? 'current'
            : version < item.current
              ? 'behind'
              : 'ahead',
        modified,
      });
    };
    const edited = (kind: 'character' | 'element' | 'resource', e: LibraryEntity) =>
      !!e.library && libraryDigest(kind, entitySnapshot(kind, e).payload, sha256) !== e.library.digest;
    for (const [kind, map] of [
      ['character', docs.characters],
      ['element', docs.elements],
      ['resource', docs.resources],
    ] as const) {
      for (const e of Object.values(map) as LibraryEntity[]) {
        const ref = { kind, id: e.id, name: e.name };
        if (e.library) await row(ref, 'library', e.library.itemId, e.library.version, edited(kind, e));
        const pin = (e as Character | Element).deskUnit;
        if (kind !== 'resource' && pin) await row(ref, 'deskUnit', pin.itemId, pin.version, false);
      }
    }
    return {
      links: links.slice(0, LIBRARY_LIMITS.usesRows),
      behind: links.filter((l) => l.state === 'behind').length,
    };
  }

  /**
   * Where an item is used (docs/design/library.md#where-it-is-used): the projects the caller may read, from their
   * digests (8 at a time, with the request's workspace set aside so every attached browser counts); a digest from
   * before the field is completed from the documents. `incomplete` when a project could not be read, and always when
   * projects live in browsers.
   */
  async uses(itemId: string): Promise<LibraryUses> {
    await this.get(itemId);
    const principal = this.principal();
    let incomplete = this.deps.config.storage.mode === 'browser';
    const projects: LibraryUses['projects'] = [];
    await workspaceContext.run(null, async () => {
      const ids = await this.deps.projects.listIds();
      await eachLimit(ids, DIGESTS_AT_ONCE, async (id) => {
        try {
          const d = await this.deps.projects.digest(id);
          const role = this.deps.accounts.roleInProject(principal, { id, access: d.access });
          if (!role) return;
          let rows: DigestLibraryUse[] | undefined = d.library;
          if (!rows) {
            rows = libraryUses(await this.deps.projects.docs(id));
            this.deps.projects.completeDigest(id, d, { library: rows });
          }
          const uses = rows.filter((r) => r.itemId === itemId);
          if (uses.length) projects.push({ projectId: id, title: d.summary.title, role, uses });
        } catch (err) {
          incomplete = true;
          this.deps.log.warn(
            { projectId: id, itemId, err: (err as Error).message },
            'library uses: project unread',
          );
        }
      });
    });
    return { incomplete, projects: projects.sort((a, b) => a.title.localeCompare(b.title)) };
  }
}

/** `412 library_conflict`, carrying the head whose ETag the answer names. */
export class LibraryConflictError extends AppError {
  readonly etag: string;
  constructor(item: LibraryItem, message: string, errors: unknown[]) {
    super('library_conflict', message, errors);
    this.etag = libraryEtag(item);
  }
}
