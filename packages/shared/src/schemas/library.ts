import { z } from 'zod';
import { ProjectRoleSchema } from './accounts';
import {
  CharacterReferenceSchema,
  CharacterRoleSchema,
  ConsentSchema,
  IdentitySchema,
  VoiceSourceSchema,
  WardrobeSchema,
} from './character';
import { IdSchema, IsoDateSchema, MediaRefSchema, ProbeSchema } from './common';
import { ElementKindSchema, ElementReferenceSchema } from './element';
import {
  DESK_UNIT_KINDS,
  type DeskUnitKind,
  DeskUnitPinSchema,
  LIBRARY_MAX_VERSIONS,
  LibraryItemIdSchema,
  LibraryVersionNumberSchema,
  Sha256HexSchema,
} from './library-link';
import { ResourceKindSchema, ResourceRoleSchema } from './resource';
import { AuthorSchema } from './review';

/**
 * The studio library (docs/design/library.md): items shared by the studio's projects, each in versions that never
 * change. Characters, elements and resources are copied into projects; 3D units are pinned by version.
 */

export const LIBRARY_KINDS = ['character', 'element', 'resource', ...DESK_UNIT_KINDS] as const;
export const LibraryKindSchema = z.enum(LIBRARY_KINDS);
export type LibraryKind = z.infer<typeof LibraryKindSchema>;

export function isDeskUnitKind(kind: string): kind is DeskUnitKind {
  return (DESK_UNIT_KINDS as readonly string[]).includes(kind);
}

/** The format 3D unit files declare (the 3D-Editor's `UNIT_FORMAT`). */
export const DESK_UNIT_FORMAT = '3d-editor.desk-unit';
/** The unit file's kind (`set`, `prop`, `figure`) of each 3D library kind. */
export const DESK_UNIT_FILE_KIND: Record<DeskUnitKind, 'set' | 'prop' | 'figure'> = {
  'desk-set': 'set',
  'desk-prop': 'prop',
  'desk-figure': 'figure',
};

/** docs/design/library.md#limits */
export const LIBRARY_LIMITS = {
  name: 120,
  description: 2000,
  note: 500,
  tags: 20,
  tag: 40,
  versions: LIBRARY_MAX_VERSIONS,
  page: 200,
  defaultPage: 100,
  /** One 3D unit file (the desk's `capabilities.units.maxBytes`). */
  deskUnitBytes: 32 * 1024 * 1024,
  /** A unit file's JSON header. */
  deskUnitHeaderBytes: 64 * 1024,
  /** The desk's publish meta, encoded. */
  deskMetaBytes: 16 * 1024,
  deskCredits: 32,
  thumbnailBytes: 64 * 1024,
  thumbnailSide: 256,
  /** The multipart `meta` part of an upload. */
  uploadMetaBytes: 32 * 1024,
  imageBytes: 50 * 1024 ** 2,
  lutBytes: 16 * 1024 ** 2,
  mediaBytes: 4 * 1024 ** 3,
  characterReferences: 32,
  elementReferences: 16,
  wardrobe: 50,
  usesRows: 1000,
} as const;

/** Lower case, 1–40 characters: letters, digits, space, `_`, `.`, `-` (`season 1`, `harbor-town`). */
export const LibraryTagSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9][a-z0-9 _.-]{0,39}$/, 'a tag of 1–40 lower-case letters, digits, spaces, _ . -');

const encodedBytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;

/** The desk's publish `meta` (docs/design/director-desk.md#publishing-and-linking), at most 16 KiB of JSON. */
export const DeskUnitMetaSchema = z
  .object({
    dimensionsM: z.tuple([z.number().min(0), z.number().min(0), z.number().min(0)]),
    objects: z.number().int().min(0),
    triangles: z.number().int().min(0),
    actor: z.object({ kind: z.string().min(1).max(60), heightM: z.number().positive().max(8) }).nullable(),
    credits: z
      .array(
        z.object({
          name: z.string().min(1).max(120),
          author: z.string().max(200).nullable(),
          license: z.string().min(1).max(64),
        }),
      )
      .max(LIBRARY_LIMITS.deskCredits),
    deskVersion: z.string().min(1).max(64),
    /** The unit's body digest (the 3D-Editor's `header.digest`): kept as given, never compared. */
    digest: Sha256HexSchema,
  })
  .refine((m) => encodedBytes(m) <= LIBRARY_LIMITS.deskMetaBytes, 'the meta is at most 16 KiB of JSON');
