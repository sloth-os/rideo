import { z } from 'zod';
import { IdSchema, IsoDateSchema, MediaRefSchema, TimeRangeSchema } from './common';

export const TransitionTypeSchema = z.enum(['crossfade', 'wipe', 'dip_to_black']);
export type TransitionType = z.infer<typeof TransitionTypeSchema>;

const Range = z.object({ start: z.number().nonnegative(), end: z.number().nonnegative() });

export const SuggestionParamsSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('cut'), start: z.number().nonnegative(), end: z.number().nonnegative() }),
  z.object({
    kind: z.literal('tighten_silence'),
    start: z.number().nonnegative(),
    end: z.number().nonnegative(),
    keepSec: z.number().nonnegative().max(5).default(0.4),
  }),
  z.object({
    kind: z.literal('highlight'),
    segments: z.array(Range).min(1),
    targetDurationSec: z.number().positive().optional(),
  }),
  z.object({
    kind: z.literal('transition'),
    at: z.number().nonnegative(),
    type: TransitionTypeSchema,
    duration: z.number().positive().max(3),
  }),
  z.object({
    kind: z.literal('title'),
    text: z.string().min(1).max(200),
    start: z.number().nonnegative(),
    duration: z.number().positive().max(30),
  }),
  z.object({
    kind: z.literal('caption'),
    start: z.number().nonnegative(),
    end: z.number().nonnegative(),
    text: z.string().min(1).max(500),
  }),
  z.object({
    kind: z.literal('speed'),
    start: z.number().nonnegative(),
    end: z.number().nonnegative(),
    factor: z.number().min(0.25).max(4),
  }),
  z.object({
    kind: z.literal('music'),
    resourceId: IdSchema.optional(),
    prompt: z.string().max(1000).optional(),
    volume: z.number().min(0).max(2).default(0.3),
  }),
  z.object({
    kind: z.literal('fade'),
    in: z.number().nonnegative().max(10).optional(),
    out: z.number().nonnegative().max(10).optional(),
  }),
  z.object({
    kind: z.literal('color'),
    brightness: z.number().min(-1).max(1).optional(),
    contrast: z.number().min(0).max(2).optional(),
    saturation: z.number().min(0).max(3).optional(),
  }),
]);
export type SuggestionParams = z.infer<typeof SuggestionParamsSchema>;
export type SuggestionKind = SuggestionParams['kind'];

export const EditSuggestionSchema = z.object({
  id: IdSchema,
  source: z.enum(['rules', 'ai']),
  description: z.string().max(1000),
  rationale: z.string().max(2000).default(''),
  confidence: z.number().min(0).max(1).default(0.5),
  params: SuggestionParamsSchema,
  status: z.enum(['pending', 'accepted', 'rejected']).default('pending'),
});
export type EditSuggestion = z.infer<typeof EditSuggestionSchema>;

export const AnalysisSchema = z.object({
  id: IdSchema,
  resourceId: IdSchema,
  status: z.enum(['running', 'completed', 'failed']),
  createdAt: IsoDateSchema,
  completedAt: IsoDateSchema.nullable().default(null),
  probe: z
    .object({
      durationSec: z.number().nonnegative(),
      width: z.number().int().nonnegative(),
      height: z.number().int().nonnegative(),
      fps: z.number().nonnegative(),
      hasAudio: z.boolean(),
    })
    .nullable()
    .default(null),
  scenes: z.array(TimeRangeSchema.extend({ thumbnail: MediaRefSchema.optional() })).default([]),
  silences: z.array(TimeRangeSchema).default([]),
  blackSegments: z.array(TimeRangeSchema).default([]),
  loudness: z.object({ integratedLufs: z.number() }).nullable().default(null),
  transcript: z.array(TimeRangeSchema.extend({ text: z.string() })).default([]),
  summary: z.string().max(8000).default(''),
  suggestions: z.array(EditSuggestionSchema).default([]),
  error: z.string().max(2000).optional(),
});
export type Analysis = z.infer<typeof AnalysisSchema>;
