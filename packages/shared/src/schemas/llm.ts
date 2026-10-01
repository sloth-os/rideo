import { z } from 'zod';

/**
 * Structured LLM task outputs (docs/design/ai-gateway.md#structured-tasks). Lenient by design: real models
 * drift, so numbers are coerced, enums fall back and optional members default. The server normalizes
 * these into documents; the mock gateway validates its fixtures against the same schemas.
 */
const str = (max = 4000) => z.string().max(max).catch('').default('');
const num = (fallback: number) => z.coerce.number().catch(fallback).default(fallback);

export const LlmIdentitySchema = z.object({
  age: str(100),
  gender: str(100),
  ethnicity: str(200),
  build: str(200),
  height: str(100),
  face: str(1000),
  hair: str(500),
  eyes: str(300),
  skin: str(300),
  distinguishingMarks: str(1000),
});
export type LlmIdentity = z.infer<typeof LlmIdentitySchema>;

export const LlmWardrobeSchema = z.object({ name: z.string().min(1).max(120), description: str(1000) });

export const LlmCharacterSchema = z.object({
  name: z.string().min(1).max(120),
  role: z
    .enum(['protagonist', 'antagonist', 'supporting', 'minor'])
    .catch('supporting')
    .default('supporting'),
  summary: str(),
  identity: LlmIdentitySchema.catch(LlmIdentitySchema.parse({})).default(LlmIdentitySchema.parse({})),
  wardrobe: z.array(LlmWardrobeSchema).catch([]).default([]),
  personality: str(2000),
  voice: str(1000),
});
export type LlmCharacter = z.infer<typeof LlmCharacterSchema>;

/** A location or prop the writer introduces (docs/design/elements.md). */
export const LlmElementSchema = z.object({ name: z.string().min(1).max(120), description: str(2000) });
export type LlmElement = z.infer<typeof LlmElementSchema>;

export const LlmDialogueSchema = z.object({
  character: z.string().max(200),
  line: z.string().max(4000),
  parenthetical: z.string().max(400).optional().catch(undefined),
});

export const LlmSceneSchema = z.object({
  beatIndex: z.coerce.number().int().nonnegative().optional().catch(undefined),
  heading: z.string().min(1).max(300),
  location: str(300),
  timeOfDay: str(60),
  summary: str(),
  action: str(20000),
  dialogue: z.array(LlmDialogueSchema).catch([]).default([]),
  characters: z.array(z.string().max(120)).catch([]).default([]),
  /** Names of the props in the scene (the location is `location`). */
  props: z.array(z.string().max(120)).catch([]).default([]),
  estDurationSec: num(60),
});
export type LlmScene = z.infer<typeof LlmSceneSchema>;

export const LlmStyleSchema = z.object({
  visual: str(2000),
  palette: str(1000),
  camera: str(1000),
  lighting: str(1000),
});

export const ScreenplayGenerateOutputSchema = z.object({
  title: z.string().min(1).max(200),
  logline: str(1000),
  synopsis: str(20000),
  genre: str(200),
  tone: str(200),
  style: LlmStyleSchema.catch(LlmStyleSchema.parse({})).default(LlmStyleSchema.parse({})),
  characters: z.array(LlmCharacterSchema).min(1).max(20),
  locations: z.array(LlmElementSchema).max(60).catch([]).default([]),
  props: z.array(LlmElementSchema).max(60).catch([]).default([]),
  outline: z
    .array(z.object({ title: str(200), summary: z.string().min(1).max(4000), estDurationSec: num(90) }))
    .min(1)
    .max(400),
  scenes: z.array(LlmSceneSchema).min(1).max(60),
  ended: z.boolean().catch(true).default(true),
});
export type ScreenplayGenerateOutput = z.infer<typeof ScreenplayGenerateOutputSchema>;

export const ScreenplayExtendOutputSchema = z.object({
  scenes: z.array(LlmSceneSchema).min(1).max(30),
  /** Locations and props that first appear in these scenes. */
  locations: z.array(LlmElementSchema).max(30).catch([]).default([]),
  props: z.array(LlmElementSchema).max(30).catch([]).default([]),
});
export type ScreenplayExtendOutput = z.infer<typeof ScreenplayExtendOutputSchema>;

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