export type DeskUnitMeta = z.infer<typeof DeskUnitMetaSchema>;

/**
 * A library file, named by its sha256 (`hash`): a MediaRef without a project path. `name` is the stem of its copies in
 * a project (`media/<kind>/<name>-<hash12>.<ext>`).
 */
export const LibraryMediaSchema = MediaRefSchema.omit({ path: true, poster: true, lanes: true }).extend({
  name: z.string().min(1).max(60),
  /** A video's poster frame, a library file of its own. */
  poster: z
    .object({
      hash: Sha256HexSchema,
      mime: z.string().min(3).max(100),
      size: z.number().int().nonnegative(),
    })
    .optional(),
});
export type LibraryMedia = z.infer<typeof LibraryMediaSchema>;

/** A pin as a character or element version carries it: without who pinned it and when. */
export const LibrarySnapshotPinSchema = DeskUnitPinSchema.omit({ pinnedAt: true, pinnedBy: true });
export type LibrarySnapshotPin = z.infer<typeof LibrarySnapshotPinSchema>;

export const LibraryCharacterReferenceSchema = CharacterReferenceSchema.omit({ media: true }).extend({
  media: LibraryMediaSchema,
});

/** A character's voice in a version: designed or cloned, with its sample and consent; candidates left out. */
export const VoiceSnapshotSchema = z.object({
  description: z.string().max(1000),
  provider: z.string().max(40).nullable(),
  voiceId: z.string().max(200).nullable(),
  source: VoiceSourceSchema.nullable(),
  sample: LibraryMediaSchema.nullable(),
  consent: ConsentSchema.optional(),
  locked: z.boolean(),
});
export type VoiceSnapshot = z.infer<typeof VoiceSnapshotSchema>;

/** docs/design/library.md#a-version: the character's library-owned content (approved references only). */
export const CharacterSnapshotSchema = z.object({
  name: z.string().min(1).max(120),
  role: CharacterRoleSchema,
  summary: z.string().max(4000),
  identity: IdentitySchema,
  wardrobe: z.array(WardrobeSchema).max(LIBRARY_LIMITS.wardrobe),
  personality: z.string().max(2000).optional(),
  references: z.array(LibraryCharacterReferenceSchema).max(LIBRARY_LIMITS.characterReferences),
  voice: VoiceSnapshotSchema.nullable(),
  seed: z.number().int().nonnegative().max(0xffffffff),
  locked: z.boolean(),
  deskUnit: LibrarySnapshotPinSchema.refine(
    (p) => p.kind === 'desk-figure',
    'a character pins a 3D figure',
  ).nullable(),
});
export type CharacterSnapshot = z.infer<typeof CharacterSnapshotSchema>;

export const LibraryElementReferenceSchema = ElementReferenceSchema.omit({ media: true }).extend({
  media: LibraryMediaSchema,
});

export const ElementSnapshotSchema = z
  .object({
    kind: ElementKindSchema,
    name: z.string().trim().min(1).max(120),
    description: z.string().max(2000),
    aliases: z.array(z.string().trim().min(1).max(120)).max(20),
    references: z.array(LibraryElementReferenceSchema).max(LIBRARY_LIMITS.elementReferences),
    seed: z.number().int().nonnegative().max(0xffffffff),
    locked: z.boolean(),
    deskUnit: LibrarySnapshotPinSchema.nullable(),
  })
  .superRefine((e, ctx) => {
    const fits = { location: 'desk-set', prop: 'desk-prop', style: null }[e.kind];
    if (e.deskUnit && e.deskUnit.kind !== fits)
      ctx.addIssue({
        code: 'custom',
        path: ['deskUnit'],
        message: fits ? `a ${e.kind} pins a ${fits}` : 'a style pins no 3D unit',
      });
  });
