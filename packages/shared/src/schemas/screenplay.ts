import { z } from 'zod';
import { IdSchema } from './common';

export const StyleBibleSchema = z.object({
  visual: z.string().max(2000).default(''),
  palette: z.string().max(1000).default(''),
  camera: z.string().max(1000).default(''),
  lighting: z.string().max(1000).default(''),
});
export type StyleBible = z.infer<typeof StyleBibleSchema>;

export const OutlineBeatSchema = z.object({
  id: IdSchema,
  index: z.number().int().nonnegative(),
  title: z.string().max(200).default(''),
  summary: z.string().max(4000),
  estDurationSec: z.number().positive().max(3600),
  sceneId: IdSchema.nullable().default(null),
});
export type OutlineBeat = z.infer<typeof OutlineBeatSchema>;

export const DialogueLineSchema = z.object({
  characterId: IdSchema.nullable().default(null),
  character: z.string().max(200),
  line: z.string().max(4000),
  parenthetical: z.string().max(400).optional(),
});
export type DialogueLine = z.infer<typeof DialogueLineSchema>;

export const SceneSchema = z.object({
  id: IdSchema,
  index: z.number().int().nonnegative(),
  beatId: IdSchema.nullable().default(null),
  heading: z.string().max(300),
  location: z.string().max(300).default(''),
  timeOfDay: z.string().max(60).default(''),
  summary: z.string().max(4000).default(''),
  action: z.string().max(20000).default(''),
  dialogue: z.array(DialogueLineSchema).default([]),
  characterIds: z.array(IdSchema).default([]),
  estDurationSec: z.number().positive().max(3600),
});
export type Scene = z.infer<typeof SceneSchema>;

export const ScreenplaySchema = z.object({
  title: z.string().max(200),
  logline: z.string().max(1000).default(''),
  synopsis: z.string().max(20000).default(''),
  genre: z.string().max(200).default(''),
  tone: z.string().max(200).default(''),
  language: z.string().max(16).default('en'),
  style: StyleBibleSchema,
  outline: z.array(OutlineBeatSchema).default([]),
  scenes: z.array(SceneSchema).default([]),
  ended: z.boolean().default(true),
});
export type Screenplay = z.infer<typeof ScreenplaySchema>;

export function outlineDuration(sp: Pick<Screenplay, 'outline'>): number {
  return sp.outline.reduce((sum, b) => sum + b.estDurationSec, 0);
}

export function nextUnwrittenBeats(sp: Screenplay, count: number): OutlineBeat[] {
  return [...sp.outline]
    .sort((a, b) => a.index - b.index)
    .filter((b) => !b.sceneId)
    .slice(0, count);
}
