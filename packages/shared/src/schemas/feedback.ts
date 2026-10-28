import { z } from 'zod';
import { ID_PREFIXES } from '../ids';
import { ActorSchema, IdSchema, IsoDateSchema, MediaRefSchema, TimeRangeSchema } from './common';

/**
 * Feedback on the finished film (docs/design/feedback.md): the vision model's scores, issues pinned to shots and
 * recommendations with actions, the signals measured on the export and the retrospective of the run.
 */
export const FEEDBACK_DIMENSIONS = [
  {
    id: 'storytelling',
    label: 'Storytelling',
    weight: 2,
    vision: true,
    help: 'setup, goals, conflict, turns and payoff; scenes that follow from each other; dialogue that moves the story',
  },
  {
    id: 'continuity',
    label: 'Continuity',
    weight: 1.5,
    vision: true,
    help: 'across cuts: time of day, light direction, weather, wardrobe, props, positions and screen direction match',
  },
  {
    id: 'character',
    label: 'Characters',
    weight: 1.5,
    vision: true,
    help: 'the same faces, bodies and outfits all film long',
  },
  {
    id: 'temporal',
    label: 'Temporal consistency',
    weight: 1,
    vision: true,
    help: 'inside shots: no morphing, flicker, popping or stray cuts; smooth motion',
  },
  {
    id: 'physics',
    label: 'Physics',
    weight: 1,
    vision: true,
    help: 'weight, gravity, momentum, contact with the ground, anatomy, objects keeping their shape and number',
  },
  {
    id: 'realism',
    label: 'Sense of reality',
    weight: 1,
    vision: true,
    help: 'believable light, materials, scale and depth; a camera that behaves like a camera; no AI artefacts',
  },
  {
    id: 'cinematography',
    label: 'Cinematography',
    weight: 1,
    vision: true,
    help: 'framing, composition, coverage, lens choice, camera movement',
  },
  {
    id: 'editing',
    label: 'Editing and pacing',
    weight: 1,
    vision: true,
    help: 'shot lengths, rhythm, cut points, transitions, no repetition',
  },
  {
    id: 'dialogue',
    label: 'Dialogue and voices',
    weight: 1,
    vision: false,
    heard: true,
    help: 'every line spoken as written, clear for the film’s level, in its character’s voice, lips in sync, nothing said that the script does not say',
  },
  {
    id: 'sound',
    label: 'Sound',
    weight: 0.5,
    vision: false,
    heard: true,
    help: 'loudness on target, no long silences or clipping, ambience that fits the place, no stray music or noise, lines that fit their shots',
  },
] as const;

export type FeedbackDimension = (typeof FEEDBACK_DIMENSIONS)[number]['id'];
export const FEEDBACK_DIMENSION_IDS = FEEDBACK_DIMENSIONS.map((d) => d.id) as [
  FeedbackDimension,
  ...FeedbackDimension[],
];
/** The dimensions the vision model scores (`sound` is measured, `dialogue` needs listening). */
export const VISION_DIMENSION_IDS = FEEDBACK_DIMENSIONS.filter((d) => d.vision).map((d) => d.id) as [
  FeedbackDimension,
  ...FeedbackDimension[],
];
/** The dimensions the audio-visual model scores: the picture's and what it hears (docs/design/feedback.md#dimensions). */
export const HEARD_DIMENSION_IDS = FEEDBACK_DIMENSIONS.filter((d) => d.vision || 'heard' in d).map(
  (d) => d.id,
) as [FeedbackDimension, ...FeedbackDimension[]];
export const FeedbackDimensionSchema = z.enum(FEEDBACK_DIMENSION_IDS);

const score = z.number().min(0).max(10).nullable().default(null);
export const FeedbackScoresSchema = z.object({
  storytelling: score,
  continuity: score,
  character: score,
  temporal: score,
  physics: score,
  realism: score,
  cinematography: score,
  editing: score,
  dialogue: score,
  sound: score,
});
export type FeedbackScores = z.infer<typeof FeedbackScoresSchema>;

export function emptyScores(): FeedbackScores {
  return FeedbackScoresSchema.parse({});
}

