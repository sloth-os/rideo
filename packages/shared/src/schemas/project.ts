import { z } from 'zod';
import { ProjectBrandSchema } from '../brand/schema';
import { ProjectAccessSchema } from './accounts';
import { ActorSchema, AspectRatioSchema, IdSchema, IsoDateSchema } from './common';

export const ProjectKindSchema = z.enum(['story', 'edit']);
export type ProjectKind = z.infer<typeof ProjectKindSchema>;

export const ConsistencySettingsSchema = z.object({
  threshold: z.number().min(0).max(1).default(0.75),
  maxAttempts: z.number().int().min(1).max(8).default(3),
  judge: z.enum(['vision-llm', 'off']).default('vision-llm'),
  /** Also judge locations and props against their references (rule E4). */
  judgeElements: z.boolean().default(false),
  /** Check the speakers of native-audio takes against their voice locks (rule V4). */
  judgeVoices: z.boolean().default(true),
  /** Temporal and physics checks of every video attempt (docs/design/continuity.md#quality-checks-in-the-gate). */
  qualityChecks: z.boolean().default(false),
  /** The lowest physics score an attempt may have (0–1). */
  qualityThreshold: z.number().min(0).max(1).default(0.5),
});
export type ConsistencySettings = z.infer<typeof ConsistencySettingsSchema>;

/** How screenplay lines become audio (docs/design/dialogue.md#from-lines-to-audio). */
export const DialogueModeSchema = z.enum(['tts', 'native', 'off']);
export type DialogueMode = z.infer<typeof DialogueModeSchema>;
/** The CEFR level every written line keeps to (docs/design/continuity.md#storytelling); `any` sets none. */
export const DIALOGUE_LEVEL_IDS = ['any', 'A1', 'A2', 'B1', 'B2', 'C1', 'C2'] as const;
export const DialogueLevelSchema = z.enum(DIALOGUE_LEVEL_IDS);
export type DialogueLevel = z.infer<typeof DialogueLevelSchema>;
export const DialogueSettingsSchema = z.object({
  mode: DialogueModeSchema.default('off'),
  /** Re-render TTS takes whose model could not take the dialogue as reference audio. */
  lipSync: z.boolean().default(true),
  level: DialogueLevelSchema.default('any'),
});
export type DialogueSettings = z.infer<typeof DialogueSettingsSchema>;

/** The visible "AI-generated" label (docs/design/provenance.md#disclosure-label). */
export const DisclosurePositionSchema = z.enum(['top_left', 'top_right', 'bottom_left', 'bottom_right']);
export type DisclosurePosition = z.infer<typeof DisclosurePositionSchema>;
export const DisclosureSettingsSchema = z.object({
  label: z.enum(['auto', 'always', 'off']).default('auto'),
  text: z.string().trim().min(1).max(60).default('AI-generated'),
  position: DisclosurePositionSchema.default('top_right'),
});
export type DisclosureSettings = z.infer<typeof DisclosureSettingsSchema>;
export const DEFAULT_DISCLOSURE: DisclosureSettings = {
  label: 'auto',
  text: 'AI-generated',
  position: 'top_right',
};

/** The storyboard stage (docs/design/storyboard.md#stage-and-gate). */
export const StoryboardSettingsSchema = z.object({
  enabled: z.boolean().default(true),
  /** How many scenes (from the first) are storyboarded before the pilot. */
  scenes: z.number().int().min(1).max(50).default(3),
});
export type StoryboardSettings = z.infer<typeof StoryboardSettingsSchema>;

export const PromptVersionSchema = z.union([z.literal(1), z.literal(2)]);
export type PromptVersion = z.infer<typeof PromptVersionSchema>;

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
      /** The video model of the lip-sync pass (docs/design/dialogue.md#from-lines-to-audio). */
      lipSync: z.string().min(1).default('auto'),
      /** The video-to-video model of take edits (docs/design/take-editing.md). */
      edit: z.string().min(1).default('auto'),
      /** Upscale and frame interpolation of exports (docs/design/finishing.md); `off` uses ffmpeg. */
      enhance: z.string().min(1).default('auto'),
      /** The segmentation model of Remove the background (docs/design/editor.md); `off` disables it. */
      segment: z.string().min(1).default('auto'),
      /** The model of performance takes (docs/design/performance.md); `off` disables them. */
      performance: z.string().min(1).default('auto'),
    })
    .default({
      image: 'auto',
      video: 'auto',
      music: 'auto',
      lipSync: 'auto',
      edit: 'auto',
      enhance: 'auto',
      segment: 'auto',
      performance: 'auto',
    }),
  consistency: ConsistencySettingsSchema.default({
    threshold: 0.75,
    maxAttempts: 3,
    judge: 'vision-llm',
    judgeElements: false,
    judgeVoices: true,
    qualityChecks: false,
    qualityThreshold: 0.5,
  }),
  dialogue: DialogueSettingsSchema.default({ mode: 'off', lipSync: true, level: 'any' }),
  storyboard: StoryboardSettingsSchema.default({ enabled: true, scenes: 3 }),
  generation: z
    .object({
      includeAudio: z.boolean().default(false),
      keyframes: z.boolean().default(true),
      /** Groups of shots in one request on multi-shot models (docs/design/multi-shot.md). */
      multiShot: z.enum(['auto', 'off']).default('auto'),
      /** 1: prompts as before; 2: continuity-aware prompts (docs/design/continuity.md#prompt-version). */
      promptVersion: PromptVersionSchema.default(1),
      /** The provider's own prompt rewriting (`enhance_prompt`); null leaves the provider's default. */
      enhancePrompt: z.boolean().nullable().default(null),
      /** Version 2: let the video model add music to its shots (else "no background music"). */
      modelMusic: z.boolean().default(false),
    })
    .default({
      includeAudio: false,
      keyframes: true,
      multiShot: 'auto',
      promptVersion: 1,
      enhancePrompt: null,
      modelMusic: false,
    }),
  /** Feedback on exports (docs/design/feedback.md#when-it-runs). */
  feedback: z.object({ auto: z.boolean().default(true) }).default({ auto: true }),
  batch: z
    .object({ maxGenerations: z.number().int().min(1).max(100000).default(2000) })
    .default({ maxGenerations: 2000 }),
  watermark: z.object({ enabled: z.boolean().default(true) }).default({ enabled: true }),
  disclosure: DisclosureSettingsSchema.default(DEFAULT_DISCLOSURE),
  autopilot: z.boolean().default(false),
  approvals: z
    .object({ allowAgents: z.boolean().default(true), allowAgentOverrides: z.boolean().default(false) })
    .default({ allowAgents: true, allowAgentOverrides: false }),
  /** The brand kit applied to the project, resolved onto its media (docs/design/brand-kits.md). */
  brand: ProjectBrandSchema.nullable().default(null),
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
  /** Members and visibility (docs/design/accounts.md); null on projects from before accounts: open. */
  access: ProjectAccessSchema.nullable().default(null),
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
  /** The caller's role (docs/design/accounts.md). */
  role: z.enum(['reviewer', 'editor', 'director']).optional(),
});
export type ProjectSummary = z.infer<typeof ProjectSummarySchema>;