export type ElementSnapshot = z.infer<typeof ElementSnapshotSchema>;

export const ResourceSnapshotSchema = z.object({
  kind: ResourceKindSchema,
  role: ResourceRoleSchema,
  name: z.string().min(1).max(300),
  notes: z.string().max(4000).optional(),
  media: LibraryMediaSchema,
});
export type ResourceSnapshot = z.infer<typeof ResourceSnapshotSchema>;

/** A 3D unit: the desk's file (never read past its header by rideo) and its publish meta. */
export const DeskUnitSnapshotSchema = z.object({
  format: z.literal(DESK_UNIT_FORMAT),
  formatVersion: z.number().int().min(1).max(1000),
  payload: LibraryMediaSchema,
  meta: DeskUnitMetaSchema,
});
export type DeskUnitSnapshot = z.infer<typeof DeskUnitSnapshotSchema>;

const VersionBase = z.object({
  itemId: LibraryItemIdSchema,
  version: LibraryVersionNumberSchema,
  /** 3D units: the unit file's sha256; the others: the snapshot digest (`libraryDigest`). */
  digest: Sha256HexSchema,
  thumbnail: LibraryMediaSchema.nullable(),
  /** The version it was made from. */
  basedOn: LibraryVersionNumberSchema.nullable(),
  note: z.string().max(LIBRARY_LIMITS.note).default(''),
  /** Saved from a project: which, from which entity, at which commit. */
  source: z
    .object({ projectId: IdSchema, entityId: IdSchema, commit: z.string().max(64).nullable() })
    .nullable(),
  /** Its approved references or its cloned voice show a real person. */
  realPerson: z.boolean(),
  /** The version's files, its thumbnail included. */
  bytes: z.number().int().nonnegative(),
  createdBy: AuthorSchema,
  createdAt: IsoDateSchema,
});

/** A version's manifest: `<root>/library/items/<lib_id>/v0001.json`, written once. */
export const LibraryVersionSchema = z.discriminatedUnion('kind', [
  VersionBase.extend({ kind: z.literal('character'), payload: CharacterSnapshotSchema }),
  VersionBase.extend({ kind: z.literal('element'), payload: ElementSnapshotSchema }),
  VersionBase.extend({ kind: z.literal('resource'), payload: ResourceSnapshotSchema }),
  VersionBase.extend({ kind: z.literal('desk-set'), payload: DeskUnitSnapshotSchema }),
  VersionBase.extend({ kind: z.literal('desk-prop'), payload: DeskUnitSnapshotSchema }),
  VersionBase.extend({ kind: z.literal('desk-figure'), payload: DeskUnitSnapshotSchema }),
]);
export type LibraryVersion = z.infer<typeof LibraryVersionSchema>;
export type LibraryPayload = LibraryVersion['payload'];

export const LibraryHistoryEntrySchema = VersionBase.pick({
  version: true,
  digest: true,
  basedOn: true,
  note: true,
  realPerson: true,
  bytes: true,
  createdBy: true,
  createdAt: true,
});
export type LibraryHistoryEntry = z.infer<typeof LibraryHistoryEntrySchema>;

/** The current version of a 3D unit as pickers show it, without reading its manifest. */
export const LibraryUnitInfoSchema = z.object({
  sha256: Sha256HexSchema,
  bytes: z.number().int().nonnegative(),
  format: z.string().min(1).max(64),
  formatVersion: z.number().int().min(1).max(1000),
  actorKind: z.string().min(1).max(60).nullable(),
  heightM: z.number().positive().max(8).nullable(),
  dimensionsM: z.tuple([z.number().min(0), z.number().min(0), z.number().min(0)]).optional(),
});
export type LibraryUnitInfo = z.infer<typeof LibraryUnitInfoSchema>;

