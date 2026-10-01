import { z } from 'zod';
import { ActorSchema, IdSchema, IsoDateSchema, MediaRefSchema } from './common';
import { ContentCredentialsStampSchema } from './provenance';

export const ConsistencyStatusSchema = z.enum(['passed', 'failed', 'unverified']);
export type ConsistencyStatus = z.infer<typeof ConsistencyStatusSchema>;

export const CharacterVerdictSchema = z.object({
  characterId: IdSchema,
  present: z.boolean(),
  score: z.number().min(0).max(1),
  issues: z.array(z.string().max(500)).default([]),
});
export type CharacterVerdict = z.infer<typeof CharacterVerdictSchema>;

export const ElementVerdictSchema = z.object({
  elementId: IdSchema,
  present: z.boolean(),
  score: z.number().min(0).max(1),
  issues: z.array(z.string().max(500)).default([]),
});
export type ElementVerdict = z.infer<typeof ElementVerdictSchema>;

export const ConsistencyReportSchema = z.object({
  status: ConsistencyStatusSchema,
  judge: z.string(),
  threshold: z.number().min(0).max(1),
  score: z.number().min(0).max(1),
  attempts: z.number().int().nonnegative(),
  checkedAt: IsoDateSchema,
  characters: z.array(CharacterVerdictSchema).default([]),
  /** Locations and props, when the project judges elements (rule E4, docs/design/elements.md). */
  elements: z.array(ElementVerdictSchema).default([]),
  frames: z.array(MediaRefSchema).default([]),
  note: z.string().max(1000).optional(),
});
export type ConsistencyReport = z.infer<typeof ConsistencyReportSchema>;

export const CameraSchema = z.object({
  framing: z
    .enum([
      'extreme_wide',
      'wide',
      'medium',
      'medium_close',
      'close_up',
      'extreme_close_up',
      'over_shoulder',
      'pov',
      'insert',
    ])
    .default('medium'),
  movement: z
    .enum([
      'static',
      'pan',
      'tilt',
      'dolly_in',
      'dolly_out',
      'tracking',
      'handheld',
      'crane',
      'zoom',
      'orbit',
    ])
    .default('static'),
});
export type Camera = z.infer<typeof CameraSchema>;

export const TakeSchema = z.object({
  id: IdSchema,
  createdAt: IsoDateSchema,
  jobId: IdSchema.optional(),
  keyframe: MediaRefSchema.nullable().default(null),
  video: MediaRefSchema.nullable().default(null),
  lastFrame: MediaRefSchema.nullable().default(null),
  request: z.object({
    imageModel: z.string().optional(),
    videoModel: z.string().optional(),
    prompt: z.string().max(20000),
    seed: z.number().int(),
    durationSec: z.number().positive(),
    firstFrameSource: z.enum(['keyframe', 'previous_shot', 'none']),
    referenceCount: z.number().int().nonnegative(),
  }),
  gatewayTaskIds: z.array(z.string()).default([]),
  consistency: ConsistencyReportSchema,
  characterLocks: z.record(z.string(), z.number().int().nonnegative()).default({}),
  /** Lock versions of the shot's elements at generation time (rule E6). */
  elementLocks: z.record(z.string(), z.number().int().nonnegative()).default({}),
  watermarkId: z.string().nullable().default(null),
  /** C2PA manifest embedded in the take's video (docs/design/provenance.md#takes). */
  contentCredentials: ContentCredentialsStampSchema.nullable().default(null),
  override: z
    .object({ actor: ActorSchema, reason: z.string().min(3).max(1000), at: IsoDateSchema })
    .nullable()
    .default(null),
  durationSec: z.number().nonnegative().optional(),
  error: z.string().max(2000).optional(),
});
export type Take = z.infer<typeof TakeSchema>;

export const ShotStatusSchema = z.enum([
  'planned',
  'queued',
  'generating',
  'ready',
  'needs_review',
  'failed',
]);
export type ShotStatus = z.infer<typeof ShotStatusSchema>;

export const ShotSchema = z.object({
  id: IdSchema,
  index: z.number().int().nonnegative(),
  description: z.string().max(4000),
  action: z.string().max(4000).default(''),
  camera: CameraSchema.default({ framing: 'medium', movement: 'static' }),
  characterIds: z.array(IdSchema).default([]),
  /** The location and the props/styles in the shot (docs/design/elements.md). */
  elementIds: z.array(IdSchema).default([]),
  wardrobe: z.record(z.string(), IdSchema).default({}),
  dialogue: z.array(z.object({ characterId: IdSchema.nullable(), line: z.string().max(2000) })).default([]),
  durationSec: z.number().positive().max(60),
  continuity: z.enum(['cut', 'continuous']).default('cut'),
  promptOverride: z.string().max(8000).nullable().default(null),
  negativePrompt: z.string().max(2000).nullable().default(null),
  status: ShotStatusSchema.default('planned'),
  takes: z.array(TakeSchema).default([]),
  selectedTakeId: IdSchema.nullable().default(null),
  lastError: z.string().max(2000).nullable().default(null),
});
export type Shot = z.infer<typeof ShotSchema>;

export const ClipStatusSchema = z.enum(['planned', 'generating', 'review', 'approved']);
export type ClipStatus = z.infer<typeof ClipStatusSchema>;

export const ClipSchema = z.object({
  id: IdSchema,
  index: z.number().int().nonnegative(),
  sceneId: IdSchema.nullable(),
  title: z.string().max(300),
  status: ClipStatusSchema.default('planned'),
  shots: z.array(ShotSchema).default([]),
  approvedAt: IsoDateSchema.nullable().default(null),
  approvedBy: ActorSchema.nullable().default(null),
  notes: z.string().max(4000).default(''),
});
export type Clip = z.infer<typeof ClipSchema>;

export function clipPlannedDuration(clip: Pick<Clip, 'shots'>): number {
  return clip.shots.reduce((sum, s) => sum + s.durationSec, 0);
}

export function selectedTake(shot: Shot): Take | undefined {
  return shot.takes.find((t) => t.id === shot.selectedTakeId);
}