export const FeedbackSeveritySchema = z.enum(['critical', 'major', 'minor']);
export type FeedbackSeverity = z.infer<typeof FeedbackSeveritySchema>;

export const FeedbackIssueSchema = z.object({
  id: z.string().max(20),
  dimension: FeedbackDimensionSchema,
  severity: FeedbackSeveritySchema,
  title: z.string().min(1).max(200),
  detail: z.string().max(2000).default(''),
  /** Seconds of the export. */
  start: z.number().nonnegative(),
  end: z.number().nonnegative(),
  clipId: IdSchema.nullable().default(null),
  shotId: IdSchema.nullable().default(null),
  /** "C3·S2" */
  shot: z.string().max(20).nullable().default(null),
  source: z.enum(['vision', 'signal']),
});
export type FeedbackIssue = z.infer<typeof FeedbackIssueSchema>;

/**
 * Settings a recommendation may change, each a project setting path (docs/design/feedback.md#actions): a fixed table,
 * never an arbitrary patch from a model.
 */
export const FEEDBACK_SETTINGS = {
  qualityChecks: { path: ['consistency', 'qualityChecks'], schema: z.boolean() },
  threshold: { path: ['consistency', 'threshold'], schema: z.number().min(0.5).max(0.95) },
  maxAttempts: { path: ['consistency', 'maxAttempts'], schema: z.number().int().min(1).max(6) },
  judgeElements: { path: ['consistency', 'judgeElements'], schema: z.boolean() },
  storyboard: { path: ['storyboard', 'enabled'], schema: z.boolean() },
  promptVersion: { path: ['generation', 'promptVersion'], schema: z.literal(2) },
  castOnly: { path: ['consistency', 'castOnly'], schema: z.boolean() },
} as const;
export type FeedbackSettingKey = keyof typeof FEEDBACK_SETTINGS;
export const FeedbackSettingsPatchSchema = z
  .object({
    qualityChecks: FEEDBACK_SETTINGS.qualityChecks.schema.optional(),
    threshold: FEEDBACK_SETTINGS.threshold.schema.optional(),
    maxAttempts: FEEDBACK_SETTINGS.maxAttempts.schema.optional(),
    judgeElements: FEEDBACK_SETTINGS.judgeElements.schema.optional(),
    storyboard: FEEDBACK_SETTINGS.storyboard.schema.optional(),
    promptVersion: FEEDBACK_SETTINGS.promptVersion.schema.optional(),
    castOnly: FEEDBACK_SETTINGS.castOnly.schema.optional(),
  })
  .strict();
export type FeedbackSettingsPatch = z.infer<typeof FeedbackSettingsPatchSchema>;

const FRAMINGS = [
  'extreme_wide',
  'wide',
  'medium',
  'medium_close',
  'close_up',
  'extreme_close_up',
  'over_shoulder',
  'pov',
  'insert',
] as const;
const MOVEMENTS = [
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
] as const;
export const FeedbackFramingSchema = z.enum(FRAMINGS);
export const FeedbackMovementSchema = z.enum(MOVEMENTS);

export const FeedbackActionSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('regenerate_shot'),
    clipId: IdSchema,
    shotId: IdSchema,
    description: z.string().max(4000).optional(),
    action: z.string().max(4000).optional(),
    negativePrompt: z.string().max(2000).optional(),
    framing: FeedbackFramingSchema.optional(),
    movement: FeedbackMovementSchema.optional(),
    /** Who is in frame after the change, by name (docs/design/feedback.md#actions). */
    characters: z.array(z.string().min(1).max(100)).max(10).optional(),
  }),
  z.object({ kind: z.literal('replan_scene'), clipId: IdSchema, direction: z.string().max(2000).optional() }),
  z.object({ kind: z.literal('settings'), patch: FeedbackSettingsPatchSchema }),
  z.object({ kind: z.literal('note') }),
]);
export type FeedbackAction = z.infer<typeof FeedbackActionSchema>;