export const LlmShotSchema = z.object({
  description: z.string().min(1).max(4000),
  action: str(4000),
  camera: z
    .object({
      framing: z.enum(FRAMINGS).catch('medium').default('medium'),
      movement: z.enum(MOVEMENTS).catch('static').default('static'),
    })
    .catch({ framing: 'medium', movement: 'static' })
    .default({ framing: 'medium', movement: 'static' }),
  characters: z.array(z.string().max(120)).catch([]).default([]),
  durationSec: num(6),
  continuity: z.enum(['cut', 'continuous']).catch('cut').default('cut'),
  dialogue: z
    .array(z.object({ character: z.string().max(200), line: z.string().max(2000) }))
    .catch([])
    .default([]),
  /** Names of the scene's props visible in this shot. */
  props: z.array(z.string().max(120)).catch([]).default([]),
});
export type LlmShot = z.infer<typeof LlmShotSchema>;

export const ClipPlanOutputSchema = z.object({ shots: z.array(LlmShotSchema).min(1).max(60) });
export type ClipPlanOutput = z.infer<typeof ClipPlanOutputSchema>;

export const MediaDescribeOutputSchema = z.object({
  summary: str(4000),
  style: str(1000),
  setting: str(1000),
  people: z
    .array(
      z.object({
        label: str(120),
        description: str(2000),
        identity: LlmIdentitySchema.partial().catch({}).default({}),
      }),
    )
    .catch([])
    .default([]),
});
export type MediaDescribeOutput = z.infer<typeof MediaDescribeOutputSchema>;

export const CharacterDescribeOutputSchema = z.object({
  summary: str(4000),
  identity: LlmIdentitySchema,
  wardrobe: z.array(LlmWardrobeSchema).catch([]).default([]),
});
export type CharacterDescribeOutput = z.infer<typeof CharacterDescribeOutputSchema>;

export const JudgeOutputSchema = z.object({
  frames: z
    .array(
      z.object({
        index: z.coerce.number().int().nonnegative(),
        characters: z.array(
          z.object({
            characterId: z.string(),
            present: z.boolean().catch(false),
            identityScore: z.coerce.number().min(0).max(1).catch(0),
            outfitScore: z.coerce.number().min(0).max(1).optional().catch(undefined),
            issues: z.array(z.string().max(500)).catch([]).default([]),
          }),
        ),
        /** Present when the request listed elements (rule E4). */
        elements: z
          .array(
            z.object({
              elementId: z.string(),
              present: z.boolean().catch(false),
              score: z.coerce.number().min(0).max(1).catch(0),
              issues: z.array(z.string().max(500)).catch([]).default([]),
            }),
          )
          .catch([])
          .default([]),
      }),
    )
    .min(1),
});
export type JudgeOutput = z.infer<typeof JudgeOutputSchema>;

/** Footage suggestions arrive flat ({kind, description, ...params}); the server maps them to EditSuggestion. */
export const LlmSuggestionSchema = z.looseObject({
  kind: z.string(),
  description: str(1000),
  rationale: str(2000),
  confidence: z.coerce.number().min(0).max(1).catch(0.5).default(0.5),
});
export const FootageAnalyzeOutputSchema = z.object({
  summary: str(8000),
  suggestions: z.array(LlmSuggestionSchema).catch([]).default([]),
});
export type FootageAnalyzeOutput = z.infer<typeof FootageAnalyzeOutputSchema>;

/** A composition per cue of the score (docs/design/post-audio.md#score-one-cue-per-scene). */
export const ScorePlanOutputSchema = z.object({
  cues: z
    .array(
      z.object({
        index: z.coerce.number().int().nonnegative(),
        prompt: z.string().min(3).max(800),
        bpm: z.coerce.number().int().min(40).max(220).optional().catch(undefined),
      }),
    )
    .min(1)
    .max(200),
});
export type ScorePlanOutput = z.infer<typeof ScorePlanOutputSchema>;

/** Sound effects planned from the shots' action lines (docs/design/post-audio.md#effects-from-action-lines). */
export const SfxPlanOutputSchema = z.object({
  effects: z
    .array(
      z.object({
        shot: z.coerce.number().int().nonnegative(),
        description: z.string().min(3).max(300),
        at: z.coerce.number().nonnegative().catch(0).default(0),
        durationSec: z.coerce.number().min(0.5).max(22).catch(2).default(2),
        kind: z.enum(['spot', 'ambience']).catch('spot').default('spot'),
      }),
    )
    .max(600)
    .catch([])
    .default([]),
});
export type SfxPlanOutput = z.infer<typeof SfxPlanOutputSchema>;

/** Translated dialogue lines (docs/design/localization.md#translation). */
export const TranslateOutputSchema = z.object({
  lines: z.array(z.object({ key: z.string().max(100), text: z.string().min(1).max(2000) })).max(2000),
});
export type TranslateOutput = z.infer<typeof TranslateOutputSchema>;