/** An item's head: `<root>/library/items/<lib_id>.json`, rewritten on every change of the item. */
export const LibraryItemSchema = z.object({
  id: LibraryItemIdSchema,
  kind: LibraryKindSchema,
  name: z.string().trim().min(1).max(LIBRARY_LIMITS.name),
  description: z.string().max(LIBRARY_LIMITS.description).default(''),
  tags: z.array(LibraryTagSchema).max(LIBRARY_LIMITS.tags).default([]),
  /** Characters and elements: the chr_/ele_ id of the first save, the id projects give it when it is free. */
  entityId: IdSchema.nullable().default(null),
  /** The version pickers and Use in project take. */
  current: LibraryVersionNumberSchema,
  /** The highest version. */
  latest: LibraryVersionNumberSchema,
  /** Every version, oldest first. */
  history: z.array(LibraryHistoryEntrySchema).min(1).max(LIBRARY_MAX_VERSIONS),
  /** The current version's thumbnail. */
  thumbnail: z
    .object({
      version: LibraryVersionNumberSchema,
      hash: Sha256HexSchema,
      mime: z.literal('image/png'),
      width: z.number().int().positive().optional(),
      height: z.number().int().positive().optional(),
    })
    .nullable()
    .default(null),
  /** 3D units: the current version's file and meta. */
  unit: LibraryUnitInfoSchema.nullable().default(null),
  /** The current version shows a real person (a likeness or a cloned voice). */
  realPerson: z.boolean().default(false),
  /** Hidden from pickers; still served; pins and links keep working. */
  archived: z.boolean().default(false),
  /** Who created it (an agent token's owner for agents): its manager with the admins. */
  ownerId: z.string().min(1).max(128),
  createdBy: AuthorSchema,
  createdAt: IsoDateSchema,
  updatedBy: AuthorSchema,
  updatedAt: IsoDateSchema,
  /** The head's revision: its ETag is `"r<rev>"`. */
  rev: z.number().int().min(1),
});
export type LibraryItem = z.infer<typeof LibraryItemSchema>;

/** What lists answer: the head without its history, with how many versions it has. */
export const LibraryItemSummarySchema = LibraryItemSchema.omit({ history: true }).extend({
  versions: z.number().int().min(1),
});
export type LibraryItemSummary = z.infer<typeof LibraryItemSummarySchema>;

export function librarySummary(item: LibraryItem): LibraryItemSummary {
  const { history, ...rest } = item;
  return { ...rest, versions: history.length };
}

/** The head's ETag. */
export const libraryEtag = (item: Pick<LibraryItem, 'rev'>) => `"r${item.rev}"`;

// ---------------------------------------------------------------- inputs

/** A list of items as services take it (MCP `library_list`). */
export const LibraryListInputSchema = z.object({
  kinds: z.array(LibraryKindSchema).max(LIBRARY_KINDS.length).optional(),
  kind: LibraryKindSchema.optional(),
  tag: LibraryTagSchema.optional(),
  /** Words of the name, description or tags. */
  q: z.string().max(200).optional(),
  /** true: archived items too (the default leaves them out). */
  archived: z.boolean().default(false),
  sort: z.enum(['updated', 'name']).default('updated'),
  limit: z.number().int().min(1).max(LIBRARY_LIMITS.page).default(LIBRARY_LIMITS.defaultPage),
  cursor: z
    .string()
    .regex(/^[0-9]{1,6}$/)
    .optional(),
});
export type LibraryListInput = z.infer<typeof LibraryListInputSchema>;

/** The same list as a REST query (`?kinds=desk-set,desk-prop&archived=false&limit=50`). */
export const LibraryListQuerySchema = z.object({
  kinds: z
    .string()
    .max(200)
    .transform((s) =>
      s
        .split(',')
        .map((k) => k.trim())
        .filter(Boolean),
    )
    .pipe(z.array(LibraryKindSchema).max(LIBRARY_KINDS.length))
    .optional(),
  kind: LibraryKindSchema.optional(),
  tag: LibraryTagSchema.optional(),
  q: z.string().max(200).optional(),
  archived: z.stringbool().default(false),
  sort: z.enum(['updated', 'name']).default('updated'),
  limit: z.coerce.number().int().min(1).max(LIBRARY_LIMITS.page).default(LIBRARY_LIMITS.defaultPage),
  cursor: z
    .string()
    .regex(/^[0-9]{1,6}$/)
    .optional(),
});

