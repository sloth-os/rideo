import { z } from 'zod';
import { TransformSchema } from '../timeline/keyframes';
import { RampSchema } from '../timeline/ramp';
import { TransitionTypeSchema } from './analysis';
import { IdSchema, MediaPathSchema, MediaRefSchema } from './common';

export const SourceSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('take'),
    clipId: IdSchema,
    shotId: IdSchema,
    takeId: IdSchema,
    media: MediaRefSchema,
  }),
  z.object({ type: z.literal('media'), media: MediaRefSchema, resourceId: IdSchema.optional() }),
]);
export type Source = z.infer<typeof SourceSchema>;

export const TransitionSchema = z.object({
  type: TransitionTypeSchema,
  duration: z.number().positive().max(5),
});
export type Transition = z.infer<typeof TransitionSchema>;

/** The stem an audio source belongs to (docs/design/post-audio.md#stems). */
export const AudioRoleSchema = z.enum(['dialogue', 'music', 'effects']);
export type AudioRole = z.infer<typeof AudioRoleSchema>;
export const AUDIO_ROLES = AudioRoleSchema.options;

/** Spans of speech in source time (seconds of the media), the keys of ducking (docs/design/post-audio.md#ducking). */
export const SpeechSpansSchema = z
  .array(z.tuple([z.number().nonnegative(), z.number().nonnegative()]))
  .max(2000);
export type SpeechSpans = z.infer<typeof SpeechSpansSchema>;

export const DuckingSchema = z.object({
  enabled: z.boolean().default(true),
  /** Music gain under speech. */
  depthDb: z.number().min(-40).max(0).default(-12),
  attackSec: z.number().min(0.01).max(2).default(0.25),
  releaseSec: z.number().min(0.05).max(4).default(0.6),
});
export type Ducking = z.infer<typeof DuckingSchema>;

export const MixSchema = z.object({ ducking: DuckingSchema.default(DuckingSchema.parse({})) });
export type Mix = z.infer<typeof MixSchema>;

/** Where the main subject is at a time (normalized frame coordinates; docs/design/finishing.md#auto-reframe-and-cut-downs). */
export const FocusPointSchema = z.object({
  t: z.number().nonnegative(),
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
});
export type FocusPoint = z.infer<typeof FocusPointSchema>;

export const EffectsSchema = z.object({
  brightness: z.number().min(-1).max(1).optional(),
  contrast: z.number().min(0).max(2).optional(),
  saturation: z.number().min(0).max(3).optional(),
});
export type Effects = z.infer<typeof EffectsSchema>;

/** A 3D LUT on an item (docs/design/editor.md#luts): a `.cube` resource, mixed in by `intensity`. */
export const ItemLutSchema = z.object({
  media: MediaRefSchema,
  resourceId: IdSchema.optional(),
  intensity: z.number().min(0).max(1).default(1),
});
export type ItemLut = z.infer<typeof ItemLutSchema>;

/** A segmentation matte used as the item's alpha (docs/design/editor.md#segmentation-masks-remove-the-background). */
export const ItemMaskSchema = z.object({
  /** A grayscale video, white where the subject is. */
  media: MediaRefSchema,
  /** Source seconds where the matte starts. */
  offset: z.number().nonnegative().default(0),
  subject: z.string().min(1).max(200),
  invert: z.boolean().default(false),
  model: z.string().max(200).nullable().default(null),
});
export type ItemMask = z.infer<typeof ItemMaskSchema>;

