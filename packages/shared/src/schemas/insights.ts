import { z } from 'zod';
import { FeedbackScoresSchema, RetrospectiveItemSchema } from './feedback';
import { ProjectUsageSchema } from './usage';

/** A project's run at a glance (docs/design/observability.md#insights). */
export const InsightsSchema = z.object({
  usage: ProjectUsageSchema,
  jobs: z.array(
    z.object({
      kind: z.string(),
      count: z.number().int().nonnegative(),
      succeeded: z.number().int().nonnegative(),
      failed: z.number().int().nonnegative(),
      cancelled: z.number().int().nonnegative(),
      p50Sec: z.number().nonnegative().nullable(),
      p90Sec: z.number().nonnegative().nullable(),
      waitP50Sec: z.number().nonnegative().nullable(),
      errors: z.record(z.string(), z.number().int().nonnegative()),
    }),
  ),
  takes: z.object({
    total: z.number().int().nonnegative(),
    passed: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    unverified: z.number().int().nonnegative(),
    overridden: z.number().int().nonnegative(),
    /** Selected takes that passed identity on their first attempt. */
    firstTry: z.number().int().nonnegative(),
    qualityFailed: z.number().int().nonnegative(),
    meanAttempts: z.number().nonnegative().nullable(),
  }),
  characters: z.array(
    z.object({
      characterId: z.string(),
      name: z.string(),
      checks: z.number().int().nonnegative(),
      failures: z.number().int().nonnegative(),
    }),
  ),
  stages: z.array(z.object({ stage: z.string(), at: z.string() })),
  feedback: z.array(
    z.object({
      exportId: z.string(),
      createdAt: z.string(),
      overall: z.number().nullable(),
      scores: FeedbackScoresSchema,
    }),
  ),
  retrospective: z.array(RetrospectiveItemSchema),
});
export type Insights = z.infer<typeof InsightsSchema>;
