import { z } from 'zod';
import { IsoDateSchema, type MediaRef, MediaRefSchema } from '../schemas/common';
import { AuthorSchema } from '../schemas/review';

/** Brand kit schemas (docs/design/brand-kits.md); no runtime dependency on the timeline. */

export const HexColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/);

/** A file of a kit, kept in the kit's folder on the storage backend. */
export const BrandAssetSchema = z.object({
  name: z.string().min(1).max(200),
  file: z
    .string()
    .regex(/^[a-z0-9][a-z0-9._-]{0,199}$/)
    .refine((f) => !f.includes('..'), 'invalid file name'),
  hash: z.string().regex(/^[0-9a-f]{64}$/),
  mime: z.string().min(3).max(100),
  size: z.number().int().nonnegative(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  durationSec: z.number().nonnegative().optional(),
  hasAudio: z.boolean().optional(),
});
export type BrandAsset = z.infer<typeof BrandAssetSchema>;

export const BrandColorsSchema = z.object({
  text: HexColorSchema.default('#FFFFFF'),
  accent: HexColorSchema.default('#FF6B3D'),
  box: HexColorSchema.default('#000000'),
  boxOpacity: z.number().min(0).max(1).default(0.45),
});
export type BrandColors = z.infer<typeof BrandColorsSchema>;

export const BrandBugSchema = z.object({
  enabled: z.boolean().default(false),
  corner: z.enum(['top_left', 'top_right', 'bottom_left', 'bottom_right']).default('bottom_right'),
  /** Width as a fraction of the frame's width. */
  size: z.number().min(0.04).max(0.3).default(0.1),
  opacity: z.number().min(0.1).max(1).default(0.8),
  /** Distance from the edges as a fraction of the frame's width. */
  margin: z.number().min(0).max(0.2).default(0.03),
});
export type BrandBug = z.infer<typeof BrandBugSchema>;

export const LowerThirdTemplateSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,39}$/),
  name: z.string().min(1).max(80),
  position: z.enum(['left', 'center', 'right']).default('left'),
  size: z.number().int().min(8).max(200).optional(),
  font: z.enum(['title', 'body']).default('body'),
  color: z.enum(['text', 'accent']).default('text'),
  box: z.boolean().default(true),
});
export type LowerThirdTemplate = z.infer<typeof LowerThirdTemplateSchema>;

const DEFAULT_LOWER_THIRD: LowerThirdTemplate = {
  id: 'name-role',
  name: 'Name and role',
  position: 'left',
  font: 'body',
  color: 'text',
  box: true,
};

export const BrandKitInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  colors: BrandColorsSchema.partial().optional(),
  bug: BrandBugSchema.partial().optional(),
  lowerThirds: z.array(LowerThirdTemplateSchema).max(20).optional(),
  intro: z
    .object({ durationSec: z.number().min(0.5).max(30) })
    .partial()
    .optional(),
  outro: z
    .object({ durationSec: z.number().min(0.5).max(30) })
    .partial()
    .optional(),
});
export type BrandKitInput = z.infer<typeof BrandKitInputSchema>;

const BumperSchema = z.object({ asset: BrandAssetSchema, durationSec: z.number().min(0.5).max(30) });

export const BrandKitSchema = z.object({
  id: z.string().regex(/^bkt_[0-9a-z]{10,32}$/),
  name: z.string().min(1).max(120),
  colors: BrandColorsSchema.default(BrandColorsSchema.parse({})),
  fonts: z
    .object({
      title: BrandAssetSchema.nullable().default(null),
      body: BrandAssetSchema.nullable().default(null),
    })
    .default({ title: null, body: null }),
  logo: BrandAssetSchema.nullable().default(null),
  bug: BrandBugSchema.default(BrandBugSchema.parse({})),
  intro: BumperSchema.nullable().default(null),
  outro: BumperSchema.nullable().default(null),
  lowerThirds: z.array(LowerThirdTemplateSchema).max(20).default([DEFAULT_LOWER_THIRD]),
  createdBy: AuthorSchema,
  createdAt: IsoDateSchema,
  updatedAt: IsoDateSchema,
});
export type BrandKit = z.infer<typeof BrandKitSchema>;

/** The slots of a kit that hold a file. */
export const BRAND_SLOTS = ['title_font', 'body_font', 'logo', 'intro', 'outro'] as const;
export type BrandSlot = (typeof BRAND_SLOTS)[number];

/** A font family name for a font file (drawtext needs none; the compositor names its FontFace). */
export const fontFamily = (media: Pick<MediaRef, 'hash'>) => `Brand ${media.hash.slice(0, 12)}`;

/** The brand a project applied: the kit resolved onto the project's own media (`project.settings.brand`). */
export const ProjectBrandSchema = z.object({
  kitId: z.string().regex(/^bkt_[0-9a-z]{10,32}$/),
  name: z.string().min(1).max(120),
  colors: BrandColorsSchema,
  fonts: z.object({ title: MediaRefSchema.nullable(), body: MediaRefSchema.nullable() }),
  logo: MediaRefSchema.nullable(),
  bug: BrandBugSchema,
  intro: z.object({ media: MediaRefSchema, durationSec: z.number().min(0.5).max(30) }).nullable(),
  outro: z.object({ media: MediaRefSchema, durationSec: z.number().min(0.5).max(30) }).nullable(),
  lowerThirds: z.array(LowerThirdTemplateSchema).max(20),
  appliedAt: IsoDateSchema,
});
export type ProjectBrand = z.infer<typeof ProjectBrandSchema>;
