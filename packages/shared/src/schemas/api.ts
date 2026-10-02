import { z } from 'zod';
import { EditSuggestionSchema } from './analysis';
import { CharacterRoleSchema, ConsentInputSchema, IdentitySchema, ReferenceViewSchema } from './character';
import {
  CameraSchema,
  EditKindSchema,
  EndFrameSchema,
  MotionReferenceSchema,
  StartFrameSchema,
} from './clip';
import { AspectRatioSchema, IdSchema } from './common';
import { ElementKindSchema, ElementReferenceViewSchema } from './element';
import {
  DeliveryAspectSchema,
  DeliveryFormatSchema,
  DeliveryPresetIdSchema,
  DeliveryResolutionSchema,
  ExportQualitySchema,
  LoudnessTargetSchema,
  RenderEngineChoiceSchema,
} from './job';
import { LanguageCodeSchema } from './localization';
import { DialogueModeSchema, DisclosurePositionSchema, ProjectKindSchema } from './project';
import { ResourceKindSchema, ResourceRoleSchema } from './resource';
import { AnnotationSchema, CommentTargetSchema, ReviewTargetSchema } from './review';
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
      .object({
        image: z.string().min(1),
        video: z.string().min(1),
        music: z.string().min(1),
        lipSync: z.string().min(1),
        edit: z.string().min(1),
        enhance: z.string().min(1),
        /** Remove the background (docs/design/editor.md#segmentation-masks-remove-the-background). */
        segment: z.string().min(1),
      })
      .partial(),
    consistency: z
      .object({
        threshold: z.number().min(0).max(1),
        maxAttempts: z.number().int().min(1).max(8),
        judge: z.enum(['vision-llm', 'off']),
        judgeElements: z.boolean(),
        judgeVoices: z.boolean(),
      })
      .partial(),
    /** Dialogue audio (docs/design/dialogue.md#from-lines-to-audio). */
    dialogue: z.object({ mode: DialogueModeSchema, lipSync: z.boolean() }).partial(),
    /** The storyboard stage (docs/design/storyboard.md). */
    storyboard: z.object({ enabled: z.boolean(), scenes: z.number().int().min(1).max(50) }).partial(),
    generation: z
      .object({ includeAudio: z.boolean(), keyframes: z.boolean(), multiShot: z.enum(['auto', 'off']) })
      .partial(),
    batch: z.object({ maxGenerations: z.number().int().min(1).max(100000) }).partial(),
    watermark: z.object({ enabled: z.boolean() }).partial(),
    disclosure: z
      .object({
        label: z.enum(['auto', 'always', 'off']),
        text: z.string().trim().min(1).max(60),
        position: DisclosurePositionSchema,
      })
      .partial(),
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
  locationId: IdSchema.nullable().optional(),
  elementIds: z.array(IdSchema).optional(),
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
  /** Required for uploads: does the image show a real person, and who consented (docs/design/provenance.md). */
  consent: ConsentInputSchema.optional(),
});

/** Pick a designed voice preview (docs/design/dialogue.md#surfaces). */
export const SelectVoiceInputSchema = z.object({ candidateId: IdSchema });

/** Clone a voice from a recording (JSON form; uploads use multipart `file` + `consent`). */
export const CloneVoiceInputSchema = z.object({
  uri: z.string().min(1).max(100_000_000),
  consent: ConsentInputSchema.optional(),
});

export const DescribeCharacterInputSchema = z.object({
  resourceId: IdSchema,
  consent: ConsentInputSchema.optional(),
});

export const GenerateRefsInputSchema = z.object({
  views: z.array(ReferenceViewSchema).min(1).max(6).optional(),
});

export const ElementInputSchema = z.object({
  kind: ElementKindSchema,
  name: z.string().trim().min(1).max(120),
  description: z.string().max(2000).optional(),
  aliases: z.array(z.string().trim().min(1).max(120)).max(20).optional(),
});
export type ElementInput = z.infer<typeof ElementInputSchema>;

export const ElementUpdateInputSchema = ElementInputSchema.omit({ kind: true }).partial();
export type ElementUpdateInput = z.infer<typeof ElementUpdateInputSchema>;

export const AddElementReferenceInputSchema = z.object({
  uri: z.string().min(1).max(50_000_000),
  view: ElementReferenceViewSchema.optional(),
  approved: z.boolean().optional(),
});

