import { z } from 'zod';
import { ActorSchema, IdSchema, IsoDateSchema, MediaRefSchema } from './common';
import { ContentCredentialsStampSchema, DisclosureStampSchema } from './provenance';

export const JOB_KINDS = [
  'screenplay.generate',
  'screenplay.extend',
  'character.describe',
  'character.refs',
  'element.refs',
  'voice.design',
  'storyboard.generate',
  'shot.board',
  'take.edit',
  'take.extend',
  'timeline.extend',
  'clip.plan',
  'clip.generate',
  'shot.generate',
  'shot.group',
  'batch.generate',
  'music.generate',
  'score.generate',
  'sfx.generate',
  'localize.generate',
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
  'element.refs': 'image',
  'voice.design': 'music',
  'storyboard.generate': 'control',
  'shot.board': 'image',
  'take.edit': 'video',
  'take.extend': 'video',
  'timeline.extend': 'video',
  'clip.plan': 'llm',
  'clip.generate': 'control',
  'shot.generate': 'video',
  'shot.group': 'video',
  'batch.generate': 'control',
  'music.generate': 'music',
  'score.generate': 'music',
  'sfx.generate': 'music',
  'localize.generate': 'music',
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
/** Loudness targets of an export (docs/design/post-audio.md#loudness). */
export const LoudnessTargetSchema = z.enum(['streaming', 'broadcast', 'off']);
export type LoudnessTarget = z.infer<typeof LoudnessTargetSchema>;

/** The loudness of an export: the target, and what `export.finish` measured after normalizing. */
export const ExportLoudnessSchema = z.object({
  target: LoudnessTargetSchema,
  mode: z.enum(['pending', 'linear', 'dynamic', 'silent', 'off']).default('pending'),
  integratedLufs: z.number().nullable().default(null),
  truePeakDb: z.number().nullable().default(null),
  lra: z.number().nullable().default(null),
  inputLufs: z.number().nullable().default(null),
});
export type ExportLoudness = z.infer<typeof ExportLoudnessSchema>;

/** Dialogue, music and effects stems of an export (docs/design/post-audio.md#stems). */
export const ExportStemsSchema = z.object({
  dialogue: MediaRefSchema,
  music: MediaRefSchema,
  effects: MediaRefSchema,
});
export type ExportStems = z.infer<typeof ExportStemsSchema>;

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
  /** What was rendered: the cut, or the storyboard's animatic (docs/design/storyboard.md#animatic). */
  source: z.enum(['timeline', 'animatic']).default('timeline'),
  media: MediaRefSchema.nullable().default(null),
  watermarkId: z.string().nullable().default(null),
  contentCredentials: ContentCredentialsStampSchema.nullable().default(null),
  disclosure: DisclosureStampSchema.nullable().default(null),
  timelineCommit: z.string().nullable().default(null),
  /** Null on exports from before post audio (docs/design/post-audio.md). */
  loudness: ExportLoudnessSchema.nullable().default(null),
  /** Asked for with `stems`; null until published. */
  stemsRequested: z.boolean().default(false),
  stems: ExportStemsSchema.nullable().default(null),
  /** A language variant (docs/design/localization.md#language-variants); null = the original. */
  language: z.string().max(20).nullable().default(null),
  dubbed: z.boolean().default(false),
  /** Captions burned into the picture, or only as SRT/VTT sidecars. */
  captions: z.enum(['burn', 'sidecar']).default('burn'),
  subtitles: z
    .object({ language: z.string().max(20).nullable(), srt: MediaRefSchema, vtt: MediaRefSchema })
    .nullable()
    .default(null),
  durationSec: z.number().nonnegative().optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  codec: z.string().optional(),
  jobId: IdSchema.optional(),
  error: z.string().max(4000).optional(),
});
export type Export = z.infer<typeof ExportSchema>;
