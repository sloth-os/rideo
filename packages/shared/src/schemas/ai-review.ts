import { z } from 'zod';
import { ActorSchema, IdSchema, IsoDateSchema } from './common';
import { FeedbackFramingSchema, FeedbackMovementSchema } from './feedback';

/** The stages an AI review gates (docs/design/ai-review.md). */
export const REVIEW_STAGES = ['screenplay', 'storyboard'] as const;
export const ReviewStageSchema = z.enum(REVIEW_STAGES);
export type ReviewStage = z.infer<typeof ReviewStageSchema>;

/** What each stage's reviewer scores (docs/design/ai-review.md#dimensions). */
export const REVIEW_DIMENSIONS = {
  screenplay: ['story', 'character', 'dialogue', 'pacing', 'visual', 'continuity', 'feasibility', 'brief'],
  storyboard: ['composition', 'continuity', 'character', 'coverage', 'storytelling', 'feasibility', 'pacing'],
} as const satisfies Record<ReviewStage, readonly string[]>;
export type ReviewDimension = (typeof REVIEW_DIMENSIONS)[ReviewStage][number];
const ALL_DIMENSIONS = [...new Set(Object.values(REVIEW_DIMENSIONS).flat())] as [string, ...string[]];
export const ReviewDimensionSchema = z.enum(ALL_DIMENSIONS);

/** `settings.review` (docs/design/ai-review.md#the-gates). */
export const ReviewSettingsSchema = z.object({
  screenplay: z.boolean().default(true),
  storyboard: z.boolean().default(true),
  /** The lowest overall score (0–10) that passes. */
  threshold: z.number().min(5).max(9.5).default(7),
  /** Automatic revisions before a person decides. */
  maxRounds: z.number().int().min(0).max(3).default(2),
  /** Apply the review's fixes and review again. */
  autoRevise: z.boolean().default(true),
  /** Watch each scene's takes before the edit (docs/design/ai-review.md#scenes-before-the-edit). */
  scenes: z.boolean().default(true),
  /** Priority 1 regenerations a scene review applies (0: it only watches). */
  sceneFixes: z.number().int().min(0).max(6).default(3),
});
export type ReviewSettings = z.infer<typeof ReviewSettingsSchema>;
export const DEFAULT_REVIEW_SETTINGS: ReviewSettings = ReviewSettingsSchema.parse({});

export const StageActionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('revise_scene'), sceneId: IdSchema, instruction: z.string().min(1).max(2000) }),
  z.object({ kind: z.literal('revise_outline'), instruction: z.string().min(1).max(2000) }),
  z.object({
    kind: z.literal('redraw_board'),
    clipId: IdSchema,
    shotId: IdSchema,
    description: z.string().max(4000).optional(),
    action: z.string().max(4000).optional(),
    framing: FeedbackFramingSchema.optional(),
    movement: FeedbackMovementSchema.optional(),
    /** Who is in frame after the change, by name. */
    characters: z.array(z.string().min(1).max(100)).max(10).optional(),
    durationSec: z.number().min(1).max(60).optional(),
  }),
  z.object({ kind: z.literal('replan_scene'), clipId: IdSchema, direction: z.string().min(1).max(2000) }),
  z.object({ kind: z.literal('note') }),
]);
export type StageAction = z.infer<typeof StageActionSchema>;

export const StageIssueSchema = z.object({
  id: z.string().max(20),
  dimension: ReviewDimensionSchema,
  severity: z.enum(['critical', 'major', 'minor']),
  title: z.string().min(1).max(200),
  detail: z.string().max(3000).default(''),
  /** The scene it is about (screenplay: by id and 1-based number). */
  sceneId: IdSchema.optional(),
  scene: z.number().int().positive().optional(),
  /** The shot it is about (storyboard). */
  clipId: IdSchema.optional(),
  shotId: IdSchema.optional(),
  /** "C2·S3" */
  shot: z.string().max(20).optional(),
});
export type StageIssue = z.infer<typeof StageIssueSchema>;

export const StageRecommendationSchema = z.object({
  id: z.string().max(20),
  priority: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  dimension: ReviewDimensionSchema,
  title: z.string().min(1).max(200),
  detail: z.string().max(3000).default(''),
  issueIds: z.array(z.string().max(20)).max(50).default([]),
  action: StageActionSchema.nullable().default(null),
  status: z.enum(['open', 'applied', 'dismissed']).default('open'),
  /** The round that raised it; the fixes of earlier rounds stay listed, applied. */
  round: z.number().int().min(1).optional(),
  /** Applied by the review's own round (the system) or by a person. */
  appliedBy: ActorSchema.optional(),
  appliedAt: IsoDateSchema.optional(),
  jobId: IdSchema.optional(),
});
export type StageRecommendation = z.infer<typeof StageRecommendationSchema>;

export const StageVerdictSchema = z.object({
  passed: z.boolean(),
  score: z.number().min(0).max(10),
  /** What failed: critical issues, low dimensions, the score under the threshold. */
  blocking: z.array(z.string().max(300)).max(30).default([]),
});
export type StageVerdict = z.infer<typeof StageVerdictSchema>;

/** One stage's AI review, `ai-reviews/<stage>.json` (docs/design/ai-review.md#the-document). */
export const StageReviewSchema = z.object({
  stage: ReviewStageSchema,
  status: z.enum(['running', 'succeeded', 'failed']),
  jobId: IdSchema.nullable().default(null),
  model: z.string().max(200).nullable().default(null),
  /** Hash of what was reviewed; the review is current while the documents hash the same. */
  subject: z.string().max(40).default(''),
  round: z.number().int().min(0).default(0),
  threshold: z.number().min(0).max(10).default(7),
  verdict: StageVerdictSchema.nullable().default(null),
  scores: z.record(z.string(), z.number().min(0).max(10).nullable()).default({}),
  summary: z.string().max(4000).default(''),
  strengths: z.array(z.string().max(400)).max(20).default([]),
  issues: z.array(StageIssueSchema).max(200).default([]),
  recommendations: z.array(StageRecommendationSchema).max(100).default([]),
  history: z
    .array(
      z.object({
        round: z.number().int().min(1),
        at: IsoDateSchema,
        score: z.number().min(0).max(10),
        passed: z.boolean(),
        issues: z.number().int().nonnegative(),
        applied: z.number().int().nonnegative(),
      }),
    )
    .max(20)
    .default([]),
  /** "Continue anyway": a person accepts the review for the subject it was made of. */
  override: z
    .object({
      by: ActorSchema,
      at: IsoDateSchema,
      note: z.string().max(1000).default(''),
      subject: z.string().max(40),
    })
    .nullable()
    .default(null),
  error: z.string().max(2000).optional(),
  createdAt: IsoDateSchema,
  updatedAt: IsoDateSchema,
});
export type StageReview = z.infer<typeof StageReviewSchema>;