export const VideoItemSchema = z.object({
  id: IdSchema,
  kind: z.literal('video'),
  source: SourceSchema,
  start: z.number().nonnegative(),
  in: z.number().nonnegative(),
  out: z.number().positive(),
  speed: z.number().min(0.25).max(4).default(1),
  volume: z.number().min(0).max(2).default(1),
  muted: z.boolean().optional(),
  fadeIn: z.number().nonnegative().max(10).optional(),
  fadeOut: z.number().nonnegative().max(10).optional(),
  transitionIn: TransitionSchema.nullable().optional(),
  effects: EffectsSchema.optional(),
  label: z.string().max(200).optional(),
  speech: SpeechSpansSchema.optional(),
  /** Reframed to the timeline's aspect around the subject (source seconds; docs/design/finishing.md). */
  crop: z.object({ focus: z.array(FocusPointSchema).min(1).max(50) }).optional(),
  /** Position, scale, rotation and opacity over the item's time (docs/design/editor.md#multitrack-transforms-and-keyframes). */
  transform: TransformSchema.optional(),
  /** A speed ramp over source seconds; replaces `speed` (docs/design/editor.md#speed-ramps). */
  ramp: RampSchema.optional(),
  lut: ItemLutSchema.optional(),
  mask: ItemMaskSchema.optional(),
});
export type VideoItem = z.infer<typeof VideoItemSchema>;

export const AudioItemSchema = z.object({
  id: IdSchema,
  kind: z.literal('audio'),
  source: SourceSchema,
  start: z.number().nonnegative(),
  in: z.number().nonnegative(),
  out: z.number().positive(),
  volume: z.number().min(0).max(2).default(1),
  fadeIn: z.number().nonnegative().max(30).optional(),
  fadeOut: z.number().nonnegative().max(30).optional(),
  label: z.string().max(200).optional(),
  speech: SpeechSpansSchema.optional(),
});
export type AudioItem = z.infer<typeof AudioItemSchema>;

export const TextStyleSchema = z.object({
  /** `label`: small boxed corner text (the disclosure label, docs/design/provenance.md#disclosure-label). */
  preset: z.enum(['title', 'lower_third', 'caption', 'label']),
  position: z.enum(['top', 'center', 'bottom']).optional(),
  align: z.enum(['left', 'center', 'right']).optional(),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .optional(),
  size: z.number().int().min(8).max(200).optional(),
  /** Captions revealed word by word or one word at a time (docs/design/localization.md#captions-and-word-timing). */
  animate: z.enum(['none', 'build', 'pop']).optional(),
});
export type TextStyle = z.infer<typeof TextStyleSchema>;

/** A word of a caption: its character range in the text and its time relative to the item. */
export const CaptionWordSchema = z.object({
  from: z.number().int().nonnegative(),
  to: z.number().int().positive(),
  start: z.number().nonnegative(),
  end: z.number().nonnegative(),
});
export type CaptionWord = z.infer<typeof CaptionWordSchema>;

export const TextItemSchema = z.object({
  id: IdSchema,
  kind: z.literal('text'),
  start: z.number().nonnegative(),
  duration: z.number().positive().max(3600),
  text: z.string().min(1).max(500),
  style: TextStyleSchema,
  words: z.array(CaptionWordSchema).max(200).optional(),
});
export type TextItem = z.infer<typeof TextItemSchema>;

export const ItemSchema = z.discriminatedUnion('kind', [VideoItemSchema, AudioItemSchema, TextItemSchema]);
export type Item = z.infer<typeof ItemSchema>;

export const TrackSchema = z.object({
  id: IdSchema,
  kind: z.enum(['video', 'audio', 'text']),
  name: z.string().min(1).max(100),
  muted: z.boolean().optional(),
  volume: z.number().min(0).max(2).optional(),
  /** The stem of the track's sound (audio tracks, and the primary video track's own sound). */
  role: AudioRoleSchema.optional(),
  items: z.array(ItemSchema).default([]),
});
export type Track = z.infer<typeof TrackSchema>;

export const TimelineSchema = z.object({
  version: z.literal(1),
  fps: z.number().int().min(12).max(60),
  width: z.number().int().min(64).max(4096),
  height: z.number().int().min(64).max(4096),
  tracks: z.array(TrackSchema).min(1),
  /** How the soundtrack is mixed; absent on older cuts (no ducking). */
  mix: MixSchema.optional(),
});
export type Timeline = z.infer<typeof TimelineSchema>;

const VideoItemInput = VideoItemSchema.partial({ id: true, start: true, speed: true, volume: true });
const AudioItemInput = AudioItemSchema.partial({ id: true, volume: true });
const TextItemInput = TextItemSchema.partial({ id: true });

