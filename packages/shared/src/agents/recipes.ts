import { z } from 'zod';
import { IsoDateSchema } from '../schemas/common';
import { AuthorSchema } from '../schemas/review';
import { withArticle } from '../util/text';

/**
 * Recipes (docs/design/agents.md#recipes): named, parameterized sequences of tool calls that run on the server for
 * any project of the studio, each run acting only on the project it runs in.
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

/**
 * The tools a recipe may not use (docs/design/agents.md#recipes): a recipe runs as a job, and a job does not carry the
 * studio-level permissions of whoever started it (the library's `publish` and `manage`, and the projects it may read),
 * so the library would act as the studio. The library tools that change the library or a project through it, and those
 * that read the studio library or where its items are used across every project, are left to the Library page, REST
 * and MCP. `library_status` stays: it reads only the run's project, which the run was allowed to read. Tool → what it
 * does, for the refusal.
 */
export const RECIPE_REFUSED_TOOLS: Readonly<Record<string, string>> = {
  library_list: 'lists the studio library',
  library_get: 'reads a studio library item and its versions',
  library_uses: "finds where a library item is used across the studio's projects",
  library_save: 'saves to the studio library',
  library_update: 'changes a library item',
  library_apply: 'changes a project from the studio library',
  library_detach: "unlinks a project's entity from the studio library or removes its 3D pin",
};

/** Why a recipe step may not call a tool, or null when it may: checked when a recipe is saved, run and its job runs. */
export function recipeToolRefusal(tool: string): string | null {
  if (tool === 'recipe_run') return 'recipes do not run recipes';
  if (!Object.hasOwn(RECIPE_REFUSED_TOOLS, tool)) return null;
  return (
    `recipes may not use ${tool}, which ${RECIPE_REFUSED_TOOLS[tool]} (a recipe's job runs without its caller's ` +
    'library permissions): use the Library page, REST or MCP directly'
  );
}

/** The first step that calls a tool recipes may not use, as `step N: why`, or null when every step may run. */
export function recipeStepsRefusal(steps: readonly { tool: string }[]): string | null {
  for (const [k, step] of steps.entries()) {
    const why = recipeToolRefusal(step.tool);
    if (why) return `step ${k + 1}: ${why}`;
  }
  return null;
}

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
      throw new RecipeParamsError(
        `${p.name} must be ${p.type === 'ids' ? 'a list of ids' : withArticle(p.type)}`,
      );
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

/**
 * The argument a step names its project by (docs/design/agents.md#recipes). A recipe acts only on the project it runs
 * in, so every step's tool must take one and the step must give it that project, `{{projectId}}`. No tool takes
 * another argument that names a project (the server's recipe tests check its tools for one).
 */
export const RECIPE_PROJECT_ARG = 'projectId';
const RUN_PROJECT = '{{projectId}}';

/** A run that steps are checked against: the project it runs in and its parameters, defaults filled in. */
export interface RecipeRunScope {
  projectId: string;
  params: Record<string, unknown>;
}

type ProjectStep = Pick<RecipeStep, 'tool' | 'args' | 'forEach'>;

/** The roots of the placeholders anywhere in a value: `steps` for `{{steps.0.id}}`. */
function placeholderRoots(value: unknown, roots = new Set<string>()): Set<string> {
  if (typeof value === 'string') for (const m of value.matchAll(PLACEHOLDER)) roots.add(m[1]!.split('.')[0]!);
  else if (Array.isArray(value)) for (const v of value) placeholderRoots(v, roots);
  else if (value && typeof value === 'object')
    for (const v of Object.values(value)) placeholderRoots(v, roots);
  return roots;
}

/** A step's projectId as a refusal quotes it. */
function shown(value: unknown): string {
  if (value === undefined) return 'missing';
  let text: string;
  try {
    text = JSON.stringify(value) ?? String(value);
  } catch {
    text = String(value);
  }
  return text.length > 80 ? `${text.slice(0, 79)}…` : text;
}

