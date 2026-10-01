import { z } from 'zod';
import { CameraMoveIdSchema } from '../directing';
import { ActorSchema, IdSchema, IsoDateSchema, MediaRefSchema } from './common';
import { ContentCredentialsStampSchema } from './provenance';

export const ConsistencyStatusSchema = z.enum(['passed', 'failed', 'unverified']);
export type ConsistencyStatus = z.infer<typeof ConsistencyStatusSchema>;

export const CharacterVerdictSchema = z.object({
  characterId: IdSchema,
  present: z.boolean(),
  score: z.number().min(0).max(1),
  issues: z.array(z.string().max(500)).default([]),
});
export type CharacterVerdict = z.infer<typeof CharacterVerdictSchema>;

export const ElementVerdictSchema = z.object({
  elementId: IdSchema,
  present: z.boolean(),
  score: z.number().min(0).max(1),
  issues: z.array(z.string().max(500)).default([]),
});
export type ElementVerdict = z.infer<typeof ElementVerdictSchema>;

/** Speaker check of a native-audio take (rule V4, docs/design/dialogue.md#rules). */
export const VoiceVerdictSchema = z.object({
  characterId: IdSchema,
  present: z.boolean(),
  score: z.number().min(0).max(1),
  issues: z.array(z.string().max(500)).default([]),
});
export type VoiceVerdict = z.infer<typeof VoiceVerdictSchema>;

export const ConsistencyReportSchema = z.object({
  status: ConsistencyStatusSchema,
  judge: z.string(),
  threshold: z.number().min(0).max(1),
  score: z.number().min(0).max(1),
  attempts: z.number().int().nonnegative(),
  checkedAt: IsoDateSchema,
  characters: z.array(CharacterVerdictSchema).default([]),
  /** Locations and props, when the project judges elements (rule E4, docs/design/elements.md). */
  elements: z.array(ElementVerdictSchema).default([]),
  /** Speakers, when a native-audio take is checked against the voice locks (rule V4). */
  voices: z.array(VoiceVerdictSchema).default([]),
  frames: z.array(MediaRefSchema).default([]),
  note: z.string().max(1000).optional(),
});
export type ConsistencyReport = z.infer<typeof ConsistencyReportSchema>;

export const CameraSchema = z.object({
  framing: z
    .enum([
      'extreme_wide',
      'wide',
      'medium',
      'medium_close',
      'close_up',
      'extreme_close_up',
      'over_shoulder',
      'pov',
      'insert',
    ])
    .default('medium'),
  movement: z
    .enum([
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
    ])
    .default('static'),
  /** Directing controls (docs/design/directing.md): focal length, f-number and a move of the library. */
  lensMm: z.number().int().min(8).max(800).nullish(),
  aperture: z.number().min(0.7).max(32).nullish(),
  move: CameraMoveIdSchema.nullish(),
});
export type Camera = z.infer<typeof CameraSchema>;

/** The frame a shot starts on: the keyframe, board or previous shot (`auto`) or an image resource. */
export const StartFrameSchema = z.object({
  mode: z.enum(['auto', 'resource']).default('auto'),
  resourceId: IdSchema.nullable().default(null),
});
export type StartFrame = z.infer<typeof StartFrameSchema>;

/** The frame a shot ends on (`last_frame`): none, a generated and verified keyframe, or an image resource. */
export const EndFrameSchema = z.object({
  mode: z.enum(['none', 'generate', 'resource']).default('none'),
  description: z.string().max(2000).default(''),
  resourceId: IdSchema.nullable().default(null),
});
export type EndFrame = z.infer<typeof EndFrameSchema>;

/** A video resource whose motion, poses or camera movement the shot follows (`reference_video`). */
export const MotionReferenceSchema = z.object({
  resourceId: IdSchema,
  mode: z.enum(['motion', 'pose', 'camera']).default('motion'),
});
export type MotionReference = z.infer<typeof MotionReferenceSchema>;

