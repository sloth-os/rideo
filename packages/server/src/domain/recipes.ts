import {
  type Actor,
  authorOf,
  BUILTIN_RECIPES,
  hasPlaceholder,
  type Job,
  newId,
  type Recipe,
  type RecipeInput,
  RecipeParamsError,
  RecipeSchema,
  recipeParams,
} from '@rideo/shared';
import { z } from 'zod';
import { currentPrincipal } from '../auth/context';
import { AppError, invalid, notFound } from '../errors';
import { strongest, type ToolRegistry } from '../mcp/registry';
import { Service } from './base';

/**
 * Recipes (docs/design/agents.md#recipes): Rideo's built-in ones and the studio's, stored as JSON on the storage
 * backend; a run is a `recipe.run` job through the MCP tool registry.
 */
export class RecipeService extends Service {
  private readonly studio = new Map<string, Recipe>();
  private loaded: Promise<void> | null = null;
  private registry: () => ToolRegistry = () => new Map();

  /** The tool registry (set when the MCP server is built; docs/design/agents.md#recipes). */
  setTools(registry: () => ToolRegistry): void {
    this.registry = registry;
  }

  tools(): ToolRegistry {
    return this.registry();
  }

  private load(): Promise<void> {
    this.loaded ??= (async () => {
      const dir = this.deps.layout.recipesDir();
      for (const e of await this.deps.storage.list(dir).catch(() => [])) {
        if (!e.name.endsWith('.json')) continue;
        const buf = await this.deps.storage.read(`${dir}/${e.name}`).catch(() => null);
        if (!buf) continue;
        try {
          const r = RecipeSchema.parse(JSON.parse(buf.toString('utf8')));
          this.studio.set(r.id, r);
        } catch (err) {
          this.deps.log.warn({ file: e.name, err: (err as Error).message }, 'skipping an invalid recipe');
        }
      }
    })();
    return this.loaded;
  }

  async list(): Promise<Recipe[]> {
    await this.load();
    return [...BUILTIN_RECIPES, ...[...this.studio.values()].sort((a, b) => a.name.localeCompare(b.name))];
  }

  async get(id: string): Promise<Recipe> {
    await this.load();
    const r = BUILTIN_RECIPES.find((b) => b.id === id) ?? this.studio.get(id);
    if (!r) throw notFound(`recipe ${id}`);
    return r;
  }

  /** Checks that every step names a tool and that its arguments without placeholders fit the tool. */
  private validate(input: RecipeInput): void {
    const tools = this.tools();
    const params = new Set(['projectId', ...input.params.map((p) => p.name)]);
    input.steps.forEach((step, k) => {
      const def = tools.get(step.tool);
      if (!def) throw invalid(`step ${k + 1}: unknown tool ${step.tool}`);
      if (step.tool === 'recipe_run') throw invalid(`step ${k + 1}: recipes do not run recipes`);
      const fixed = Object.fromEntries(Object.entries(step.args).filter(([, v]) => !hasPlaceholder(v)));
      const r = z.object(def.shape).partial().safeParse(fixed);
      if (!r.success)
        throw invalid(
          `step ${k + 1} (${step.tool}): ${r.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`,
        );
      const named = JSON.stringify(step.args).match(/\{\{([a-zA-Z0-9_]+)/g) ?? [];
      for (const ref of [...named, ...(step.forEach ? [step.forEach] : [])]) {
        const name = ref.replace(/^\{\{/, '').replace(/\}\}$/, '').split('.')[0]!;
        if (!params.has(name) && name !== 'item' && name !== 'steps')
          throw invalid(`step ${k + 1}: {{${name}}} is not a parameter of the recipe`);
      }
    });
  }

  async create(actor: Actor, input: RecipeInput): Promise<Recipe> {
    await this.load();
    this.validate(input);
    const recipe = RecipeSchema.parse({
      ...input,
      id: newId('recipe'),
      builtin: false,
      createdBy: authorOf(actor),
      createdAt: new Date().toISOString(),
    });
    await this.deps.storage.write(this.deps.layout.recipe(recipe.id), JSON.stringify(recipe, null, 2), {
      contentType: 'application/json',
    });
    this.studio.set(recipe.id, recipe);
    this.deps.log.info({ recipeId: recipe.id, steps: recipe.steps.length }, 'recipe created');
    return recipe;
  }

  /** Deletes a studio recipe: its author's, or any for an admin. */
  async remove(actor: Actor, id: string): Promise<void> {
    const r = await this.get(id);
    if (r.builtin) throw new AppError('forbidden', 'Built-in recipes cannot be deleted');
    const p = currentPrincipal();
    const mine = r.createdBy.id === actor.id || (!!p && r.createdBy.id === p.user.id);
    if (p && p.kind !== 'studio' && !p.admin && !mine)
      throw new AppError('forbidden', 'Only its author or an admin deletes a recipe');
    await this.deps.storage.delete(this.deps.layout.recipe(id));
    this.studio.delete(id);
  }

  /** Starts a run: parameters checked, and the caller's role against the strongest step. */
  async run(
    actor: Actor,
    projectId: string,
    recipeId: string,
    given: Record<string, unknown> = {},
  ): Promise<Job> {
    await this.deps.projects.existing(projectId);
    const recipe = await this.get(recipeId);
    let params: Record<string, unknown>;
    try {
      params = recipeParams(recipe, given);
    } catch (err) {
      if (err instanceof RecipeParamsError) throw invalid(err.message);
      throw err;
    }
    const tools = this.tools();
    const missing = recipe.steps.find((s) => !tools.has(s.tool));
    if (missing) throw invalid(`unknown tool ${missing.tool}`);
    const p = currentPrincipal();
    if (p)
      await this.deps.accounts.authorize(
        p,
        projectId,
        strongest(['project.edit', ...recipe.steps.map((s) => tools.get(s.tool)!.permission)]),
      );
    return this.deps.jobs.enqueue({
      projectId,
      kind: 'recipe.run',
      params: { recipeId, params },
      actor,
      branch: await this.branchOf(projectId),
    });
  }
}