export const LibraryListResultSchema = z.object({
  items: z.array(LibraryItemSummarySchema),
  /** The cursor of the next page; null on the last. */
  next: z.string().nullable(),
});
export type LibraryListResult = z.infer<typeof LibraryListResultSchema>;

/** The multipart part `meta` of an upload: first, then the file `payload`, then an optional `thumbnail`. */
export const LibraryUploadMetaSchema = z
  .object({
    kind: z.enum(['resource', ...DESK_UNIT_KINDS]),
    /** Required to create an item. */
    name: z.string().trim().min(1).max(LIBRARY_LIMITS.name).optional(),
    description: z.string().max(LIBRARY_LIMITS.description).optional(),
    tags: z.array(LibraryTagSchema).max(LIBRARY_LIMITS.tags).optional(),
    note: z.string().max(LIBRARY_LIMITS.note).optional(),
    /** A new version: the version it was made from (412 when it is not the item's latest). */
    basedOn: LibraryVersionNumberSchema.nullable().optional(),
    /** 3D units. */
    unit: z
      .object({
        format: z.literal(DESK_UNIT_FORMAT),
        formatVersion: z.number().int().min(1).max(1000),
        meta: DeskUnitMetaSchema,
      })
      .optional(),
    /** Resources. */
    resource: z
      .object({
        kind: ResourceKindSchema,
        role: ResourceRoleSchema,
        name: z.string().min(1).max(300),
        notes: z.string().max(4000).optional(),
        probe: ProbeSchema.optional(),
      })
      .optional(),
  })
  .superRefine((m, ctx) => {
    if (m.kind === 'resource') {
      if (!m.resource)
        ctx.addIssue({ code: 'custom', path: ['resource'], message: 'a resource needs `resource`' });
      if (m.unit) ctx.addIssue({ code: 'custom', path: ['unit'], message: 'a resource has no `unit`' });
    } else {
      if (!m.unit) ctx.addIssue({ code: 'custom', path: ['unit'], message: 'a 3D unit needs `unit`' });
      if (m.resource)
        ctx.addIssue({ code: 'custom', path: ['resource'], message: 'a 3D unit has no `resource`' });
    }
  });
export type LibraryUploadMeta = z.infer<typeof LibraryUploadMetaSchema>;

/** What its manager changes (`PATCH`, `library_update`). */
export const LibraryItemPatchSchema = z
  .object({
    name: z.string().trim().min(1).max(LIBRARY_LIMITS.name),
    description: z.string().max(LIBRARY_LIMITS.description),
    tags: z.array(LibraryTagSchema).max(LIBRARY_LIMITS.tags),
    current: LibraryVersionNumberSchema,
    archived: z.boolean(),
  })
  .partial()
  .refine((p) => Object.values(p).some((v) => v !== undefined), 'change at least one field');
export type LibraryItemPatch = z.infer<typeof LibraryItemPatchSchema>;

/** An entity of a project the library links. */
export const LibraryEntityRefSchema = z.object({
  kind: z.enum(['character', 'element', 'resource']),
  id: IdSchema,
});
export type LibraryEntityRef = z.infer<typeof LibraryEntityRefSchema>;

/** What an apply updates, links or pins. */
export const LibraryTargetSchema = z.object({ kind: z.enum(['character', 'element']), id: IdSchema });
export type LibraryTarget = z.infer<typeof LibraryTargetSchema>;

