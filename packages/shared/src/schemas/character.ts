import { z } from 'zod';
import { ActorSchema, IdSchema, IsoDateSchema, MediaRefSchema } from './common';

export const CharacterRoleSchema = z.enum(['protagonist', 'antagonist', 'supporting', 'minor']);

export const IdentitySchema = z.object({
  age: z.string().max(100).default(''),
  gender: z.string().max(100).default(''),
  ethnicity: z.string().max(200).optional(),
  build: z.string().max(200).default(''),
  height: z.string().max(100).optional(),
  face: z.string().max(1000).default(''),
  hair: z.string().max(500).default(''),
  eyes: z.string().max(300).default(''),
  skin: z.string().max(300).default(''),
  distinguishingMarks: z.string().max(1000).optional(),
});
export type Identity = z.infer<typeof IdentitySchema>;

export const WardrobeSchema = z.object({
  id: IdSchema,
  name: z.string().min(1).max(120),
  description: z.string().max(1000),
  default: z.boolean().optional(),
});
export type Wardrobe = z.infer<typeof WardrobeSchema>;

export const ReferenceViewSchema = z.enum([
  'front',
  'three_quarter',
  'profile',
  'full_body',
  'expression',
  'custom',
]);
export type ReferenceView = z.infer<typeof ReferenceViewSchema>;

export const REFERENCE_VIEW_PRIORITY: ReferenceView[] = [
  'front',
  'three_quarter',
  'full_body',
  'profile',
  'expression',
  'custom',
];

export const CharacterReferenceSchema = z.object({
  id: IdSchema,
  view: ReferenceViewSchema,
  media: MediaRefSchema,
  source: z.enum(['generated', 'uploaded']),
  approved: z.boolean(),
  wardrobeId: IdSchema.optional(),
  createdAt: IsoDateSchema,
});
export type CharacterReference = z.infer<typeof CharacterReferenceSchema>;

export const CharacterLockSchema = z.object({
  locked: z.boolean(),
  version: z.number().int().nonnegative(),
  lockedAt: IsoDateSchema.optional(),
  lockedBy: ActorSchema.optional(),
  identityHash: z.string().optional(),
});

export const CharacterSchema = z.object({
  id: IdSchema,
  name: z.string().min(1).max(120),
  role: CharacterRoleSchema.default('supporting'),
  summary: z.string().max(4000).default(''),
  identity: IdentitySchema,
  wardrobe: z.array(WardrobeSchema).default([]),
  personality: z.string().max(2000).optional(),
  voice: z.object({ description: z.string().max(1000) }).optional(),
  references: z.array(CharacterReferenceSchema).default([]),
  seed: z.number().int().nonnegative().max(0xffffffff),
  lock: CharacterLockSchema,
});
export type Character = z.infer<typeof CharacterSchema>;

export function approvedReferences(c: Character): CharacterReference[] {
  return c.references.filter((r) => r.approved);
}

export function defaultWardrobe(c: Character): Wardrobe | undefined {
  return c.wardrobe.find((w) => w.default) ?? c.wardrobe[0];
}

/** Fields that define identity; they are frozen while the character is locked (rule R2). */
export const IDENTITY_FIELDS = ['name', 'identity', 'wardrobe', 'references'] as const;
