import { z } from 'zod';
import { EditSuggestionSchema } from './analysis';
import { CharacterRoleSchema, IdentitySchema, ReferenceViewSchema } from './character';
import { CameraSchema } from './clip';
import { AspectRatioSchema, IdSchema } from './common';
import { ProjectKindSchema } from './project';
import { ResourceKindSchema, ResourceRoleSchema } from './resource';
import { DialogueLineSchema, StyleBibleSchema } from './screenplay';
import { TimelineOpSchema } from './timeline';

/** Deep-partial settings patch (every nested object optional); merged over current settings. */
export const ProjectSettingsPatchSchema = z
  .object({
    aspectRatio: AspectRatioSchema,
    resolution: z.object({
      width: z.number().int().min(64).max(4096),
      height: z.number().int().min(64).max(4096),
    }),
    fps: z.number().int().min(12).max(60),
    targetDurationSec: z.number().min(10).max(10800),
    pilotDurationSec: z.number().min(10).max(180),
    language: z.string().min(2).max(16),
    models: z
      .object({ image: z.string().min(1), video: z.string().min(1), music: z.string().min(1) })
      .partial(),
    consistency: z
      .object({
        threshold: z.number().min(0).max(1),
        maxAttempts: z.number().int().min(1).max(8),
        judge: z.enum(['vision-llm', 'off']),
      })
      .partial(),
    generation: z.object({ includeAudio: z.boolean(), keyframes: z.boolean() }).partial(),
    batch: z.object({ maxGenerations: z.number().int().min(1).max(100000) }).partial(),
    watermark: z.object({ enabled: z.boolean() }).partial(),
    autopilot: z.boolean(),
    approvals: z.object({ allowAgents: z.boolean(), allowAgentOverrides: z.boolean() }).partial(),
  })
  .partial();
export type ProjectSettingsPatch = z.infer<typeof ProjectSettingsPatchSchema>;

export const BriefPatchSchema = z
  .object({ prompt: z.string().max(20000), attachmentResourceIds: z.array(IdSchema) })
  .partial();

export const CreateProjectInputSchema = z.object({
  kind: ProjectKindSchema,
  title: z.string().min(1).max(200),
  brief: BriefPatchSchema.optional(),
  settings: ProjectSettingsPatchSchema.optional(),
});
export type CreateProjectInput = z.infer<typeof CreateProjectInputSchema>;

export const UpdateProjectInputSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  brief: BriefPatchSchema.optional(),
  settings: ProjectSettingsPatchSchema.optional(),
});
export type UpdateProjectInput = z.infer<typeof UpdateProjectInputSchema>;

export const SceneInputSchema = z.object({
  id: IdSchema.optional(),
  index: z.number().int().nonnegative().optional(),
  heading: z.string().max(300),
  location: z.string().max(300).optional(),
  timeOfDay: z.string().max(60).optional(),
  summary: z.string().max(4000).optional(),
  action: z.string().max(20000).optional(),
  dialogue: z.array(DialogueLineSchema.partial({ characterId: true })).optional(),
  characterIds: z.array(IdSchema).optional(),
  estDurationSec: z.number().positive().max(3600).optional(),
  beatId: IdSchema.nullable().optional(),
});
export type SceneInput = z.infer<typeof SceneInputSchema>;

export const OutlineBeatInputSchema = z.object({
  id: IdSchema.optional(),
  title: z.string().max(200).optional(),
  summary: z.string().max(4000),
  estDurationSec: z.number().positive().max(3600),
  sceneId: IdSchema.nullable().optional(),
});

export const ScreenplayPatchInputSchema = z.object({
  fields: z
    .object({
      title: z.string().max(200),
      logline: z.string().max(1000),
      synopsis: z.string().max(20000),
      genre: z.string().max(200),
      tone: z.string().max(200),
      style: StyleBibleSchema.partial(),
      ended: z.boolean(),
    })
    .partial()
    .optional(),
  upsertScenes: z.array(SceneInputSchema).optional(),
  removeSceneIds: z.array(IdSchema).optional(),
  outline: z.array(OutlineBeatInputSchema).optional(),
});
export type ScreenplayPatchInput = z.infer<typeof ScreenplayPatchInputSchema>;

export const WardrobeInputSchema = z.object({
  id: IdSchema.optional(),
  name: z.string().min(1).max(120),
  description: z.string().max(1000),
  default: z.boolean().optional(),
});

export const CharacterInputSchema = z.object({
  name: z.string().min(1).max(120),
  role: CharacterRoleSchema.optional(),
  summary: z.string().max(4000).optional(),
  identity: IdentitySchema.partial().optional(),
  wardrobe: z.array(WardrobeInputSchema).optional(),
  personality: z.string().max(2000).optional(),
  voice: z.object({ description: z.string().max(1000) }).optional(),
});
export type CharacterInput = z.infer<typeof CharacterInputSchema>;

export const CharacterUpdateInputSchema = CharacterInputSchema.partial();
export type CharacterUpdateInput = z.infer<typeof CharacterUpdateInputSchema>;

export const AddReferenceInputSchema = z.object({
  uri: z.string().min(1).max(50_000_000),
  view: ReferenceViewSchema.optional(),
  approved: z.boolean().optional(),
});

export const GenerateRefsInputSchema = z.object({
  views: z.array(ReferenceViewSchema).min(1).max(6).optional(),
});

export const ResourceInputSchema = z.object({
  uri: z.string().min(1).max(200_000_000),
  kind: ResourceKindSchema.optional(),
  role: ResourceRoleSchema.optional(),
  name: z.string().min(1).max(300).optional(),
});
export type ResourceInput = z.infer<typeof ResourceInputSchema>;

export const MusicInputSchema = z.object({
  prompt: z.string().min(3).max(4000),
  durationSec: z.number().min(5).max(600).optional(),
  instrumental: z.boolean().optional(),
});

export const ShotUpdateInputSchema = z
  .object({
    description: z.string().max(4000),
    action: z.string().max(4000),
    camera: CameraSchema.partial(),
    characterIds: z.array(IdSchema),
    wardrobe: z.record(z.string(), IdSchema),
    dialogue: z.array(z.object({ characterId: IdSchema.nullable(), line: z.string().max(2000) })),
    durationSec: z.number().positive().max(60),
    continuity: z.enum(['cut', 'continuous']),
    promptOverride: z.string().max(8000).nullable(),
    negativePrompt: z.string().max(2000).nullable(),
  })
  .partial();
export type ShotUpdateInput = z.infer<typeof ShotUpdateInputSchema>;

export const TimelineOpsInputSchema = z.object({ ops: z.array(TimelineOpSchema).min(1).max(500) });

export const AssembleInputSchema = z.object({
  captions: z.boolean().optional(),
  musicResourceId: IdSchema.optional(),
});

export const SuggestionDecisionsInputSchema = z.object({
  decisions: z.array(z.object({ id: IdSchema, status: EditSuggestionSchema.shape.status })).min(1),
});

export const ExportInputSchema = z.object({ quality: z.enum(['draft', 'standard', 'high']).optional() });

export const RestoreInputSchema = z.object({
  commit: z.string().min(4),
  paths: z.array(z.string()).optional(),
});

export const ApproveInputSchema = z.object({ gate: z.string().min(1) });
export const ReopenInputSchema = z.object({ stage: z.string().min(1) });
export const OverrideInputSchema = z.object({ reason: z.string().min(3).max(1000) });