export const FeedbackRecommendationSchema = z.object({
  id: z.string().max(20),
  priority: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  dimension: FeedbackDimensionSchema,
  title: z.string().min(1).max(200),
  detail: z.string().max(3000).default(''),
  issueIds: z.array(z.string().max(20)).max(50).default([]),
  action: FeedbackActionSchema.nullable().default(null),
  status: z.enum(['open', 'applied', 'dismissed']).default('open'),
  appliedAt: IsoDateSchema.optional(),
  appliedBy: ActorSchema.optional(),
  jobId: IdSchema.optional(),
  /** What applying it is expected to cost, at the prices when the feedback was written (docs/design/feedback.md#what-a-fix-costs). */
  estimate: z
    .object({
      usd: z.number().nonnegative().nullable(),
      videoSeconds: z.number().nonnegative(),
      attempts: z.number().positive(),
    })
    .optional(),
});
export type FeedbackRecommendation = z.infer<typeof FeedbackRecommendationSchema>;
export type FeedbackEstimate = NonNullable<FeedbackRecommendation['estimate']>;

export const RetrospectiveAreaSchema = z.enum(['quality', 'cost', 'performance', 'reliability', 'ux']);
export type RetrospectiveArea = z.infer<typeof RetrospectiveAreaSchema>;
export const RetrospectiveItemSchema = z.object({
  area: RetrospectiveAreaSchema,
  title: z.string().min(1).max(200),
  detail: z.string().max(2000).default(''),
  source: z.enum(['rule', 'vision']),
  rule: z.string().max(60).optional(),
});
export type RetrospectiveItem = z.infer<typeof RetrospectiveItemSchema>;

/** What step 1 measures (docs/design/feedback.md#how-a-film-is-watched). */
export const FeedbackSignalsSchema = z.object({
  durationSec: z.number().nonnegative().default(0),
  targetDurationSec: z.number().nonnegative().nullable().default(null),
  black: z.array(TimeRangeSchema).max(200).default([]),
  frozen: z.array(TimeRangeSchema).max(200).default([]),
  silences: z.array(TimeRangeSchema).max(200).default([]),
  /** Scene changes away from every cut of the render timeline: jumps inside shots. */
  unexpectedCuts: z
    .array(z.object({ at: z.number().nonnegative(), score: z.number().min(0) }))
    .max(500)
    .default([]),
  loudness: z
    .object({
      target: z.string().max(20),
      integratedLufs: z.number().nullable(),
      truePeakDb: z.number().nullable(),
    })
    .nullable()
    .default(null),
  shots: z
    .object({
      count: z.number().int().nonnegative(),
      meanSec: z.number().nonnegative(),
      minSec: z.number().nonnegative(),
      maxSec: z.number().nonnegative(),
    })
    .nullable()
    .default(null),
  /** More than three consecutive shots of a scene with the same framing. */
  framingRuns: z
    .array(
      z.object({
        clipId: IdSchema,
        framing: z.string().max(30),
        count: z.number().int().positive(),
        start: z.number().nonnegative(),
        end: z.number().nonnegative(),
      }),
    )
    .max(200)
    .default([]),
  /** Lines with more words than the shot has time for (`WORDS_PER_SECOND`). */
  rushedLines: z
    .array(
      z.object({
        clipId: IdSchema,
        shotId: IdSchema,
        shot: z.string().max(20),
        words: z.number().int().nonnegative(),
        durationSec: z.number().positive(),
        start: z.number().nonnegative(),
      }),
    )
    .max(500)
    .default([]),
  takes: z
    .object({
      total: z.number().int().nonnegative(),
      passed: z.number().int().nonnegative(),
      failed: z.number().int().nonnegative(),
      unverified: z.number().int().nonnegative(),
      overridden: z.number().int().nonnegative(),
      stale: z.number().int().nonnegative(),
      qualityFailed: z.number().int().nonnegative(),
    })
    .default({ total: 0, passed: 0, failed: 0, unverified: 0, overridden: 0, stale: 0, qualityFailed: 0 }),
  /**
   * The script's lines against what the audio-visual model heard during their shots (`dialogueDelivery`); null when
   * the film was not listened to.
   */
  dialogue: z
    .object({
      lines: z.number().int().nonnegative(),
      heard: z.number().int().nonnegative(),
      missing: z
        .array(
          z.object({
            clipId: IdSchema,
            shotId: IdSchema,
            shot: z.string().max(20),
            character: z.string().max(200),
            line: z.string().max(2000),
            /** The share of the line's words heard. */
            heard: z.number().min(0).max(1),
            start: z.number().nonnegative(),
            end: z.number().nonnegative(),
          }),
        )
        .max(500)
        .default([]),
    })
    .nullable()
    .default(null),
});
export type FeedbackSignals = z.infer<typeof FeedbackSignalsSchema>;

