import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Recipe, RecipeInputSchema, RecipeSchema } from '@rideo/shared';
import * as f from '@rideo/shared/testing';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { loadConfig } from '../../src/config';
import { createStudio, type Studio } from '../../src/domain/studio';
import type { HandlerDeps } from '../../src/jobs/handlers/common';
import { recipeRun } from '../../src/jobs/handlers/recipe';
import type { JobContext } from '../../src/jobs/queue';
import type { ToolDef } from '../../src/mcp/registry';
import { toolRegistry } from '../../src/mcp/server';
import { Metrics } from '../../src/metrics';
import { Layout } from '../../src/storage/layout';
import { MemoryBackend } from '../../src/storage/memory';

/**
 * Recipes and the studio library (docs/design/agents.md#recipes, docs/design/library.md#surfaces): a recipe runs as a
 * job, which does not carry its caller's studio-level permissions, so it may not use the library tools that change the
 * library or a project through it. A recipe is refused when it is saved, when a run starts and when its job runs; the
 * library's read tools stay.
 */

const quiet = () => {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => log };
  return log;
};
const person = { kind: 'user' as const, id: 'local', name: 'You' };
const WRITES = ['library_save', 'library_update', 'library_apply', 'library_detach'];
const refusal = (tool: string, step = 1) =>
  new RegExp(
    `^step ${step}: recipes may not use ${tool}, which .+: use the Library page, REST or MCP directly$`,
  );

const dirs: string[] = [];
const studios: Studio[] = [];
afterEach(async () => {
  for (const s of studios.splice(0)) await s.stop().catch(() => undefined);
});
afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

/** A studio with the MCP tools as its recipes' registry (as the app wires it) and one project. */
async function makeStudio(stored: Recipe[] = []) {
  const dataDir = await mkdtemp(join(tmpdir(), 'rideo-recipes-'));
  dirs.push(dataDir);
  const config = loadConfig({
    RIDEO_DATA_DIR: dataDir,
    RIDEO_STORAGE: 'embedded',
    NODE_ENV: 'test',
    RIDEO_WATERMARK_KEY: 'unit-test-key',
    RIDEO_LOG_LEVEL: 'warn',
  });
  const storage = new MemoryBackend();
  // Recipes saved before the rule, on the storage before the service first reads it
  for (const r of stored)
    await storage.write(new Layout(config.webdav.root).recipe(r.id), JSON.stringify(r), {
      contentType: 'application/json',
    });
  const studio = createStudio(config, { log: quiet(), storage });
  studios.push(studio);
  studio.recipes.setTools(() => toolRegistry(studio));
  const project = f.project();
  const h = studio.deps.projects.handle(project.id);
  await h.repo.init({ 'project.json': project }, person, 'Create project');
  await h.worktree.idle();
  return { studio, projectId: project.id };
}

const step = (tool: string, args: Record<string, unknown>) => ({ tool, args });
/** Steps whose static arguments fit each library tool, so that only the rule can refuse them. */
const LIBRARY_STEPS: Record<string, ReturnType<typeof step>> = {
  library_list: step('library_list', { kinds: ['character'] }),
  library_get: step('library_get', { itemId: '{{itemId}}' }),
  library_uses: step('library_uses', { itemId: '{{itemId}}' }),
  library_status: step('library_status', { projectId: '{{projectId}}' }),
  library_save: step('library_save', {
    projectId: '{{projectId}}',
    entity: { kind: 'character', id: '{{itemId}}' },
  }),
  library_update: step('library_update', { itemId: '{{itemId}}', archived: true }),
  library_apply: step('library_apply', { projectId: '{{projectId}}', itemId: '{{itemId}}' }),
  library_detach: step('library_detach', {
    projectId: '{{projectId}}',
    target: { kind: 'character', id: '{{itemId}}' },
    what: 'library',
  }),
};
const input = (name: string, steps: ReturnType<typeof step>[]) =>
  RecipeInputSchema.parse({ name, params: [{ name: 'itemId', type: 'id' }], steps });

