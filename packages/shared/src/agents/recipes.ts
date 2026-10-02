import { z } from 'zod';
import { IsoDateSchema } from '../schemas/common';
import { AuthorSchema } from '../schemas/review';

/**
 * Recipes (docs/design/agents.md#recipes): named, parameterized sequences of tool calls that run on the server for
 * any project of the studio.
 */

export const RecipeParamSchema = z.object({
  name: z
    .string()
    .regex(
      /^[a-z][a-zA-Z0-9_]{0,39}$/,
      'parameter names are identifiers (a letter, then letters, digits, _)',
    ),
  type: z.enum(['string', 'number', 'boolean', 'id', 'ids']),
  description: z.string().max(300).optional(),
  default: z.unknown().optional(),
  required: z.boolean().default(false),
});
export type RecipeParam = z.infer<typeof RecipeParamSchema>;

export const RecipeStepSchema = z.object({
  tool: z.string().regex(/^[a-z][a-z0-9_]{1,60}$/),
  args: z.record(z.string(), z.unknown()).default({}),
  /** `{{param}}` of a list: the step runs once per element (`{{item}}`). */
  forEach: z
    .string()
    .regex(/^\{\{[a-zA-Z0-9_.]+\}\}$/)
    .optional(),
  /** Wait for the jobs the step returns before the next step. */
  wait: z.boolean().default(false),
  label: z.string().max(200).optional(),
});
export type RecipeStep = z.infer<typeof RecipeStepSchema>;

export const RecipeInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().max(2000).default(''),
  params: z.array(RecipeParamSchema).max(20).default([]),
  steps: z.array(RecipeStepSchema).min(1).max(50),
});
export type RecipeInput = z.infer<typeof RecipeInputSchema>;

export const RecipeSchema = RecipeInputSchema.extend({
  /** `rcp_…` for studio recipes, `builtin:<name>` for Rideo's own. */
  id: z.string().regex(/^(rcp_[0-9a-z]{10,32}|builtin:[a-z_]+)$/),
  builtin: z.boolean().default(false),
  createdBy: AuthorSchema,
  createdAt: IsoDateSchema,
});
export type Recipe = z.infer<typeof RecipeSchema>;

const RIDEO = { kind: 'system' as const, id: 'rideo', name: 'Rideo' };
const BUILTIN_AT = '2026-10-02T00:00:00.000Z';

/** Rideo's own recipes (read-only). */
export const BUILTIN_RECIPES: Recipe[] = [
  {
    id: 'builtin:storyboard_to_animatic',
    builtin: true,
    name: 'Storyboard to animatic',
    description: 'Board every shot, approve the boards and build the animatic.',
    params: [],
    steps: [
      {
        tool: 'storyboard_generate',
        args: { projectId: '{{projectId}}' },
        wait: true,
        label: 'Board every shot',
      },
      {
        tool: 'storyboard_approve_all',
        args: { projectId: '{{projectId}}' },
        wait: false,
        label: 'Approve the boards',
      },
      {
        tool: 'animatic_build',
        args: { projectId: '{{projectId}}' },
        wait: false,
        label: 'Build the animatic',
      },
    ],
    createdBy: RIDEO,
    createdAt: BUILTIN_AT,
  },
  {
    id: 'builtin:cast_voices',
    builtin: true,
    name: 'Cast every voice',
    description:
      'Design a voice for every speaking character without one, pick the first candidate and lock it.',
    params: [],
    steps: [
      {
        tool: 'voices_cast',
        args: { projectId: '{{projectId}}', pick: true, lock: true },
        wait: true,
        label: 'Cast the voices',
      },
    ],
    createdBy: RIDEO,
    createdAt: BUILTIN_AT,
  },
  {
    id: 'builtin:dub',
    builtin: true,
    name: 'Dub and export a language',
    description:
      'Translate the cut, dub it with the characters’ voices, lip-sync the close-ups and export the variant.',
    params: [
      { name: 'language', type: 'string', description: 'BCP 47, e.g. es or pt-BR', required: true },
      { name: 'lipSync', type: 'boolean', default: true, required: false },
    ],
    steps: [
      {
        tool: 'localize',
        args: { projectId: '{{projectId}}', language: '{{language}}', dub: true, lipSync: '{{lipSync}}' },
        wait: true,
        label: 'Translate and dub',
      },
      {
        tool: 'export_render',
        args: { projectId: '{{projectId}}', language: '{{language}}', dubbed: true, captions: 'sidecar' },
        wait: false,
        label: 'Export the variant',
      },
    ],
    createdBy: RIDEO,
    createdAt: BUILTIN_AT,
  },
  {
    id: 'builtin:clip_variations',
    builtin: true,
    name: 'Variations of a clip',
    description: 'Generate variations of every shot of a clip to compare and pick from.',
    params: [
      { name: 'clipId', type: 'id', required: true },
      { name: 'count', type: 'number', default: 2, required: false },
    ],
    steps: [
      {
        tool: 'batch_variations',
        args: { projectId: '{{projectId}}', clipId: '{{clipId}}', count: '{{count}}' },
        wait: true,
        label: 'Generate the variations',
      },
    ],
    createdBy: RIDEO,
    createdAt: BUILTIN_AT,
  },
];

