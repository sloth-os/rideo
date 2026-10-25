import { z } from 'zod';
import {
  FeedbackFramingSchema,
  FeedbackMovementSchema,
  FeedbackSettingsPatchSchema,
  HEARD_DIMENSION_IDS,
  RetrospectiveAreaSchema,
} from './feedback';

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
  /** Prompt version 2: the state at the scene's start (docs/design/continuity.md#storytelling). */
  continuity: str(1000),
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
    .array(
      z.object({
        title: str(200),
        summary: z.string().min(1).max(4000),
        estDurationSec: num(90),
        /** Prompt version 2: setup, inciting, complication, midpoint, crisis, climax or resolution. */
        purpose: str(60),
      }),
    )
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
  /** Prompt version 2: a real focal length and what the last frame shows (docs/design/continuity.md#shot-planning). */
  lensMm: z.coerce.number().int().min(8).max(800).optional().catch(undefined),
  endState: str(1000),
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

const JudgeScoreSchema = z.object({
  score: z.coerce.number().min(0).max(1).catch(0),
  issues: z.array(z.string().max(500)).catch([]).default([]),
});

/** The objects of a list a model filled with strays too ("Sammy is absent"): the strays dropped. */
const objectsOnly = (v: unknown) => (Array.isArray(v) ? v.filter((x) => x && typeof x === 'object') : v);