/** A studio recipe as stored by an earlier version, which did not know the rule. */
const storedRecipe = (id: string, tools: string[]): Recipe =>
  RecipeSchema.parse({
    ...input(
      'Old library recipe',
      tools.map((t) => LIBRARY_STEPS[t] ?? step(t, { projectId: '{{projectId}}' })),
    ),
    id,
    builtin: false,
    createdBy: person,
    createdAt: '2026-11-01T00:00:00.000Z',
  });

describe('recipes and the studio library', () => {
  it('refuses to save a recipe that changes the library, naming the tool, and keeps the read tools', async () => {
    const { studio } = await makeStudio();
    for (const tool of WRITES) {
      const err = await studio.recipes
        .create(person, input(`Uses ${tool}`, [LIBRARY_STEPS.library_list!, LIBRARY_STEPS[tool]!]))
        .then(
          () => null,
          (e: { code: string; message: string }) => e,
        );
      expect(err, tool).toMatchObject({
        code: 'validation_error',
        message: expect.stringMatching(refusal(tool, 2)),
      });
    }
    expect((await studio.recipes.list()).filter((r) => !r.builtin)).toEqual([]);
    // The read tools stay
    const reads = await studio.recipes.create(
      person,
      input('Read the library', [
        LIBRARY_STEPS.library_list!,
        LIBRARY_STEPS.library_get!,
        LIBRARY_STEPS.library_uses!,
        LIBRARY_STEPS.library_status!,
      ]),
    );
    expect(reads.steps.map((s) => s.tool)).toEqual([
      'library_list',
      'library_get',
      'library_uses',
      'library_status',
    ]);
  });

  it('refuses to start a run of a recipe saved before the rule, and starts none of its steps', async () => {
    const old = storedRecipe('rcp_0000000000old1', ['library_status', 'library_apply']);
    const { studio, projectId } = await makeStudio([old]);
    // still listed, so its author sees it and can delete it
    expect((await studio.recipes.list()).map((r) => r.id)).toContain(old.id);
    await expect(
      studio.recipes.run(person, projectId, old.id, { itemId: 'lib_0000000000000001' }),
    ).rejects.toMatchObject({
      code: 'validation_error',
      message: expect.stringMatching(refusal('library_apply', 2)),
    });
    expect(studio.deps.jobs.list(projectId, { kind: 'recipe.run' })).toEqual([]);
  });

  it('refuses a recipe job that names one, before any step runs', async () => {
    // A job queued before the rule, or a recipe file replaced on the storage after its run started
    const recipe = storedRecipe('rcp_0000000000old2', ['library_status', 'library_detach']);
    const ran: string[] = [];
    const def = (name: string): ToolDef => ({
      name,
      description: name,
      shape: { projectId: z.string().optional() },
      readOnly: false,
      permission: 'project.edit',
      run: (async () => {
        ran.push(name);
        return { ok: true };
      }) as ToolDef['run'],
    });
    const deps = {
      services: {
        recipes: {
          get: async () => recipe,
          tools: () => new Map([...['library_status', 'library_detach'].map((n) => [n, def(n)] as const)]),
        },
      },
      metrics: new Metrics(),
      log: quiet(),
    } as unknown as HandlerDeps;
    const ctx = {
      job: {
        id: 'job_0000000000000001',
        projectId: 'prj_0000000000000001',
        params: { recipeId: recipe.id, params: {} },
      },
      actor: { kind: 'system', id: 'rideo', name: 'Rideo' },
      progress: vi.fn(),
      waitFor: vi.fn(),
    } as unknown as JobContext;
    await expect(recipeRun(deps, ctx)).rejects.toMatchObject({
      code: 'validation_error',
      message: expect.stringMatching(refusal('library_detach', 2)),
    });
    expect(ran).toEqual([]);
  });
});
