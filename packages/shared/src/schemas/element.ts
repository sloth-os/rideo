import { z } from 'zod';
import { CharacterLockSchema } from './character';
import { IdSchema, IsoDateSchema, MediaRefSchema } from './common';

/** Locations, props and styles kept consistent like characters (docs/design/elements.md). */
export const ElementKindSchema = z.enum(['location', 'prop', 'style']);
export type ElementKind = z.infer<typeof ElementKindSchema>;

export const ElementReferenceViewSchema = z.enum(['establishing', 'angle', 'detail', 'custom']);
export type ElementReferenceView = z.infer<typeof ElementReferenceViewSchema>;

/** Views generated per kind, in order (the first approved one is the image input of the next). */
export const ELEMENT_VIEWS: Record<ElementKind, ElementReferenceView[]> = {
  location: ['establishing', 'angle'],
  prop: ['detail', 'angle'],
  style: ['custom'],
};

/** Reference priority when the image budget allows one reference per element. */
export const ELEMENT_VIEW_PRIORITY: ElementReferenceView[] = ['establishing', 'detail', 'angle', 'custom'];

export const ElementReferenceSchema = z.object({
  id: IdSchema,
  view: ElementReferenceViewSchema,
  media: MediaRefSchema,
  source: z.enum(['generated', 'uploaded']),
  approved: z.boolean(),
  createdAt: IsoDateSchema,
});
export type ElementReference = z.infer<typeof ElementReferenceSchema>;

export const ElementSchema = z.object({
  id: IdSchema,
  kind: ElementKindSchema,
  name: z.string().trim().min(1).max(120),
  /** The anchor text: what it looks like (in prompts as written). */
  description: z.string().max(2000).default(''),
  /** Other names the screenplay uses for it (matched case-insensitively). */
  aliases: z.array(z.string().trim().min(1).max(120)).max(20).default([]),
  references: z.array(ElementReferenceSchema).default([]),
  seed: z.number().int().nonnegative().max(0xffffffff),
  lock: CharacterLockSchema,
});
export type Element = z.infer<typeof ElementSchema>;

export function approvedElementReferences(e: Pick<Element, 'references'>): ElementReference[] {
  return e.references.filter((r) => r.approved);
}

/** Fields frozen while an element is locked (rule E2). */
export const ELEMENT_IDENTITY_FIELDS = ['name', 'description', 'references'] as const;

/** Case-insensitive name/alias → element id (ambiguous names resolve to none). */
export function elementIndex(elements: Pick<Element, 'id' | 'name' | 'aliases' | 'kind'>[]) {
  const map = new Map<string, string | null>();
  for (const e of elements) {
    for (const n of [e.name, ...e.aliases]) {
      const key = `${e.kind}:${n.trim().toLowerCase()}`;
      map.set(key, map.has(key) && map.get(key) !== e.id ? null : e.id);
    }
  }
  return (kind: ElementKind, name: string): string | null =>
    map.get(`${kind}:${name.trim().toLowerCase()}`) ?? null;
}
