import { z } from 'zod';
import { ID_PATTERN } from '../ids';

export const IdSchema = z.string().regex(ID_PATTERN, 'invalid id');
export const IsoDateSchema = z.string().min(10);

export const ActorKindSchema = z.enum(['user', 'agent', 'system', 'webdav']);
export type ActorKind = z.infer<typeof ActorKindSchema>;

const ActorBase = z.object({
  kind: ActorKindSchema,
  id: z.string().min(1).max(128),
  name: z.string().max(200).optional(),
});
export const ActorSchema = ActorBase.extend({
  onBehalfOf: ActorBase.optional(),
});
export type Actor = z.infer<typeof ActorSchema>;

export const SYSTEM_ACTOR: Actor = { kind: 'system', id: 'rideo', name: 'Rideo' };

export function actorLabel(actor: Actor): string {
  const base = actor.name ?? actor.id;
  return actor.onBehalfOf ? `${base} (for ${actor.onBehalfOf.name ?? actor.onBehalfOf.id})` : base;
}

export function sameActor(a: Actor, b: Actor): boolean {
  return a.kind === b.kind && a.id === b.id;
}

export const MediaPathSchema = z
  .string()
  .min(1)
  .max(400)
  .regex(/^media\/[a-z0-9._/-]+$/i, 'media paths live under media/')
  .refine(
    (p) => !p.split('/').some((seg) => seg === '..' || seg === '.' || seg === ''),
    'invalid media path',
  );

export const MediaRefSchema = z.object({
  path: MediaPathSchema,
  hash: z.string().regex(/^[0-9a-f]{64}$/),
  mime: z.string().min(3).max(100),
  size: z.number().int().nonnegative(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  durationSec: z.number().nonnegative().optional(),
  hasAudio: z.boolean().optional(),
  fps: z.number().positive().optional(),
  proxy: z.object({ path: MediaPathSchema, mime: z.string() }).optional(),
  poster: z.object({ path: MediaPathSchema, mime: z.string() }).optional(),
});
export type MediaRef = z.infer<typeof MediaRefSchema>;

export const AspectRatioSchema = z.enum(['16:9', '9:16', '1:1', '4:3', '21:9']);
export type AspectRatio = z.infer<typeof AspectRatioSchema>;

export const ASPECT_RESOLUTIONS: Record<AspectRatio, { width: number; height: number }> = {
  '16:9': { width: 1280, height: 720 },
  '9:16': { width: 720, height: 1280 },
  '1:1': { width: 1024, height: 1024 },
  '4:3': { width: 1024, height: 768 },
  '21:9': { width: 1680, height: 720 },
};

export const TimeRangeSchema = z.object({ start: z.number().nonnegative(), end: z.number().nonnegative() });
export type TimeRange = z.infer<typeof TimeRangeSchema>;

/** Stable error codes shared by REST problem details, MCP errors and job records. */
export const ERROR_CODES = [
  'validation_error',
  'not_found',
  'conflict',
  'character_not_locked',
  'character_locked',
  'consistency_gate',
  'gate_unmet',
  'timeline_op_invalid',
  'gateway_error',
  'llm_invalid_output',
  'llm_error',
  'storage_error',
  'media_error',
  'unauthorized',
  'forbidden',
  'cancelled',
  'internal_error',
] as const;
export const ErrorCodeSchema = z.enum(ERROR_CODES);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;