export class RecipeParamsError extends Error {}

/** The parameters of a run: defaults filled, types checked, required ones present. */
export function recipeParams(
  recipe: Pick<Recipe, 'params'>,
  given: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const p of recipe.params) {
    const v = given[p.name] ?? p.default;
    if (v === undefined || v === null || v === '') {
      if (p.required) throw new RecipeParamsError(`${p.name} is required`);
      continue;
    }
    const ok =
      p.type === 'number'
        ? typeof v === 'number' && Number.isFinite(v)
        : p.type === 'boolean'
          ? typeof v === 'boolean'
          : p.type === 'ids'
            ? Array.isArray(v) && v.every((x) => typeof x === 'string')
            : typeof v === 'string';
    if (!ok)
      throw new RecipeParamsError(`${p.name} must be ${p.type === 'ids' ? 'a list of ids' : `a ${p.type}`}`);
    out[p.name] = v;
  }
  for (const k of Object.keys(given))
    if (!recipe.params.some((p) => p.name === k)) throw new RecipeParamsError(`unknown parameter ${k}`);
  return out;
}

const PLACEHOLDER = /\{\{([a-zA-Z0-9_.]+)\}\}/g;

function lookup(scope: Record<string, unknown>, path: string): unknown {
  return path
    .split('.')
    .reduce<unknown>(
      (v, k) => (v && typeof v === 'object' ? (v as Record<string, unknown>)[k] : undefined),
      scope,
    );
}

/**
 * Fills the placeholders of a value: a string that is only a placeholder takes the value as it is; in a longer string
 * it is interpolated. Unknown placeholders become undefined (and the key is dropped from objects).
 */
export function fillPlaceholders(value: unknown, scope: Record<string, unknown>): unknown {
  if (typeof value === 'string') {
    const whole = /^\{\{([a-zA-Z0-9_.]+)\}\}$/.exec(value);
    if (whole) return lookup(scope, whole[1]!);
    return value.replace(PLACEHOLDER, (_, path: string) => {
      const v = lookup(scope, path);
      return v === undefined || v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
    });
  }
  if (Array.isArray(value)) return value.map((v) => fillPlaceholders(v, scope));
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .map(([k, v]) => [k, fillPlaceholders(v, scope)] as const)
        .filter(([, v]) => v !== undefined),
    );
  return value;
}

/** Whether a value holds a placeholder anywhere (its static parts can be validated when it does not). */
export function hasPlaceholder(value: unknown): boolean {
  if (typeof value === 'string') return /\{\{[a-zA-Z0-9_.]+\}\}/.test(value);
  if (Array.isArray(value)) return value.some(hasPlaceholder);
  if (value && typeof value === 'object') return Object.values(value).some(hasPlaceholder);
  return false;
}