export const SceneFeedbackSchema = z.object({
  clipId: IdSchema,
  index: z.number().int().nonnegative(),
  title: z.string().max(300),
  start: z.number().nonnegative(),
  end: z.number().nonnegative(),
  scores: FeedbackScoresSchema.partial().default({}),
  summary: z.string().max(4000).default(''),
  error: z.string().max(1000).optional(),
});
export type SceneFeedback = z.infer<typeof SceneFeedbackSchema>;

/** A shot whose take in the cut changed since the previous feedback (docs/design/feedback.md#what-changed-since-the-last-feedback). */
export const FeedbackRetakeSchema = z.object({
  clipId: IdSchema,
  shotId: IdSchema,
  /** "C3·S2" */
  shot: z.string().max(20),
  /** The previous feedback's recommendation whose job made the new take, while it is recorded. */
  recommendationId: z.string().max(20).nullable().default(null),
  /** The take in each export, and the issues pinned to the shot in each feedback, weighted by severity. */
  before: z.object({ takeId: IdSchema, issues: z.number().nonnegative() }),
  after: z.object({ takeId: IdSchema, issues: z.number().nonnegative() }),
  outcome: z.enum(['better', 'same', 'worse']),
});
export type FeedbackRetake = z.infer<typeof FeedbackRetakeSchema>;

export const FeedbackSchema = z.object({
  id: IdSchema,
  exportId: IdSchema,
  jobId: IdSchema.optional(),
  status: z.enum(['running', 'succeeded', 'failed']),
  error: z.string().max(4000).optional(),
  createdAt: IsoDateSchema,
  updatedAt: IsoDateSchema,
  /** The vision model; null without a gateway. */
  model: z.string().max(200).nullable().default(null),
  /** The audio-visual model that heard the scenes, if any. */
  listener: z.string().max(200).nullable().default(null),
  /** The scenes were heard (an audio-visual model). */
  listened: z.boolean().default(false),
  timelineCommit: z.string().nullable().default(null),
  durationSec: z.number().nonnegative().default(0),
  overall: z.number().min(0).max(10).nullable().default(null),
  scores: FeedbackScoresSchema.default(emptyScores()),
  summary: z.string().max(8000).default(''),
  strengths: z.array(z.string().max(400)).max(20).default([]),
  scenes: z.array(SceneFeedbackSchema).max(500).default([]),
  issues: z.array(FeedbackIssueSchema).max(1000).default([]),
  recommendations: z.array(FeedbackRecommendationSchema).max(300).default([]),
  retrospective: z.array(RetrospectiveItemSchema).max(60).default([]),
  signals: FeedbackSignalsSchema.default(FeedbackSignalsSchema.parse({})),
  report: MediaRefSchema.nullable().default(null),
  /** The feedback `retakes` compares with: the project's latest succeeded one of another export. */
  previousFeedbackId: IdSchema.nullable().default(null),
  retakes: z.array(FeedbackRetakeSchema).max(500).default([]),
});
export type Feedback = z.infer<typeof FeedbackSchema>;

/** One feedback per export: running it again replaces it (the history keeps the earlier one). */
export function feedbackIdFor(exportId: string): string {
  return `${ID_PREFIXES.feedback}_${exportId.slice(exportId.indexOf('_') + 1)}`;
}

/** The weighted mean of the scored dimensions (0–10), or null when none is scored. */
export function overallScore(scores: Partial<FeedbackScores>): number | null {
  let sum = 0;
  let weight = 0;
  for (const d of FEEDBACK_DIMENSIONS) {
    const v = scores[d.id];
    if (typeof v !== 'number' || !Number.isFinite(v)) continue;
    sum += v * d.weight;
    weight += d.weight;
  }
  return weight ? Math.round((sum / weight) * 10) / 10 : null;
}
