import { fillPlaceholders, isTerminalJob, type Job, recipeStepTargetRefusal } from '@rideo/shared';
import { ZodError, z } from 'zod';
import { refuseOtherProjects, refuseSteps } from '../../domain/recipes';
import { AppError, toAppError } from '../../errors';
import type { JobContext } from '../queue';
import type { HandlerDeps } from './common';

/** The jobs a tool returned: a job, a list of them, or objects holding them (`{job}`, `{jobs}`, `{export, job}`). */
function jobsIn(result: unknown): string[] {
  if (!result || typeof result !== 'object') return [];
  if (Array.isArray(result)) return result.flatMap(jobsIn);
  const r = result as Record<string, unknown>;
  if (typeof r.id === 'string' && /^job_/.test(r.id) && typeof r.kind === 'string') return [r.id];
  return [...jobsIn(r.job), ...jobsIn(r.jobs)];
}

/**
 * `recipe.run` (docs/design/agents.md#recipes): the steps in order through the MCP tool registry, as the job's actor,
 * waiting for the jobs of `wait` steps; a failing step stops the recipe. A recipe that calls a tool recipes may not use,
 * or whose steps name another project than the job's (a job queued before the rule or enqueued directly, a recipe file
 * replaced on the storage), fails before any step runs; a step whose projectId an earlier step's result fills in with
 * another project fails before it runs. The job asks no one about the steps' projects: they must be its own.
 */
export async function recipeRun(deps: HandlerDeps, ctx: JobContext) {
  const { recipeId, params } = ctx.job.params as { recipeId: string; params: Record<string, unknown> };
  const projectId = ctx.job.projectId;
  const recipe = await deps.services.recipes.get(recipeId);
  refuseSteps(recipe);
  const tools = deps.services.recipes.tools();
  refuseOtherProjects(recipe, tools, { projectId, params: params ?? {} });
  const scope: Record<string, unknown> = { ...params, projectId, steps: [] as unknown[] };
  const outcomes: { step: number; tool: string; ok: boolean; jobs: string[] }[] = [];
  for (const [k, step] of recipe.steps.entries()) {
    const label = step.label ?? step.tool;
    ctx.progress(k, recipe.steps.length, `${k + 1}/${recipe.steps.length} ${label}`);
    const def = tools.get(step.tool);
    if (!def) throw new AppError('validation_error', `step ${k + 1}: unknown tool ${step.tool}`);
    const items = step.forEach ? fillPlaceholders(step.forEach, scope) : [undefined];
    if (!Array.isArray(items))
      throw new AppError('validation_error', `step ${k + 1}: ${step.forEach} is not a list`);
    const results: unknown[] = [];
    const jobs: string[] = [];
    for (const item of items) {
      const filled = fillPlaceholders(step.args, { ...scope, item }) as Record<string, unknown>;
      // Its projectId as the step will get it, an earlier step's result included: the run's project, or no step
      const elsewhere = recipeStepTargetRefusal(k, step.tool, filled, projectId);
      if (elsewhere) {
        deps.metrics.recipeSteps.inc({ tool: step.tool, outcome: 'failed' });
        throw new AppError('validation_error', elsewhere);
      }
      try {
        const args = z.object(def.shape).parse(filled);
        const result = await def.run(args as never, ctx.actor);
        results.push(result);
        jobs.push(...jobsIn(result));
      } catch (err) {
        deps.metrics.recipeSteps.inc({ tool: step.tool, outcome: 'failed' });
        const e = err instanceof ZodError ? new AppError('validation_error', err.message) : toAppError(err);
        throw new AppError(e.code, `step ${k + 1} (${label}): ${e.message}`, e.errors);
      }
    }
    if (step.wait && jobs.length) {
      const done: Job[] = await ctx.waitFor(jobs);
      const failed = done.find((j) => isTerminalJob(j) && j.status !== 'succeeded');
      if (failed) {
        deps.metrics.recipeSteps.inc({ tool: step.tool, outcome: 'failed' });
        throw new AppError(
          'validation_error',
          `step ${k + 1} (${label}): ${failed.kind} ${failed.status}${failed.error ? `: ${failed.error.message}` : ''}`,
        );
      }
    }
    (scope.steps as unknown[])[k] = step.forEach ? results : results[0];
    outcomes.push({ step: k + 1, tool: step.tool, ok: true, jobs });
    deps.metrics.recipeSteps.inc({ tool: step.tool, outcome: 'ok' });
    deps.log.info(
      { projectId, jobId: ctx.job.id, recipeId, step: k + 1, tool: step.tool },
      'recipe step done',
    );
  }
  ctx.progress(recipe.steps.length, recipe.steps.length, 'done');
  return { recipe: recipe.name, steps: outcomes };
}
