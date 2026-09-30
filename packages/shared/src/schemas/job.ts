import { z } from 'zod';
import { ActorSchema, IdSchema, IsoDateSchema, MediaRefSchema } from './common';

export const JOB_KINDS = [
  'screenplay.generate',
  'screenplay.extend',
  'character.describe',
  'character.refs',
  'clip.plan',
  'clip.generate',
  'shot.generate',
  'batch.generate',
  'music.generate',
  'resource.process',
  'analysis.run',
  'edit.auto',
  'timeline.assemble',
  'export.render',
  'export.finish',
] as const;
export const JobKindSchema = z.enum(JOB_KINDS);
export type JobKind = z.infer<typeof JobKindSchema>;

export const LANES = ['control', 'llm', 'image', 'video', 'music', 'media'] as const;
export const LaneSchema = z.enum(LANES);
export type Lane = z.infer<typeof LaneSchema>;

export const JOB_LANES: Record<JobKind, Lane> = {
  'screenplay.generate': 'llm',
  'screenplay.extend': 'llm',
  'character.describe': 'llm',
  'character.refs': 'image',
  'clip.plan': 'llm',
  'clip.generate': 'control',
  'shot.generate': 'video',
  'batch.generate': 'control',
  'music.generate': 'music',
  'resource.process': 'media',
  'analysis.run': 'media',
  'edit.auto': 'control',
  'timeline.assemble': 'control',
  'export.render': 'media',
  'export.finish': 'media',
};

export const JobStatusSchema = z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled']);
export type JobStatus = z.infer<typeof JobStatusSchema>;

export const JobSchema = z.object({
  id: IdSchema,
  projectId: IdSchema,
  kind: JobKindSchema,
  lane: LaneSchema,
  status: JobStatusSchema,
  params: z.record(z.string(), z.unknown()).default({}),
  result: z.unknown().optional(),
  error: z.object({ code: z.string(), message: z.string(), retryable: z.boolean() }).optional(),
  progress: z.object({ done: z.number(), total: z.number(), message: z.string().optional() }),
  attempts: z.number().int().nonnegative(),
  maxAttempts: z.number().int().positive(),
  dedupeKey: z.string().optional(),
  parentId: IdSchema.optional(),
  branch: z.string(),
  actor: ActorSchema,
  priority: z.number().int(),
  gatewayTasks: z
    .array(
      z.object({
        modality: z.enum(['image', 'video', 'music']),
        id: z.string(),
        status: z.string(),
        idempotencyKey: z.string(),
        model: z.string().optional(),
      }),
    )
    .default([]),
  createdAt: IsoDateSchema,
  startedAt: IsoDateSchema.optional(),
  finishedAt: IsoDateSchema.optional(),
});
export type Job = z.infer<typeof JobSchema>;

export const TERMINAL_JOB_STATUSES: JobStatus[] = ['succeeded', 'failed', 'cancelled'];
export function isTerminalJob(job: Pick<Job, 'status'>): boolean {
  return TERMINAL_JOB_STATUSES.includes(job.status);
}

export const ExportSchema = z.object({
  id: IdSchema,
  createdAt: IsoDateSchema,
  method: z.enum(['server', 'browser']),
  status: z.enum(['queued', 'rendering', 'finishing', 'succeeded', 'failed']),
  quality: z.enum(['draft', 'standard', 'high']).default('standard'),
  media: MediaRefSchema.nullable().default(null),
  watermarkId: z.string().nullable().default(null),
  timelineCommit: z.string().nullable().default(null),
  durationSec: z.number().nonnegative().optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  codec: z.string().optional(),
  jobId: IdSchema.optional(),
  error: z.string().max(4000).optional(),
});
export type Export = z.infer<typeof ExportSchema>;