/** `POST /api/projects/:id/library/save`, `library_save` (docs/design/library.md#save-to-library). */
export const LibrarySaveInputSchema = z.object({
  entity: LibraryEntityRefSchema,
  /** A new version of this item (default: the item the entity is linked to). */
  itemId: LibraryItemIdSchema.optional(),
  /** A new item even when the entity is linked. */
  newItem: z.boolean().optional(),
  name: z.string().trim().min(1).max(LIBRARY_LIMITS.name).optional(),
  description: z.string().max(LIBRARY_LIMITS.description).optional(),
  tags: z.array(LibraryTagSchema).max(LIBRARY_LIMITS.tags).optional(),
  note: z.string().max(LIBRARY_LIMITS.note).optional(),
  /** The version the entity was made from: 412 `library_conflict` when the item has a later one. */
  basedOn: LibraryVersionNumberSchema.optional(),
  /** The consent covers using this real person's likeness or voice in other projects of the studio. */
  acknowledgeConsent: z.boolean().optional(),
});
export type LibrarySaveInput = z.infer<typeof LibrarySaveInputSchema>;

/** `POST /api/projects/:id/library/apply`, `library_apply` (docs/design/library.md#use-in-project-update-and-link-apply). */
export const LibraryApplyInputSchema = z.object({
  itemId: LibraryItemIdSchema,
  /** Default: the item's current version. */
  version: LibraryVersionNumberSchema.optional(),
  /** None: Use in project (a new entity). A character or element: update, link, or pin a 3D unit on it. */
  target: LibraryTargetSchema.nullable().optional(),
  /** A locked target is relocked (its lock version kept when its identity is unchanged, else raised). */
  relock: z.boolean().default(true),
  /**
   * A pin may replace another item's pin on its target: a 3D unit's, or the one a character's or element's version
   * carries. False refuses that (conflict `pinned`); a new version of the item already pinned still moves it.
   */
  replacePin: z.boolean().default(true),
  acknowledgeConsent: z.boolean().optional(),
  /** Answer the plan, write nothing. */
  dryRun: z.boolean().default(false),
});
export type LibraryApplyInput = z.infer<typeof LibraryApplyInputSchema>;

/** `POST /api/projects/:id/library/detach`, `library_detach`. */
export const LibraryDetachInputSchema = z.object({
  target: LibraryEntityRefSchema,
  what: z.enum(['library', 'deskUnit']),
});
export type LibraryDetachInput = z.infer<typeof LibraryDetachInputSchema>;

// ---------------------------------------------------------------- outputs

export const LIBRARY_CHANGES = [
  'name',
  'role',
  'summary',
  'identity',
  'wardrobe',
  'personality',
  'references',
  'voice',
  'description',
  'aliases',
  'seed',
  'deskUnit',
  'media',
] as const;

const LockChangeSchema = z.object({
  locked: z.boolean(),
  from: z.number().int().nullable(),
  to: z.number().int().nullable(),
});

/** What an apply does (a dry run answers it; every apply returns it). */
export const LibraryApplyPlanSchema = z.object({
  mode: z.enum(['create', 'update', 'link', 'pin']),
  item: z.object({
    id: LibraryItemIdSchema,
    kind: LibraryKindSchema,
    name: z.string(),
    version: z.number().int(),
    digest: Sha256HexSchema,
    current: z.number().int(),
  }),
  entity: z.object({
    kind: z.enum(['character', 'element', 'resource']),
    id: IdSchema,
    name: z.string(),
    exists: z.boolean(),
  }),
  /** Create: the entity gets the item's chr_/ele_ id. */
  keepsLibraryId: z.boolean(),
  changes: z.array(z.enum(LIBRARY_CHANGES)),
  lock: LockChangeSchema,
  voiceLock: LockChangeSchema.nullable(),
  /** Takes the apply makes stale (their recorded lock versions no longer the entity's). */
  staleTakes: z.number().int().nonnegative(),
  /** Approved clips whose selected takes go stale: they need a director. */
  approvedClips: z.array(z.object({ id: IdSchema, index: z.number().int(), title: z.string() })).max(500),
  /** The entity was edited here since its version: those edits are replaced. */
  localChanges: z.boolean(),
  /** Needs `acknowledgeConsent`. */
  realPerson: z.boolean(),
  files: z.object({
    count: z.number().int().nonnegative(),
    bytes: z.number().int().nonnegative(),
    toCopy: z.number().int().nonnegative(),
    bytesToCopy: z.number().int().nonnegative(),
  }),
  warnings: z.array(z.string().max(300)).max(50),
  needs: z.enum(['project.edit', 'project.approve']),
});
export type LibraryApplyPlan = z.infer<typeof LibraryApplyPlanSchema>;

