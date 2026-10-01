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

/**
 * Consent for media that may show a real person (docs/design/provenance.md#consent-records). Recorded on every
 * uploaded reference and voice sample; never copied into C2PA manifests.
 */
export const ConsentSchema = z.object({
  depictsRealPerson: z.boolean(),
  subject: z.string().trim().min(1).max(200).optional(),
  grantedBy: z.string().trim().min(1).max(200).optional(),
  grantedAt: IsoDateSchema.optional(),
  scope: z.string().max(1000).optional(),
  evidence: z.string().max(1000).optional(),
  recordedBy: ActorSchema,
  recordedAt: IsoDateSchema,
});
export type Consent = z.infer<typeof ConsentSchema>;

/** What a client states when it uploads a likeness or a voice (the server stamps who recorded it and when). */
export const ConsentInputSchema = ConsentSchema.omit({ recordedBy: true, recordedAt: true });
export type ConsentInput = z.infer<typeof ConsentInputSchema>;

/** Missing fields of a consent record that depicts a real person (empty when complete). */
export function missingConsentFields(
  c: Pick<ConsentInput, 'depictsRealPerson' | 'subject' | 'grantedBy' | 'grantedAt'>,
): string[] {
  if (!c.depictsRealPerson) return [];
  return (['subject', 'grantedBy', 'grantedAt'] as const).filter((k) => !c[k]?.trim());
}

export const CharacterReferenceSchema = z.object({
  id: IdSchema,
  view: ReferenceViewSchema,
  media: MediaRefSchema,
  source: z.enum(['generated', 'uploaded']),
  approved: z.boolean(),
  wardrobeId: IdSchema.optional(),
  createdAt: IsoDateSchema,
  consent: ConsentSchema.optional(),
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

/** A character whose approved likeness is a real person: exports with it carry the disclosure label. */
export function isRealPersonCharacter(c: Pick<Character, 'references'>): boolean {
  return c.references.some((r) => r.approved && r.consent?.depictsRealPerson === true);
}

export function defaultWardrobe(c: Character): Wardrobe | undefined {
  return c.wardrobe.find((w) => w.default) ?? c.wardrobe[0];
}

/** Fields that define identity; they are frozen while the character is locked (rule R2). */
export const IDENTITY_FIELDS = ['name', 'identity', 'wardrobe', 'references'] as const;
