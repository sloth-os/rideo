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
  'media.process',
  'analysis.signals',
  'analysis.suggest',
  'edit.auto',
  'timeline.assemble',
  'export.render',
  'export.finish',
] as const;
export const JobKindSchema = z.enum(JOB_KINDS);
export type JobKind = z.infer<typeof JobKindSchema>;

/** `client` jobs are editor jobs: run by studio tabs, never by the server (docs/design/editor.md#editor-jobs). */
export const LANES = ['control', 'llm', 'image', 'video', 'music', 'media', 'client'] as const;
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
  'media.process': 'client',
  'analysis.signals': 'client',
  'analysis.suggest': 'llm',
  'edit.auto': 'control',
  'timeline.assemble': 'control',
  'export.render': 'client',
  'export.finish': 'media',
};

export const EDITOR_JOB_KINDS = ['media.process', 'analysis.signals', 'export.render'] as const;
export const EditorJobKindSchema = z.enum(EDITOR_JOB_KINDS);
export type EditorJobKind = z.infer<typeof EditorJobKindSchema>;
export function isEditorJob(job: Pick<Job, 'kind'>): job is Job & { kind: EditorJobKind } {
  return (EDITOR_JOB_KINDS as readonly string[]).includes(job.kind);
}

export const JobLeaseSchema = z.object({
  sessionId: z.string().min(1).max(100),
  claimedAt: IsoDateSchema,
  expiresAt: IsoDateSchema,
});
export type JobLease = z.infer<typeof JobLeaseSchema>;

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
  /** Editor jobs: the tab currently running it. */
  lease: JobLeaseSchema.nullable().default(null),
  /** Editor jobs: files uploaded so far (kept across leases so a render can resume). */
  staged: z.array(z.string()).default([]),
  createdAt: IsoDateSchema,
  startedAt: IsoDateSchema.optional(),
  finishedAt: IsoDateSchema.optional(),
});
export type Job = z.infer<typeof JobSchema>;

export const TERMINAL_JOB_STATUSES: JobStatus[] = ['succeeded', 'failed', 'cancelled'];
export function isTerminalJob(job: Pick<Job, 'status'>): boolean {
  return TERMINAL_JOB_STATUSES.includes(job.status);
}

export const ExportQualitySchema = z.enum(['draft', 'standard', 'high']);
export type ExportQuality = z.infer<typeof ExportQualitySchema>;
export const RenderEngineSchema = z.enum(['ffmpeg', 'webcodecs']);
export type RenderEngine = z.infer<typeof RenderEngineSchema>;
export const RenderEngineChoiceSchema = z.enum(['auto', 'ffmpeg', 'webcodecs']);
export type RenderEngineChoice = z.infer<typeof RenderEngineChoiceSchema>;

export const ExportSchema = z.object({
  id: IdSchema,
  createdAt: IsoDateSchema,
  /** `server` exports are from before rendering moved to the browser (kept readable). */
  method: z.enum(['server', 'browser']),
  engine: RenderEngineSchema.optional(),
  status: z.enum(['queued', 'rendering', 'finishing', 'succeeded', 'failed']),
  quality: ExportQualitySchema.default('standard'),
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