export const LibraryApplyResultSchema = z.object({
  plan: LibraryApplyPlanSchema,
  applied: z.boolean(),
  entity: LibraryEntityRefSchema,
  commit: z.string().max(64).nullable(),
});
export type LibraryApplyResult = z.infer<typeof LibraryApplyResultSchema>;

export const LibrarySaveResultSchema = z.object({
  item: LibraryItemSchema,
  version: LibraryVersionSchema,
  /** Nothing changed since the current version: no version was added (the entity is still linked). */
  unchanged: z.boolean(),
  commit: z.string().max(64).nullable(),
});
export type LibrarySaveResult = z.infer<typeof LibrarySaveResultSchema>;

/** What an upload answers. */
export const LibraryUploadResultSchema = z.object({
  item: LibraryItemSchema,
  version: LibraryVersionSchema,
  unchanged: z.boolean(),
});
export type LibraryUploadResult = z.infer<typeof LibraryUploadResultSchema>;

export const LibraryDetachResultSchema = z.object({
  entity: LibraryEntityRefSchema,
  commit: z.string().max(64).nullable(),
});
export type LibraryDetachResult = z.infer<typeof LibraryDetachResultSchema>;

/** A link or pin of a project (`GET /api/projects/:id/library`). */
export const LibraryLinkStatusSchema = z.object({
  entity: z.object({ kind: z.enum(['character', 'element', 'resource']), id: IdSchema, name: z.string() }),
  via: z.enum(['library', 'deskUnit']),
  itemId: LibraryItemIdSchema,
  version: z.number().int(),
  /** null: an item this studio's library does not have. */
  item: z
    .object({ name: z.string(), kind: LibraryKindSchema, current: z.number().int(), archived: z.boolean() })
    .nullable(),
  /** The version against the item's current. */
  state: z.enum(['current', 'behind', 'ahead', 'missing']),
  /** Library links: the entity was edited here since that version. */
  modified: z.boolean(),
});
export type LibraryLinkStatus = z.infer<typeof LibraryLinkStatusSchema>;

export const LibraryProjectStatusSchema = z.object({
  links: z.array(LibraryLinkStatusSchema).max(LIBRARY_LIMITS.usesRows),
  behind: z.number().int().nonnegative(),
});
export type LibraryProjectStatus = z.infer<typeof LibraryProjectStatusSchema>;

/**
 * A use of a library version in a project, as its digest lists it (docs/design/library.md#where-it-is-used):
 * `library` a link, `deskUnit` a pin, `deskState` what the clips' stored desk states use.
 */
export const DigestLibraryUseSchema = z.object({
  itemId: LibraryItemIdSchema,
  version: LibraryVersionNumberSchema,
  via: z.enum(['library', 'deskUnit', 'deskState']),
  /** `library` and `deskUnit` rows. */
  entity: z
    .object({ kind: z.enum(['character', 'element', 'resource']), id: IdSchema, name: z.string().max(200) })
    .optional(),
  /** `deskState` rows: clips whose stored state uses the version, approved ones among them. */
  clips: z.number().int().nonnegative().optional(),
  approved: z.number().int().nonnegative().optional(),
});
export type DigestLibraryUse = z.infer<typeof DigestLibraryUseSchema>;

/** `GET /api/library/items/:itemId/uses`, `library_uses`. */
export const LibraryUsesSchema = z.object({
  /** A project could not be read, or projects live in browsers (unattached ones cannot be seen). */
  incomplete: z.boolean(),
  projects: z.array(
    z.object({
      projectId: IdSchema,
      title: z.string(),
      role: ProjectRoleSchema,
      uses: z.array(DigestLibraryUseSchema).max(LIBRARY_LIMITS.usesRows),
    }),
  ),
});
export type LibraryUses = z.infer<typeof LibraryUsesSchema>;
