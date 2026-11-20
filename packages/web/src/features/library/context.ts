import type {
  Character,
  DeskUnitKind,
  Element,
  LibraryLinkStatus,
  LibraryProjectStatus,
  ProjectDocs,
  Resource,
} from '@rideo/shared';
import { createContext, useContext } from 'react';

/**
 * The library in a project's Cast, Elements and Resources views (docs/design/library.md#cast-elements-and-resources):
 * the project's links and pins against their items, what the person may do, and the dialogs. `LibraryProvider` gives
 * it, one per view.
 */

export type EntityKind = 'character' | 'element' | 'resource';

/** What Save to library saves. */
export interface SaveTarget {
  kind: EntityKind;
  id: string;
  name: string;
  /** The entity's link, when it has one. */
  library: { itemId: string; version: number } | null;
  /** A character whose approved likeness or cloned voice is a real person. */
  realPerson: boolean;
}

/** An update or a link of an entity to an item's version, shown as its plan first. */
export interface PlanRequest {
  itemId: string;
  version?: number;
  target: { kind: 'character' | 'element'; id: string; name: string };
  /** The version the entity uses now (the plan's "v2 → v3"); null for a link. */
  fromVersion: number | null;
}

/** The 3D picker for one entity. */
export interface DeskRequest {
  deskKind: DeskUnitKind;
  target: { kind: 'character' | 'element'; id: string; name: string };
  /** The item pinned now, if any. */
  currentItemId: string | null;
}

export interface LibraryScopeValue {
  projectId: string;
  docs: ProjectDocs;
  /** The project's links and pins against their items; null until it arrives. */
  status: LibraryProjectStatus | null;
  refresh(): void;
  canEdit: boolean;
  canApprove: boolean;
  canPublish: boolean;
  /** The entity's library link against its item. */
  linkOf(kind: EntityKind, id: string): LibraryLinkStatus | undefined;
  /** The entity's 3D pin against its item. */
  pinOf(kind: 'character' | 'element', id: string): LibraryLinkStatus | undefined;
  openSave(target: SaveTarget): void;
  openPlan(request: PlanRequest): void;
  openDesk(request: DeskRequest): void;
  openUse(kind: EntityKind): void;
}

export const LibraryScope = createContext<LibraryScopeValue | null>(null);

/** The view's library scope; null outside a `LibraryProvider`. */
export function useLibraryScope(): LibraryScopeValue | null {
  return useContext(LibraryScope);
}

/** What changes the status: the linked or pinned entities as they are (an edit makes a link `modified`). */
export function linkSignature(docs: Pick<ProjectDocs, 'characters' | 'elements' | 'resources'>): string {
  const linked = (list: (Character | Element | Resource)[]) =>
    list.filter((e) => e.library || ('deskUnit' in e && e.deskUnit));
  return JSON.stringify([
    linked(Object.values(docs.characters)),
    linked(Object.values(docs.elements)),
    linked(Object.values(docs.resources)),
  ]);
}