export const GenerateElementRefsInputSchema = z.object({
  views: z.array(ElementReferenceViewSchema).min(1).max(4).optional(),
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
    elementIds: z.array(IdSchema),
    wardrobe: z.record(z.string(), IdSchema),
    dialogue: z.array(z.object({ characterId: IdSchema.nullable(), line: z.string().max(2000) })),
    durationSec: z.number().positive().max(60),
    continuity: z.enum(['cut', 'continuous']),
    promptOverride: z.string().max(8000).nullable(),
    negativePrompt: z.string().max(2000).nullable(),
    /** Directing controls (docs/design/directing.md). */
    startFrame: StartFrameSchema,
    endFrame: EndFrameSchema,
    motionReference: MotionReferenceSchema.nullable(),
    seed: z.number().int().min(0).max(4294967295).nullable(),
  })
  .partial();
export type ShotUpdateInput = z.infer<typeof ShotUpdateInputSchema>;

/** Take edits and extensions (docs/design/take-editing.md). */
export const TakeEditInputSchema = z.object({
  kind: EditKindSchema,
  instruction: z.string().trim().min(2).max(1000),
});
export const TakeExtendInputSchema = z.object({
  seconds: z.number().min(1).max(10),
  prompt: z.string().max(1000).optional(),
});
export const TimelineExtendInputSchema = z.object({
  edge: z.enum(['start', 'end']),
  seconds: z.number().min(1).max(5),
  prompt: z.string().max(1000).optional(),
});

/** Runs a recipe on a project (docs/design/agents.md#recipes). */
export const RecipeRunInputSchema = z.object({ params: z.record(z.string(), z.unknown()).default({}) });

/** Variations of every shot of a clip, or of the listed ones (docs/design/agents.md#many-things-at-once). */
export const BatchVariationsInputSchema = z.object({
  shotIds: z.array(IdSchema).min(1).max(100).optional(),
  count: z.number().int().min(2).max(4).default(2),
});

/** Voices for every speaking character without one (docs/design/agents.md#many-things-at-once). */
export const VoicesCastInputSchema = z.object({
  characterIds: z.array(IdSchema).min(1).max(100).optional(),
  pick: z.boolean().default(false),
  lock: z.boolean().default(false),
});

/** Remove the background of a video item (docs/design/editor.md#segmentation-masks-remove-the-background). */
export const MaskInputSchema = z.object({
  subject: z.string().trim().min(1).max(200).optional(),
  invert: z.boolean().optional(),
});

/** N takes of one shot with offset seeds, to compare (docs/design/directing.md#variations-and-comparison). */
export const VariationsInputSchema = z.object({ count: z.number().int().min(2).max(4) });

export const TimelineOpsInputSchema = z.object({ ops: z.array(TimelineOpSchema).min(1).max(500) });

export const AssembleInputSchema = z.object({
  captions: z.boolean().optional(),
  musicResourceId: IdSchema.optional(),
});

export const SuggestionDecisionsInputSchema = z.object({
  decisions: z.array(z.object({ id: IdSchema, status: EditSuggestionSchema.shape.status })).min(1),
});

export const ExportInputSchema = z.object({
  quality: ExportQualitySchema.optional(),
  engine: RenderEngineChoiceSchema.optional(),
  /** `animatic` renders the storyboard's animatic (docs/design/storyboard.md#animatic). */
  source: z.enum(['timeline', 'animatic']).optional(),
  /** Loudness target (docs/design/post-audio.md#loudness); default `streaming`. */
  loudness: LoudnessTargetSchema.optional(),
  /** Also deliver the dialogue, music and effects stems. */
  stems: z.boolean().optional(),
  /** A language variant (docs/design/localization.md#language-variants). */
  language: LanguageCodeSchema.optional(),
  dubbed: z.boolean().optional(),
  captions: z.enum(['burn', 'sidecar']).optional(),
  /** A delivery (docs/design/finishing.md): a preset, then explicit options. */
  preset: DeliveryPresetIdSchema.optional(),
  format: DeliveryFormatSchema.optional(),
  resolution: DeliveryResolutionSchema.optional(),
  fps: z.number().int().min(12).max(120).optional(),
  aspect: DeliveryAspectSchema.optional(),
  maxDurationSec: z.number().min(5).max(3600).optional(),
  thumbnails: z.boolean().optional(),
  /** The brand bug (docs/design/brand-kits.md#a-projects-brand); default: the project's brand says. */
  bug: z.boolean().optional(),
});