export const JudgeOutputSchema = z.object({
  frames: z
    .array(
      z.object({
        index: z.coerce.number().int().nonnegative(),
        characters: z.preprocess(
          objectsOnly,
          z.array(
            z.object({
              /** Models sometimes name the character instead; the server maps a name to its id. */
              characterId: z.string().optional().catch(undefined),
              name: z.string().max(200).optional().catch(undefined),
              present: z.boolean().catch(false),
              identityScore: z.coerce.number().min(0).max(1).catch(0),
              outfitScore: z.coerce.number().min(0).max(1).optional().catch(undefined),
              issues: z.array(z.string().max(500)).catch([]).default([]),
            }),
          ),
        ),
        /** Present when the request listed elements (rule E4). */
        elements: z
          .preprocess(
            objectsOnly,
            z.array(
              z.object({
                elementId: z.string().optional().catch(undefined),
                name: z.string().max(200).optional().catch(undefined),
                present: z.boolean().catch(false),
                score: z.coerce.number().min(0).max(1).catch(0),
                issues: z.array(z.string().max(500)).catch([]).default([]),
              }),
            ),
          )
          .catch([])
          .default([]),
        /** Quality checks (docs/design/continuity.md#quality-checks-in-the-gate): asked with `qualityChecks`. */
        physics: JudgeScoreSchema.optional().catch(undefined),
        /** Against the scene reference frame, when one was sent. */
        continuity: JudgeScoreSchema.optional().catch(undefined),
        /** Cast members of `absent` seen in the frame (quality checks). */
        extras: z.array(z.string().max(80)).max(10).catch([]).default([]),
        /** Any other person or animal in the frame, briefly (quality checks). */
        others: z.array(z.string().max(200)).max(10).catch([]).default([]),
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

/** Where the main subject is in each frame (docs/design/finishing.md#auto-reframe-and-cut-downs). */
export const FocusOutputSchema = z.object({
  frames: z
    .array(
      z.object({
        index: z.coerce.number().int().nonnegative(),
        x: z.coerce.number().min(0).max(1).catch(0.5),
        y: z.coerce.number().min(0).max(1).catch(0.5),
      }),
    )
    .max(20),
});
export type FocusOutput = z.infer<typeof FocusOutputSchema>;

/** The best thumbnails among candidate frames, best first (docs/design/finishing.md#thumbnails). */
export const ThumbnailPickOutputSchema = z.object({
  picks: z
    .array(z.object({ index: z.coerce.number().int().nonnegative(), reason: str(300) }))
    .min(1)
    .max(10),
});
export type ThumbnailPickOutput = z.infer<typeof ThumbnailPickOutputSchema>;

export const LLM_TASKS = [
  'media.describe',
  'screenplay.generate',
  'screenplay.extend',
  'clip.plan',
  'character.describe',
  'consistency.judge',
  'voice.judge',
  'sound.check',
  'footage.analyze',
  'score.plan',
  'sfx.plan',
  'dialogue.translate',
  'reframe.focus',
  'thumbnail.pick',
  'frame.caption',
  'feedback.scene',
  'feedback.film',
] as const;
export type LlmTaskId = (typeof LLM_TASKS)[number];

export const TASK_MARKER_PATTERN = /rideo-task:\s*([a-z.]+)/;

/**
 * Task inputs: the server sends `INPUT:\n<json>` as the first user text, followed by labelled images.
 * The shapes are part of the server ↔ LLM contract (the mock gateway reads them).
 */
/** What prompt version 2 adds to the writing tasks (docs/design/continuity.md#storytelling). */
export interface DialogueDirection {
  /** A CEFR level and what it means for the writer; absent when the project sets none. */
  dialogueLevel?: string;
  dialogueGuidance?: string;
  /** The longest line, in words, that a shot of the video model can speak. */
  maxWordsPerLine?: number;
}

export interface ScreenplayGenerateInput extends DialogueDirection {
  prompt: string;
  targetDurationSec: number;
  pilotDurationSec: number;
  language: string;
  aspectRatio: string;
  attachments: { kind: 'image' | 'video'; description: string }[];
}

export interface ScreenplayExtendInput extends DialogueDirection {
  title: string;
  logline: string;
  synopsis: string;
  language: string;
  characters: { name: string; summary: string }[];
  /** Existing locations and props: reuse these names. */
  locations: { name: string; description: string }[];
  props: { name: string; description: string }[];
  previousScenes: { index: number; heading: string; summary: string }[];
  beats: { index: number; title: string; summary: string; estDurationSec: number; purpose?: string }[];
  /** Version 2: the user's brief, the last written scene in full and the beats after the requested ones. */
  brief?: string;
  lastScene?: {
    heading: string;
    timeOfDay: string;
    continuity: string;
    summary: string;
    action: string;
    dialogue: { character: string; line: string }[];
  };
  upcomingBeats?: { index: number; title: string; summary: string; purpose?: string }[];
}

export interface ClipPlanInput extends DialogueDirection {
  scene: {
    heading: string;
    summary: string;
    action: string;
    dialogue: { character: string; line: string }[];
    estDurationSec: number;
    location: { name: string; description: string } | null;
    props: { name: string; description: string }[];
    /** Version 2. */
    timeOfDay?: string;
    continuity?: string;
  };
  characters: { name: string; summary: string }[];
  style: string;
  limits: { minDurationSec: number; maxDurationSec: number };
  targetDurationSec: number;
  /** Version 2: the brief, the words a shot can hold and the last shot of the previous scene. */
  brief?: string;
  maxWordsPerShot?: number;
  previousShot?: { description: string; endState: string } | null;
  /** What a new plan must do (a feedback recommendation, docs/design/feedback.md#actions). */
  direction?: string;
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
  /** Score physics (and continuity against the scene reference frame) too. */
  qualityChecks?: boolean;
  sceneReference?: boolean;
  /** Cast members who must not be in the frame, with how they look (quality checks). */
  absent?: { name: string; look: string }[];
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

export interface FocusInput {
  shot: string;
  characters: string[];
  frames: { index: number; t: number }[];
}

export interface ThumbnailPickInput {
  title: string;
  count: number;
  frames: { index: number; t: number }[];
}

/** Labels of the frames sent to the reframe and thumbnail tasks. */
export const FOCUS_FRAME_LABEL = 'Frame';

export const INPUT_PREFIX = 'INPUT:\n';
export const JUDGE_SCENE_REFERENCE_LABEL = 'Scene reference frame';
export const FEEDBACK_STRIP_LABEL = 'Shot strip';
export const VOICE_REFERENCE_LABEL = 'Reference voice for character';
export const TAKE_AUDIO_LABEL = 'Take audio';
/** The take or the scene as a video with its sound, for the audio-visual model. */
export const TAKE_VIDEO_LABEL = 'Take video with sound';
export const SCENE_VIDEO_LABEL = 'Scene video with sound';
export const JUDGE_REFERENCE_LABEL = 'Reference images for character';
export const JUDGE_ELEMENT_REFERENCE_LABEL = 'Reference images for element';
export const JUDGE_FRAME_LABEL = 'Candidate frame';

/** A yes or no from a model, which may write it as a string. */
const flag = z
  .preprocess((v) => (typeof v === 'string' ? /^\s*(true|yes|1)\s*$/i.test(v) : Boolean(v)), z.boolean())
  .catch(false);

/**
 * A sound check answered as a list (omni models do not always keep to JSON mode): the whole answer as its only item,
 * or just the utterances.
 */
function soundAnswer(v: unknown): unknown {
  if (!Array.isArray(v)) return v;
  const first = v[0] as Record<string, unknown> | undefined;
  if (v.length === 1 && first && typeof first === 'object' && ('speech' in first || 'music' in first))
    return first;
  return { speech: v };
}

/**
 * What the audio-visual model heard in a take (`sound.check`, docs/design/continuity.md#quality-checks-in-the-gate):
 * lenient, `soundVerdict` judges it.
 */
const SoundCheckObjectSchema = z.object({
  speech: z
    .array(
      z.object({
        text: z.string().max(1000).catch(''),
        /** The cast name of who speaks, null when it is unclear. */
        speaker: z.string().max(80).nullable().optional().catch(null),
        voice: z.string().max(120).optional().catch(undefined),
        lipSync: z.coerce.number().min(0).max(1).optional().catch(undefined),
      }),
    )
    .max(30)
    .catch([])
    .default([]),
  music: flag.default(false),
  sounds: z.array(z.string().max(120)).max(12).catch([]).default([]),
  score: z.coerce.number().min(0).max(1).optional().catch(undefined),
  issues: z.array(z.string().max(300)).max(10).catch([]).default([]),
});
export const SoundCheckOutputSchema = z.preprocess(soundAnswer, SoundCheckObjectSchema);
export type SoundCheckOutput = z.infer<typeof SoundCheckObjectSchema>;

export interface SoundCheckInput {
  shot: { description: string; action: string; place: string; durationSec: number };
  /** The shot's lines, each with its speaker's voice; empty for a shot without lines. */
  lines: { character: string; voice: string; line: string }[];
  cast: { name: string; voice: string }[];
  /** Takes may carry music (otherwise the film's score comes later). */
  music: boolean;
}

/** Feedback tasks (docs/design/feedback.md#how-a-film-is-watched): lenient, the server assembles the document. */
const score10 = z.coerce.number().min(0).max(10).optional().catch(undefined);
export const VisionScoresSchema = z
  .object({
    storytelling: score10,
    continuity: score10,
    character: score10,
    temporal: score10,
    physics: score10,
    realism: score10,
    cinematography: score10,
    editing: score10,
    /** Scored only by the audio-visual model, which hears the scene. */
    dialogue: score10,
    sound: score10,
  })
  .catch({})
  .default({});
export type VisionScores = z.infer<typeof VisionScoresSchema>;
const visionDimension = z.enum(HEARD_DIMENSION_IDS).catch('cinematography');
const optionalText = (max: number) => z.string().max(max).optional().catch(undefined);

export const LlmFeedbackActionSchema = z
  .object({
    kind: z.enum(['regenerate_shot', 'replan_scene', 'settings', 'note']).catch('note'),
    description: optionalText(4000),
    action: optionalText(4000),
    negativePrompt: optionalText(2000),
    framing: FeedbackFramingSchema.optional().catch(undefined),
    movement: FeedbackMovementSchema.optional().catch(undefined),
    direction: optionalText(2000),
    /** The film call names a scene by its number. */
    scene: z.coerce.number().int().nonnegative().optional().catch(undefined),
    settings: FeedbackSettingsPatchSchema.optional().catch(undefined),
  })
  .catch({ kind: 'note' });
export type LlmFeedbackAction = z.infer<typeof LlmFeedbackActionSchema>;

export const FeedbackSceneOutputSchema = z.object({
  scores: VisionScoresSchema,
  summary: str(3000),
  strengths: z.array(z.string().max(400)).max(10).catch([]).default([]),
  issues: z
    .array(
      z.object({
        shot: z.coerce.number().int().nonnegative().optional().catch(undefined),
        dimension: visionDimension,
        severity: z.enum(['critical', 'major', 'minor']).catch('minor').default('minor'),
        title: z.string().min(1).max(200),
        detail: str(1500),
        at: z.coerce.number().min(0).max(1).optional().catch(undefined),
        /** Seconds from the start of the scene's video, when the model watched one. */
        time: z.coerce.number().min(0).optional().catch(undefined),
      }),
    )
    .max(40)
    .catch([])
    .default([]),
  recommendations: z
    .array(
      z.object({
        shot: z.coerce.number().int().nonnegative().optional().catch(undefined),
        dimension: visionDimension,
        priority: z.coerce.number().int().min(1).max(3).catch(2).default(2),
        title: z.string().min(1).max(200),
        detail: str(2000),
        action: LlmFeedbackActionSchema.optional().catch(undefined),
      }),
    )
    .max(30)
    .catch([])
    .default([]),
  /** Every line heard in the scene's video: seconds from its start, the speaker, the words. */
  transcript: z
    .array(
      z.object({
        time: z.coerce.number().min(0).catch(0),
        speaker: z.string().max(80).catch(''),
        text: z.string().max(1000).catch(''),
      }),
    )
    .max(200)
    .catch([])
    .default([]),
});
export type FeedbackSceneOutput = z.infer<typeof FeedbackSceneOutputSchema>;

export const FeedbackFilmOutputSchema = z.object({
  scores: VisionScoresSchema,
  summary: str(6000),
  strengths: z.array(z.string().max(400)).max(12).catch([]).default([]),
  recommendations: z
    .array(
      z.object({
        dimension: visionDimension,
        priority: z.coerce.number().int().min(1).max(3).catch(2).default(2),
        title: z.string().min(1).max(200),
        detail: str(3000),
        scenes: z.array(z.coerce.number().int().nonnegative()).max(100).catch([]).default([]),
        action: LlmFeedbackActionSchema.optional().catch(undefined),
      }),
    )
    .max(20)
    .catch([])
    .default([]),
  lessons: z
    .array(
      z.object({
        area: RetrospectiveAreaSchema.catch('quality'),
        title: z.string().min(1).max(200),
        detail: str(2000),
      }),
    )
    .max(12)
    .catch([])
    .default([]),
});
export type FeedbackFilmOutput = z.infer<typeof FeedbackFilmOutputSchema>;

export interface FeedbackFilmBrief {
  title: string;
  logline: string;
  genre: string;
  tone: string;
  style: string;
  dialogueLevel: string | null;
}

export interface FeedbackSceneInput {
  film: FeedbackFilmBrief;
  scene: {
    number: number;
    heading: string;
    location: string;
    timeOfDay: string;
    continuity: string;
    summary: string;
    action: string;
    dialogue: { character: string; line: string }[];
    start: number;
    end: number;
  };
  previousScene: { heading: string; summary: string } | null;
  nextScene: { heading: string; summary: string } | null;
  cast: { name: string; look: string }[];
  shots: {
    index: number;
    label: string;
    start: number;
    end: number;
    description: string;
    action: string;
    camera: string;
    dialogue: { character: string; line: string }[];
    characters: string[];
    /** Where the shot is in the scene's video (seconds from its start), when the model watches one. */
    video?: { from: number; to: number };
    take: {
      consistency: string;
      score: number | null;
      quality: { passed: boolean; physics: number | null; continuity: number | null; jumps: number } | null;
    } | null;
  }[];
  /** Measured inside the scene, in seconds of the export. */
  signals: {
    unexpectedCuts: number[];
    frozen: { start: number; end: number }[];
    black: { start: number; end: number }[];
  };
  stripCount: number;
  /** The model gets the scene as a video with its sound instead of strips. */
  listening: boolean;
}

export interface FeedbackFilmInput {
  film: FeedbackFilmBrief & { synopsis: string; targetDurationSec: number | null; durationSec: number };
  outline: { title: string; purpose: string; summary: string }[];
  scenes: {
    number: number;
    heading: string;
    start: number;
    end: number;
    scores: VisionScores;
    summary: string;
    issues: { severity: string; dimension: string; title: string }[];
  }[];
  signals: {
    unexpectedCuts: number;
    frozen: number;
    black: number;
    silences: number;
    rushedLines: number;
    framingRuns: number;
    /** Lines heard against the script's (listening feedback); null when the film was not heard. */
    dialogue: { lines: number; heard: number } | null;
    loudness: { target: string; integratedLufs: number | null } | null;
  };
  run: {
    shots: number;
    takes: { passed: number; unverified: number; overridden: number; qualityFailed: number };
    costUsd: number | null;
    videoSeconds: number;
    discardedVideoSeconds: number;
    llmRetries: number;
    failedJobs: number;
  };
}