/** One spoken line of a take, placed on the take's own clock (seconds). */
export const TakeLineSchema = z.object({
  index: z.number().int().nonnegative(),
  characterId: IdSchema.nullable(),
  text: z.string().max(2000),
  start: z.number().nonnegative(),
  end: z.number().nonnegative(),
  media: MediaRefSchema.nullable().default(null),
});
export type TakeLine = z.infer<typeof TakeLineSchema>;

/** The dialogue of a take (docs/design/dialogue.md#take-audio). */
export const TakeAudioSchema = z.object({
  mode: z.enum(['tts', 'native']),
  /** The TTS mix of the shot's lines (tts mode): the Dialogue track plays it. */
  dialogue: MediaRefSchema.nullable().default(null),
  lines: z.array(TakeLineSchema).default([]),
  /** Voice lock versions of the speakers at generation time (rule V6). */
  voiceLocks: z.record(z.string(), z.number().int().nonnegative()).default({}),
  /** How the lips follow the TTS mix: conditioned on it, a lip-sync pass, or not at all. */
  lipSync: z.enum(['conditioned', 'pass', 'none']).default('none'),
});
export type TakeAudio = z.infer<typeof TakeAudioSchema>;

/** Video-to-video edits of a take (docs/design/take-editing.md#edits-takeedit). */
export const EditKindSchema = z.enum(['restyle', 'relight', 'replace', 'angle', 'remove']);
export type EditKind = z.infer<typeof EditKindSchema>;

/** The parent of a derived take: an edit or an extension of another take of the shot. */
export const TakeDerivationSchema = z.object({
  takeId: IdSchema,
  op: z.enum(['edit', 'extend']),
  kind: EditKindSchema.optional(),
  instruction: z.string().max(1000).optional(),
  seconds: z.number().positive().max(10).optional(),
});
export type TakeDerivation = z.infer<typeof TakeDerivationSchema>;

export const TakeSchema = z.object({
  id: IdSchema,
  createdAt: IsoDateSchema,
  jobId: IdSchema.optional(),
  keyframe: MediaRefSchema.nullable().default(null),
  video: MediaRefSchema.nullable().default(null),
  lastFrame: MediaRefSchema.nullable().default(null),
  request: z.object({
    imageModel: z.string().optional(),
    videoModel: z.string().optional(),
    prompt: z.string().max(20000),
    seed: z.number().int(),
    durationSec: z.number().positive(),
    /** `storyboard`: the shot's approved board frame (docs/design/storyboard.md#video-pass). */
    firstFrameSource: z.enum(['keyframe', 'previous_shot', 'storyboard', 'resource', 'none']),
    referenceCount: z.number().int().nonnegative(),
    /** What the model was given as the last frame and as the reference video (docs/design/directing.md). */
    lastFrameSource: z.enum(['generated', 'resource']).nullable().default(null),
    motionReference: MotionReferenceSchema.nullable().default(null),
  }),
  gatewayTaskIds: z.array(z.string()).default([]),
  /** The generated end frame (`endFrame.mode: generate`). */
  endKeyframe: MediaRefSchema.nullable().default(null),
  /** 0 for a single take; 1… for the takes of a variations request. */
  variation: z.number().int().nonnegative().default(0),
  derivedFrom: TakeDerivationSchema.nullable().default(null),
  consistency: ConsistencyReportSchema,
  characterLocks: z.record(z.string(), z.number().int().nonnegative()).default({}),
  /** Lock versions of the shot's elements at generation time (rule E6). */
  elementLocks: z.record(z.string(), z.number().int().nonnegative()).default({}),
  audio: TakeAudioSchema.nullable().default(null),
  watermarkId: z.string().nullable().default(null),
  /** C2PA manifest embedded in the take's video (docs/design/provenance.md#takes). */
  contentCredentials: ContentCredentialsStampSchema.nullable().default(null),
  override: z
    .object({ actor: ActorSchema, reason: z.string().min(3).max(1000), at: IsoDateSchema })
    .nullable()
    .default(null),
  durationSec: z.number().nonnegative().optional(),
  error: z.string().max(2000).optional(),
});
export type Take = z.infer<typeof TakeSchema>;