/** Localization (docs/design/localization.md#surfaces). */
export const LocalizeInputSchema = z.object({
  language: LanguageCodeSchema,
  dub: z.boolean().optional(),
  lipSync: z.boolean().optional(),
});
export const TranslationUpdateInputSchema = z.object({
  shotId: IdSchema,
  index: z.number().int().nonnegative(),
  text: z.string().min(1).max(2000),
});

/** Post audio (docs/design/post-audio.md#surfaces). */
export const ScoreInputSchema = z.object({ direction: z.string().max(300).optional() });

/** Storyboard (docs/design/storyboard.md#surfaces). */
export const StoryboardGenerateInputSchema = z.object({ sceneIds: z.array(IdSchema).max(50).optional() });
export const BoardApproveInputSchema = z.object({ approved: z.boolean() });
export const ReorderShotsInputSchema = z.object({ shotIds: z.array(IdSchema).min(1).max(200) });
export const AnimaticInputSchema = z.object({
  musicResourceId: IdSchema.optional(),
  captions: z.boolean().optional(),
});
export const ScriptFormatSchema = z.enum(['fountain', 'fdx', 'pdf']);
/** A screenplay file by URI (https or data) or as text (uploads use multipart `file`). */
export const ImportScreenplayInputSchema = z.union([
  z.object({ uri: z.string().min(1).max(30_000_000), replace: z.boolean().optional() }),
  z.object({
    text: z.string().min(1).max(5_000_000),
    format: ScriptFormatSchema.optional(),
    filename: z.string().max(300).optional(),
    replace: z.boolean().optional(),
  }),
]);

export const RestoreInputSchema = z.object({
  commit: z.string().min(4),
  paths: z.array(z.string()).optional(),
});

export const ApproveInputSchema = z.object({ gate: z.string().min(1) });
export const ReopenInputSchema = z.object({ stage: z.string().min(1) });
export const OverrideInputSchema = z.object({ reason: z.string().min(3).max(1000) });

/** Accounts (docs/design/accounts.md#surfaces). */
export const ProjectAccessInputSchema = z.object({
  visibility: z.enum(['private', 'studio']).optional(),
  members: z
    .array(z.object({ email: z.string().email().max(320), role: z.enum(['reviewer', 'editor', 'director']) }))
    .max(500)
    .optional(),
});
export const TokenCreateInputSchema = z.object({
  name: z.string().min(1).max(100),
  role: z.enum(['reviewer', 'editor', 'director']),
  projectIds: z.array(IdSchema).max(200).optional(),
  expiresInDays: z.number().int().min(1).max(3650).optional(),
});
export const UserUpdateInputSchema = z.object({
  studioRole: z.enum(['admin', 'member']).optional(),
  disabled: z.boolean().optional(),
});
export const AuditQueryInputSchema = z.object({
  since: z.string().max(40).optional(),
  until: z.string().max(40).optional(),
  projectId: IdSchema.optional(),
  actor: z.string().max(128).optional(),
  type: z
    .enum([
      'auth.login',
      'auth.logout',
      'auth.failed',
      'auth.denied',
      'token.created',
      'token.revoked',
      'user.updated',
      'project.access',
      'project.approval',
    ])
    .optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional(),
});

/** Review (docs/design/review.md#surfaces). */
export const CommentCreateInputSchema = z.object({
  target: CommentTargetSchema,
  at: z.number().nonnegative().nullable().optional(),
  annotation: AnnotationSchema.nullable().optional(),
  body: z.string().trim().min(1).max(4000),
});
export const CommentReplyInputSchema = z.object({ body: z.string().trim().min(1).max(4000) });
export const CommentStatusInputSchema = z.object({ status: z.enum(['open', 'resolved']) });
export const ReviewCreateInputSchema = z.object({
  title: z.string().trim().min(1).max(200),
  target: ReviewTargetSchema,
  gate: z.string().max(100).nullable().optional(),
  required: z.number().int().min(1).max(50).optional(),
  link: z
    .object({ expiresInDays: z.number().int().min(1).max(365).optional() })
    .nullable()
    .optional(),
});
export const ReviewDecisionInputSchema = z.object({
  decision: z.enum(['approve', 'changes']),
  note: z.string().max(2000).optional(),
});
/** Guests name themselves on every call. */
export const GuestInputSchema = z.object({ name: z.string().trim().min(1).max(80) });