export const TimelineOpSchema = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('insert'),
    trackId: IdSchema,
    item: z.discriminatedUnion('kind', [VideoItemInput, AudioItemInput, TextItemInput]),
    index: z.number().int().nonnegative().optional(),
  }),
  z.object({ op: z.literal('remove'), itemId: IdSchema }),
  z.object({
    op: z.literal('move'),
    itemId: IdSchema,
    index: z.number().int().nonnegative().optional(),
    start: z.number().nonnegative().optional(),
  }),
  z.object({
    op: z.literal('trim'),
    itemId: IdSchema,
    in: z.number().nonnegative().optional(),
    out: z.number().positive().optional(),
  }),
  z.object({ op: z.literal('split'), itemId: IdSchema, at: z.number().nonnegative() }),
  z.object({ op: z.literal('set_transition'), itemId: IdSchema, transition: TransitionSchema.nullable() }),
  z.object({ op: z.literal('set_speed'), itemId: IdSchema, speed: z.number().min(0.25).max(4) }),
  z.object({
    op: z.literal('set_volume'),
    itemId: IdSchema,
    volume: z.number().min(0).max(2),
    muted: z.boolean().optional(),
  }),
  z.object({
    op: z.literal('set_fades'),
    itemId: IdSchema,
    fadeIn: z.number().nonnegative().max(30).optional(),
    fadeOut: z.number().nonnegative().max(30).optional(),
  }),
  z.object({ op: z.literal('set_effects'), itemId: IdSchema, effects: EffectsSchema }),
  z.object({ op: z.literal('add_text'), trackId: IdSchema.optional(), item: TextItemInput }),
  z.object({
    op: z.literal('update_text'),
    itemId: IdSchema,
    text: z.string().min(1).max(500).optional(),
    style: TextStyleSchema.optional(),
    start: z.number().nonnegative().optional(),
    duration: z.number().positive().max(3600).optional(),
  }),
  z.object({
    op: z.literal('add_track'),
    track: z.object({
      id: IdSchema.optional(),
      /** `video`: an overlay track above the others (docs/design/editor.md#timeline-model). */
      kind: z.enum(['audio', 'text', 'video']),
      name: z.string().min(1).max(100),
      role: AudioRoleSchema.optional(),
    }),
  }),
  z.object({ op: z.literal('remove_track'), trackId: IdSchema }),
  z.object({
    op: z.literal('set_track'),
    trackId: IdSchema,
    name: z.string().min(1).max(100).optional(),
    muted: z.boolean().optional(),
    volume: z.number().min(0).max(2).optional(),
    role: AudioRoleSchema.optional(),
  }),
  z.object({ op: z.literal('set_mix'), ducking: DuckingSchema.partial() }),
  z.object({
    op: z.literal('set_caption_style'),
    style: TextStyleSchema.pick({ animate: true, position: true, size: true, color: true }),
  }),
  z.object({ op: z.literal('replace_source'), itemId: IdSchema, source: SourceSchema }),
  z.object({ op: z.literal('set_transform'), itemId: IdSchema, transform: TransformSchema.nullable() }),
  z.object({ op: z.literal('set_ramp'), itemId: IdSchema, ramp: RampSchema.nullable() }),
  z.object({ op: z.literal('set_lut'), itemId: IdSchema, lut: ItemLutSchema.nullable() }),
  z.object({ op: z.literal('set_mask'), itemId: IdSchema, mask: ItemMaskSchema.nullable() }),
  /** Cuts source ranges of a media file out of the primary track (docs/design/editor.md#transcript-editing). */
  z.object({
    op: z.literal('remove_ranges'),
    media: MediaPathSchema,
    ranges: z
      .array(z.tuple([z.number().nonnegative(), z.number().nonnegative()]))
      .min(1)
      .max(2000),
  }),
  z.object({
    op: z.literal('set_output'),
    fps: z.number().int().min(12).max(60).optional(),
    width: z.number().int().min(64).max(4096).optional(),
    height: z.number().int().min(64).max(4096).optional(),
  }),
]);
export type TimelineOp = z.infer<typeof TimelineOpSchema>;
