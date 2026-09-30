import { z } from 'zod';
import { ActorSchema, AspectRatioSchema, IdSchema, IsoDateSchema } from './common';

export const ProjectKindSchema = z.enum(['story', 'edit']);
export type ProjectKind = z.infer<typeof ProjectKindSchema>;

export const ConsistencySettingsSchema = z.object({
  threshold: z.number().min(0).max(1).default(0.75),
  maxAttempts: z.number().int().min(1).max(8).default(3),
  judge: z.enum(['vision-llm', 'off']).default('vision-llm'),
});

export const ProjectSettingsSchema = z.object({
  aspectRatio: AspectRatioSchema.default('16:9'),
  resolution: z
    .object({ width: z.number().int().min(64).max(4096), height: z.number().int().min(64).max(4096) })
    .default({ width: 1280, height: 720 }),
  fps: z.number().int().min(12).max(60).default(24),
  targetDurationSec: z.number().min(10).max(10800).default(2700),
  pilotDurationSec: z.number().min(10).max(180).default(30),
  language: z.string().min(2).max(16).default('en'),
  models: z
    .object({
      image: z.string().min(1).default('auto'),
      video: z.string().min(1).default('auto'),
      music: z.string().min(1).default('auto'),
    })
    .default({ image: 'auto', video: 'auto', music: 'auto' }),
  consistency: ConsistencySettingsSchema.default({ threshold: 0.75, maxAttempts: 3, judge: 'vision-llm' }),
  generation: z
    .object({ includeAudio: z.boolean().default(false), keyframes: z.boolean().default(true) })
    .default({ includeAudio: false, keyframes: true }),
  batch: z
    .object({ maxGenerations: z.number().int().min(1).max(100000).default(2000) })
    .default({ maxGenerations: 2000 }),
  watermark: z.object({ enabled: z.boolean().default(true) }).default({ enabled: true }),
  autopilot: z.boolean().default(false),
  approvals: z
    .object({ allowAgents: z.boolean().default(true), allowAgentOverrides: z.boolean().default(false) })
    .default({ allowAgents: true, allowAgentOverrides: false }),
});
export type ProjectSettings = z.infer<typeof ProjectSettingsSchema>;

export const ApprovalSchema = z.object({ at: IsoDateSchema, actor: ActorSchema, tag: z.string().optional() });
export type Approval = z.infer<typeof ApprovalSchema>;

export const ProjectSchema = z.object({
  schemaVersion: z.literal(1),
  id: IdSchema,
  kind: ProjectKindSchema,
  title: z.string().min(1).max(200),
  createdAt: IsoDateSchema,
  brief: z.object({
    prompt: z.string().max(20000).default(''),
    attachmentResourceIds: z.array(IdSchema).default([]),
  }),
  settings: ProjectSettingsSchema,
  workflow: z.object({
    stage: z.string().min(1),
    approvals: z.record(z.string(), ApprovalSchema).default({}),
  }),
});
export type Project = z.infer<typeof ProjectSchema>;

export const ProjectSummarySchema = z.object({
  id: IdSchema,
  kind: ProjectKindSchema,
  title: z.string(),
  stage: z.string(),
  createdAt: z.string(),
  updatedAt: z.string().optional(),
  targetDurationSec: z.number().optional(),
  plannedDurationSec: z.number().optional(),
  approvedDurationSec: z.number().optional(),
  posterPath: z.string().optional(),
});
export type ProjectSummary = z.infer<typeof ProjectSummarySchema>;