function elsewhere(k: number, tool: string, value: unknown, project: string): string {
  return (
    `step ${k + 1} (${tool}): ${RECIPE_PROJECT_ARG} is ${shown(value)}: it must be ${project}, ` +
    'the project the recipe runs in'
  );
}

function projectOf(args: Record<string, unknown>): unknown {
  return Object.hasOwn(args, RECIPE_PROJECT_ARG) ? args[RECIPE_PROJECT_ARG] : undefined;
}

/**
 * The projects a step names on a run, filled in as its job will fill them (the run's project over a parameter of that
 * name, each item of a `forEach` over a parameter); none yet when they read an earlier step's result, which the job
 * checks before the step runs.
 */
function runTargets(step: ProjectStep, value: unknown, run: RecipeRunScope): unknown[] {
  const roots = placeholderRoots(value);
  if (roots.has('steps')) return [];
  const scope: Record<string, unknown> = { ...run.params, projectId: run.projectId };
  if (!roots.has('item') || !step.forEach) return [fillPlaceholders(value, { ...scope, item: undefined })];
  const listRoots = placeholderRoots(step.forEach);
  if (listRoots.has('steps') || listRoots.has('item')) return [];
  const items = fillPlaceholders(step.forEach, scope);
  // a forEach that is not a list is the job's to refuse
  return Array.isArray(items) ? items.map((item) => fillPlaceholders(value, { ...scope, item })) : [];
}

/**
 * Why a step does not act on the project its recipe runs in, or null (docs/design/agents.md#recipes). `takesProject`
 * says whether the step's tool takes a projectId: one that takes none acts on the studio and is refused (undefined, a
 * tool the registry does not have, is left to the other checks). Without `run` (a recipe being saved) the step's
 * projectId must be `{{projectId}}`, or another placeholder (a parameter, `{{item}}`, an earlier step's result), which
 * is checked when the recipe runs; a missing or literal one is refused. With `run` (a run starting, or its job before
 * the first step) the run's parameters and project are filled in, and every value the step will take must be the run's
 * project; one read from an earlier step's result is checked by the job before the step (`recipeStepTargetRefusal`).
 */
export function recipeStepProjectRefusal(
  step: ProjectStep,
  k: number,
  takesProject: boolean | undefined,
  run?: RecipeRunScope,
): string | null {
  if (takesProject === undefined) return null;
  if (!takesProject)
    return (
      `step ${k + 1}: recipes may not use ${step.tool}, which takes no ${RECIPE_PROJECT_ARG}: ` +
      'a recipe acts only on the project it runs in'
    );
  const value = projectOf(step.args);
  if (!run) {
    if (value === RUN_PROJECT || (value !== undefined && placeholderRoots(value).size > 0)) return null;
    return elsewhere(k, step.tool, value, RUN_PROJECT);
  }
  // a value left out (or filled in with nothing) is missing, and refused as well
  for (const target of runTargets(step, value, run))
    if (target !== run.projectId) return elsewhere(k, step.tool, target, run.projectId);
  return null;
}

/** The first step that does not act on the project its recipe runs in (`recipeStepProjectRefusal`), or null. */
export function recipeProjectRefusal(
  steps: readonly ProjectStep[],
  takesProject: (tool: string) => boolean | undefined,
  run?: RecipeRunScope,
): string | null {
  for (const [k, step] of steps.entries()) {
    const why = recipeStepProjectRefusal(step, k, takesProject(step.tool), run);
    if (why) return why;
  }
  return null;
}

/**
 * Why a step, its placeholders filled in as its job is about to run it, would act on another project than the run's,
 * or null (docs/design/agents.md#recipes): checked by the job before each step and each item of a `forEach`, which
 * catches a projectId read from an earlier step's result.
 */
export function recipeStepTargetRefusal(
  k: number,
  tool: string,
  args: Record<string, unknown>,
  projectId: string,
): string | null {
  const value = projectOf(args);
  return value === projectId ? null : elsewhere(k, tool, value, projectId);
}
