import { z } from 'zod';
import { TransitionTypeSchema } from './analysis';
import { IdSchema, MediaRefSchema } from './common';

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

export const EffectsSchema = z.object({
  brightness: z.number().min(-1).max(1).optional(),
  contrast: z.number().min(0).max(2).optional(),
  saturation: z.number().min(0).max(3).optional(),
});
export type Effects = z.infer<typeof EffectsSchema>;

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
});
export type TextStyle = z.infer<typeof TextStyleSchema>;

export const TextItemSchema = z.object({
  id: IdSchema,
  kind: z.literal('text'),
  start: z.number().nonnegative(),
  duration: z.number().positive().max(3600),
  text: z.string().min(1).max(500),
  style: TextStyleSchema,
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
  items: z.array(ItemSchema).default([]),
});
export type Track = z.infer<typeof TrackSchema>;

export const TimelineSchema = z.object({
  version: z.literal(1),
  fps: z.number().int().min(12).max(60),
  width: z.number().int().min(64).max(4096),
  height: z.number().int().min(64).max(4096),
  tracks: z.array(TrackSchema).min(1),
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
      kind: z.enum(['audio', 'text']),
      name: z.string().min(1).max(100),
    }),
  }),
  z.object({ op: z.literal('remove_track'), trackId: IdSchema }),
  z.object({
    op: z.literal('set_track'),
    trackId: IdSchema,
    name: z.string().min(1).max(100).optional(),
    muted: z.boolean().optional(),
    volume: z.number().min(0).max(2).optional(),
  }),
  z.object({ op: z.literal('replace_source'), itemId: IdSchema, source: SourceSchema }),
  z.object({
    op: z.literal('set_output'),
    fps: z.number().int().min(12).max(60).optional(),
    width: z.number().int().min(64).max(4096).optional(),
    height: z.number().int().min(64).max(4096).optional(),
  }),
]);
export type TimelineOp = z.infer<typeof TimelineOpSchema>;
