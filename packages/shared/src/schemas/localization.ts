import { z } from 'zod';
import { TakeLineSchema } from './clip';
import { IdSchema, IsoDateSchema, MediaRefSchema } from './common';
import { ContentCredentialsStampSchema } from './provenance';

/** BCP 47 language codes as the documents name them: `es`, `pt-BR` (docs/design/localization.md#translation). */
export const LanguageCodeSchema = z
  .string()
  .regex(/^[a-z]{2,3}(-[A-Z]{2})?$/, 'a language code like es or pt-BR');
export type LanguageCode = z.infer<typeof LanguageCodeSchema>;

/** One spoken line of a shot, translated. */
export const TranslatedLineSchema = z.object({
  shotId: IdSchema,
  index: z.number().int().nonnegative(),
  characterId: IdSchema.nullable(),
  /** The line when it was translated: a different line today makes the translation stale. */
  source: z.string().max(2000),
  text: z.string().max(2000),
  /** Changed by a person: kept when translating again. */
  edited: z.boolean().default(false),
});
export type TranslatedLine = z.infer<typeof TranslatedLineSchema>;

/** A take spoken in the language (docs/design/localization.md#dubbing). */
export const DubSchema = z.object({
  takeId: IdSchema,
  shotId: IdSchema,
  clipId: IdSchema,
  /** The dubbed TTS mix. */
  dialogue: MediaRefSchema,
  /** The translated lines with their timings (and words) in the mix. */
  lines: z.array(TakeLineSchema),
  voiceLocks: z.record(z.string(), z.number().int().nonnegative()).default({}),
  /** The close-up re-rendered to follow the dubbed line (lip sync), watermarked and signed. */
  video: MediaRefSchema.nullable().default(null),
  watermarkId: z.string().nullable().default(null),
  contentCredentials: ContentCredentialsStampSchema.nullable().default(null),
  createdAt: IsoDateSchema,
});
export type Dub = z.infer<typeof DubSchema>;

export const LocalizationSchema = z.object({
  /** The language code (the document is `localizations/<id>.json`). */
  id: LanguageCodeSchema,
  name: z.string().min(1).max(100),
  lines: z.array(TranslatedLineSchema).max(10_000).default([]),
  dubs: z.record(IdSchema, DubSchema).default({}),
  createdAt: IsoDateSchema,
  updatedAt: IsoDateSchema,
});
export type Localization = z.infer<typeof LocalizationSchema>;