/** The storyboard frame of a shot (docs/design/storyboard.md#board-frames). */
export const ShotBoardSchema = z.object({
  keyframe: MediaRefSchema,
  createdAt: IsoDateSchema,
  jobId: IdSchema.optional(),
  request: z.object({
    imageModel: z.string().optional(),
    prompt: z.string().max(20000),
    seed: z.number().int(),
    referenceCount: z.number().int().nonnegative(),
  }),
  /** Hash of the keyframe prompt it was generated from: editing the shot makes it outdated. */
  promptHash: z.string(),
  consistency: ConsistencyReportSchema,
  characterLocks: z.record(z.string(), z.number().int().nonnegative()).default({}),
  elementLocks: z.record(z.string(), z.number().int().nonnegative()).default({}),
  /** The shot's TTS dialogue, for the animatic and the video pass. */
  audio: TakeAudioSchema.nullable().default(null),
  gatewayTaskIds: z.array(z.string()).default([]),
  approved: z.boolean().default(false),
  approvedAt: IsoDateSchema.nullable().default(null),
  approvedBy: ActorSchema.nullable().default(null),
});
export type ShotBoard = z.infer<typeof ShotBoardSchema>;

export const ShotStatusSchema = z.enum([
  'planned',
  'queued',
  'generating',
  'ready',
  'needs_review',
  'failed',
]);
export type ShotStatus = z.infer<typeof ShotStatusSchema>;

export const ShotSchema = z.object({
  id: IdSchema,
  index: z.number().int().nonnegative(),
  description: z.string().max(4000),
  action: z.string().max(4000).default(''),
  camera: CameraSchema.default({ framing: 'medium', movement: 'static' }),
  characterIds: z.array(IdSchema).default([]),
  /** The location and the props/styles in the shot (docs/design/elements.md). */
  elementIds: z.array(IdSchema).default([]),
  wardrobe: z.record(z.string(), IdSchema).default({}),
  dialogue: z.array(z.object({ characterId: IdSchema.nullable(), line: z.string().max(2000) })).default([]),
  durationSec: z.number().positive().max(60),
  continuity: z.enum(['cut', 'continuous']).default('cut'),
  promptOverride: z.string().max(8000).nullable().default(null),
  negativePrompt: z.string().max(2000).nullable().default(null),
  startFrame: StartFrameSchema.default({ mode: 'auto', resourceId: null }),
  endFrame: EndFrameSchema.default({ mode: 'none', description: '', resourceId: null }),
  motionReference: MotionReferenceSchema.nullable().default(null),
  /** A fixed seed for the keyframes and the video (null: derived from the shot and the cast, R3). */
  seed: z.number().int().min(0).max(4294967295).nullable().default(null),
  status: ShotStatusSchema.default('planned'),
  takes: z.array(TakeSchema).default([]),
  selectedTakeId: IdSchema.nullable().default(null),
  board: ShotBoardSchema.nullable().default(null),
  lastError: z.string().max(2000).nullable().default(null),
});
export type Shot = z.infer<typeof ShotSchema>;

export const ClipStatusSchema = z.enum(['planned', 'generating', 'review', 'approved']);
export type ClipStatus = z.infer<typeof ClipStatusSchema>;

export const ClipSchema = z.object({
  id: IdSchema,
  index: z.number().int().nonnegative(),
  sceneId: IdSchema.nullable(),
  title: z.string().max(300),
  status: ClipStatusSchema.default('planned'),
  shots: z.array(ShotSchema).default([]),
  approvedAt: IsoDateSchema.nullable().default(null),
  approvedBy: ActorSchema.nullable().default(null),
  notes: z.string().max(4000).default(''),
});
export type Clip = z.infer<typeof ClipSchema>;

export function clipPlannedDuration(clip: Pick<Clip, 'shots'>): number {
  return clip.shots.reduce((sum, s) => sum + s.durationSec, 0);
}

export function selectedTake(shot: Shot): Take | undefined {
  return shot.takes.find((t) => t.id === shot.selectedTakeId);
}