export const LLM_TASKS = [
  'media.describe',
  'screenplay.generate',
  'screenplay.extend',
  'clip.plan',
  'character.describe',
  'consistency.judge',
  'voice.judge',
  'footage.analyze',
  'score.plan',
  'sfx.plan',
  'dialogue.translate',
] as const;
export type LlmTaskId = (typeof LLM_TASKS)[number];

export const TASK_MARKER_PATTERN = /rideo-task:\s*([a-z.]+)/;

/**
 * Task inputs: the server sends `INPUT:\n<json>` as the first user text, followed by labelled images.
 * The shapes are part of the server ↔ LLM contract (the mock gateway reads them).
 */
export interface ScreenplayGenerateInput {
  prompt: string;
  targetDurationSec: number;
  pilotDurationSec: number;
  language: string;
  aspectRatio: string;
  attachments: { kind: 'image' | 'video'; description: string }[];
}

export interface ScreenplayExtendInput {
  title: string;
  logline: string;
  synopsis: string;
  language: string;
  characters: { name: string; summary: string }[];
  /** Existing locations and props: reuse these names. */
  locations: { name: string; description: string }[];
  props: { name: string; description: string }[];
  previousScenes: { index: number; heading: string; summary: string }[];
  beats: { index: number; title: string; summary: string; estDurationSec: number }[];
}

export interface ClipPlanInput {
  scene: {
    heading: string;
    summary: string;
    action: string;
    dialogue: { character: string; line: string }[];
    estDurationSec: number;
    location: { name: string; description: string } | null;
    props: { name: string; description: string }[];
  };
  characters: { name: string; summary: string }[];
  style: string;
  limits: { minDurationSec: number; maxDurationSec: number };
  targetDurationSec: number;
}

export interface MediaDescribeInput {
  imageCount: number;
  videoFrameCount: number;
  prompt: string;
}

export interface CharacterDescribeInput {
  name: string;
}

export interface JudgeInput {
  characters: { id: string; name: string; identity: string; referenceCount: number }[];
  /** Locations and props to verify too (rule E4); omitted when the project does not judge elements. */
  elements?: { id: string; kind: string; name: string; description: string; referenceCount: number }[];
  frameCount: number;
  shotDescription: string;
}

export interface FootageAnalyzeInput {
  durationSec: number;
  scenes: { start: number; end: number }[];
  silences: { start: number; end: number }[];
  blackSegments: { start: number; end: number }[];
  loudnessLufs: number | null;
  transcript: { start: number; end: number; text: string }[];
  thumbnailCount: number;
}

/** Speaker check of a native-audio take (rule V4, docs/design/dialogue.md#rules). */
export const VoiceJudgeOutputSchema = z.object({
  speakers: z.array(
    z.object({
      characterId: z.string(),
      present: z.boolean().catch(false),
      score: z.coerce.number().min(0).max(1).catch(0),
      issues: z.array(z.string().max(500)).catch([]).default([]),
    }),
  ),
});
export type VoiceJudgeOutput = z.infer<typeof VoiceJudgeOutputSchema>;

export interface VoiceJudgeInput {
  speakers: { characterId: string; name: string; description: string }[];
  lines: { speaker: string; text: string }[];
}

export interface ScorePlanInput {
  film: { title: string; logline: string; genre: string; tone: string; style: string };
  /** The user's direction for the whole score ('' when none). */
  direction: string;
  cues: {
    index: number;
    durationSec: number;
    heading: string;
    summary: string;
    action: string;
    /** People speak in the scene: keep the cue under the dialogue. */
    dialogue: boolean;
  }[];
}

export interface SfxPlanInput {
  maxPerShot: number;
  shots: { index: number; durationSec: number; description: string; action: string; location: string }[];
}

export interface TranslateInput {
  /** BCP 47 code and English name of the target language. */
  language: string;
  languageName: string;
  film: { title: string; logline: string; tone: string };
  /** Names stay as they are. */
  characters: { name: string; summary: string }[];
  scene: string;
  lines: { key: string; speaker: string; text: string }[];
}

export const INPUT_PREFIX = 'INPUT:\n';
export const VOICE_REFERENCE_LABEL = 'Reference voice for character';
export const TAKE_AUDIO_LABEL = 'Take audio';
export const JUDGE_REFERENCE_LABEL = 'Reference images for character';
export const JUDGE_ELEMENT_REFERENCE_LABEL = 'Reference images for element';
export const JUDGE_FRAME_LABEL = 'Candidate frame';
