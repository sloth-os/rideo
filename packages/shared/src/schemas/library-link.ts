import { z } from 'zod';
import { ActorSchema, IsoDateSchema } from './common';

/**
 * What a project's entities record of the studio library (docs/design/library.md): the link of a character, element
 * or resource to the library version it came from or was saved as, and the 3D unit a character or element pins.
 * Kept apart from `library.ts` so that the entity schemas import it without a cycle.
 */

/** A SHA-256 in lowercase hex. */
export const Sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/, 'a sha256 in lowercase hex');

/** `lib_` and the id alphabet (docs/design/library.md#the-item). */
export const LibraryItemIdSchema = z.string().regex(/^lib_[0-9a-z]{10,32}$/, 'a library item id (lib_…)');

/** Versions are numbered 1, 2, 3… per item, at most 1000 an item (docs/design/library.md#limits). */
export const LIBRARY_MAX_VERSIONS = 1000;
export const LibraryVersionNumberSchema = z.number().int().min(1).max(LIBRARY_MAX_VERSIONS);

/** The 3D units of the director's desk (docs/design/library.md#what-it-holds). */
export const DESK_UNIT_KINDS = ['desk-set', 'desk-prop', 'desk-figure'] as const;
export const DeskUnitKindSchema = z.enum(DESK_UNIT_KINDS);
export type DeskUnitKind = z.infer<typeof DeskUnitKindSchema>;

/** A library version: the item, its number and its digest (the snapshot digest, or a 3D unit file's sha256). */
export const LibraryPinSchema = z.object({
  itemId: LibraryItemIdSchema,
  version: LibraryVersionNumberSchema,
  digest: Sha256HexSchema,
});
export type LibraryPin = z.infer<typeof LibraryPinSchema>;

/**
 * `entity.library` on characters, elements and resources (docs/design/library.md#copy-on-apply): the version the
 * entity was saved as (`saved`), came from (`used`), was updated to (`updated`) or linked to (`linked`). Metadata
 * only: no identity hash reads it.
 */
export const LibraryOriginSchema = LibraryPinSchema.extend({
  mode: z.enum(['saved', 'used', 'linked', 'updated']),
  at: IsoDateSchema,
  by: ActorSchema,
});
export type LibraryOrigin = z.infer<typeof LibraryOriginSchema>;

/**
 * `deskUnit` on characters (`desk-figure`) and on location (`desk-set`) and prop (`desk-prop`) elements
 * (docs/design/library.md#pins-on-entities): the 3D unit version the desk stages for it. Its bytes stay in the
 * library (never copied into the project); `sha256` is the unit file's. Not identity: the identity hashes leave it
 * out, it may change on a locked entity and never bumps a lock version.
 */
export const DeskUnitPinSchema = z.object({
  kind: DeskUnitKindSchema,
  itemId: LibraryItemIdSchema,
  version: LibraryVersionNumberSchema,
  sha256: Sha256HexSchema,
  /** The item's name when it was pinned. */
  name: z.string().trim().min(1).max(120),
  /** Figures: the actor kind of the figure's publish meta; else null. */
  actorKind: z.string().min(1).max(60).nullable(),
  /** Figures: the figure's height in metres; else null. */
  heightM: z.number().positive().max(8).nullable(),
  pinnedAt: IsoDateSchema,
  pinnedBy: ActorSchema,
});
export type DeskUnitPin = z.infer<typeof DeskUnitPinSchema>;

/** The desk-unit kind an entity may pin: a character's figure, a location's set, a prop's prop; a style none. */
export function deskUnitKindFor(
  entity: { kind: 'character' } | { kind: 'element'; elementKind: 'location' | 'prop' | 'style' },
): DeskUnitKind | null {
  if (entity.kind === 'character') return 'desk-figure';
  if (entity.elementKind === 'location') return 'desk-set';
  if (entity.elementKind === 'prop') return 'desk-prop';
  return null;
}
