import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BUILTIN_RECIPES, type Recipe, RecipeInputSchema, RecipeSchema } from '@rideo/shared';
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
 * job, which does not carry its caller's studio-level permissions (the library service falls back to the studio), so
 * it may not use the library tools that change the library or a project through it, nor those that read the studio
 * library or where its items are used across the studio's projects. A recipe is refused when it is saved, when a run
 * starts and when its job runs; `library_status`, which reads only the run's project, stays.
 */

const quiet = () => {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => log };
  return log;
};
const person = { kind: 'user' as const, id: 'local', name: 'You' };
/** Every library tool but `library_status`: the studio library's reads and the tools that change it. */
const REFUSED = [
  'library_list',
  'library_get',
  'library_uses',
  'library_save',
  'library_update',
  'library_apply',
  'library_detach',
];
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

/**
 * A studio with the MCP tools as its recipes' registry (as the app wires it) and two projects: the one recipes run in
 * and another, whose id the first one's brief holds (a value a step can read and pass on).
 */
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
  const other = f.project({ title: 'Another film' });
  const project = f.project({
    brief: { prompt: other.id, attachmentResourceIds: [], adapted: null },
  });
  for (const p of [project, other]) {
    const h = studio.deps.projects.handle(p.id);
    await h.repo.init({ 'project.json': p }, person, 'Create project');
    await h.worktree.idle();
  }
  return { studio, projectId: project.id, otherId: other.id };
}

/** The names of a project's characters. */
async function cast(studio: Studio, projectId: string): Promise<string[]> {
  return Object.values((await studio.projects.state(projectId)).docs.characters).map((c) => c.name);
}

/** A `recipe.run` job of a recipe, handled as the queue would, without the queue (as if enqueued directly). */
function recipeJob(
  studio: Studio,
  projectId: string,
  recipeId: string,
  params: Record<string, unknown> = {},
) {
  const deps = {
    services: { recipes: studio.recipes },
    metrics: new Metrics(),
    log: quiet(),
  } as unknown as HandlerDeps;
  const ctx = {
    job: { id: 'job_0000000000000002', projectId, params: { recipeId, params } },
    actor: { kind: 'system', id: 'rideo', name: 'Rideo' },
    progress: vi.fn(),
    waitFor: vi.fn(async () => []),
  } as unknown as JobContext;
  return recipeRun(deps, ctx);
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
  it('refuses to save a recipe that reads the studio library or changes it, naming the tool, and keeps library_status', async () => {
    const { studio } = await makeStudio();
    // every library tool of the registry is refused but the run project's status (a new one must be decided)
    const libraryTools = [...toolRegistry(studio).keys()].filter((t) => t.startsWith('library_')).sort();
    expect(libraryTools).toEqual([...REFUSED, 'library_status'].sort());
    for (const tool of REFUSED) {
      const err = await studio.recipes
        .create(person, input(`Uses ${tool}`, [LIBRARY_STEPS.library_status!, LIBRARY_STEPS[tool]!]))
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
    // The status of the run's project stays: the run is allowed to read that project
    const status = await studio.recipes.create(
      person,
      input('Library status', [LIBRARY_STEPS.library_status!]),
    );
    expect(status.steps.map((s) => s.tool)).toEqual(['library_status']);
  });

  it('refuses to start a run of a recipe saved before the rule, and starts none of its steps', async () => {
    const changes = storedRecipe('rcp_0000000000old1', ['library_status', 'library_apply']);
    const reads = storedRecipe('rcp_0000000000old3', ['library_status', 'library_uses']);
    const { studio, projectId } = await makeStudio([changes, reads]);
    for (const [old, tool] of [
      [changes, 'library_apply'],
      [reads, 'library_uses'],
    ] as const) {
      // still listed, so its author sees it and can delete it
      expect((await studio.recipes.list()).map((r) => r.id)).toContain(old.id);
      await expect(
        studio.recipes.run(person, projectId, old.id, { itemId: 'lib_0000000000000001' }),
      ).rejects.toMatchObject({
        code: 'validation_error',
        message: expect.stringMatching(refusal(tool, 2)),
      });
    }
    expect(studio.deps.jobs.list(projectId, { kind: 'recipe.run' })).toEqual([]);
  });

  it.each(['library_detach', 'library_list'])(
    'refuses a recipe job that names %s, before any step runs',
    async (tool) => {
      // A job queued before the rule, or a recipe file replaced on the storage after its run started
      const recipe = storedRecipe('rcp_0000000000old2', ['library_status', tool]);
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
            tools: () => new Map([...['library_status', tool].map((n) => [n, def(n)] as const)]),
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
        message: expect.stringMatching(refusal(tool, 2)),
      });
      expect(ran).toEqual([]);
    },
  );
});

/**
 * A recipe acts only on the project it runs in (docs/design/agents.md#recipes): a run is authorized for that project
 * alone, and its job runs the steps without asking anyone about theirs (as whatever principal the queue happens to run
 * under, or none). So every step must take the run's project as its projectId: a tool that takes none is refused, a
 * literal projectId when a recipe is saved, one the run's parameters fill in with another project when a run starts or
 * its job begins, and one an earlier step's result fills in before that step runs.
 */
describe('recipes act only on the project they run in', () => {
  const elsewhere = (k: number, tool: string, rest: string) =>
    new RegExp(`^step ${k} \\(${tool}\\): projectId ${rest}`);
  const refused = (p: Promise<unknown>) =>
    p.then(
      () => null,
      (e: { code: string; message: string }) => ({ code: e.code, message: e.message }),
    );

  it('refuses to save a step aimed at another project, or without one, naming the step and the argument', async () => {
    const { studio, otherId } = await makeStudio();
    const save = (steps: ReturnType<typeof step>[], params: { name: string; type: 'id' }[] = []) =>
      refused(studio.recipes.create(person, RecipeInputSchema.parse({ name: 'Elsewhere', params, steps })));
    // another project's id, or the run's own written out: only {{projectId}} names the project a recipe runs in
    for (const id of [otherId, 'prj_0123456789abcdef'])
      expect(
        await save([
          step('project_get', { projectId: '{{projectId}}' }),
          step('character_create', { projectId: id, name: 'Intruder' }),
        ]),
        id,
      ).toMatchObject({
        code: 'validation_error',
        message: expect.stringMatching(
          elsewhere(2, 'character_create', `is "${id}": it must be \\{\\{projectId\\}\\}`),
        ),
      });
    // a tool whose projectId may be left out acts on every project then
    expect(await save([step('ui_sessions', {})])).toMatchObject({
      code: 'validation_error',
      message: expect.stringMatching(
        elsewhere(1, 'ui_sessions', 'is missing: it must be \\{\\{projectId\\}\\}'),
      ),
    });
    // a tool that takes no project acts on the studio, not on the project the recipe runs in
    for (const [tool, args] of [
      ['project_list', {}],
      ['project_create', { kind: 'story', title: 'Elsewhere' }],
      ['project_import', { url: 'https://example.test/film.rideo', mode: 'replace' }],
      ['recipe_delete', { recipeId: 'rcp_0000000000000001' }],
      ['settings_update', { values: {} }],
      ['notifications_list', {}],
    ] as const)
      expect(await save([step(tool, args)]), tool).toMatchObject({
        code: 'validation_error',
        message: `step 1: recipes may not use ${tool}, which takes no projectId: a recipe acts only on the project it runs in`,
      });
    expect((await studio.recipes.list()).filter((r) => !r.builtin)).toEqual([]);
    // {{projectId}} is saved; a parameter is checked when a run starts
    const ok = await studio.recipes.create(
      person,
      RecipeInputSchema.parse({
        name: 'Here',
        params: [{ name: 'target', type: 'id' }],
        steps: [
          step('character_create', { projectId: '{{projectId}}', name: 'Here' }),
          step('character_create', { projectId: '{{target}}', name: 'There' }),
          step('ui_notify', { projectId: '{{projectId}}', message: 'Done' }),
        ],
      }),
    );
    expect(ok.steps).toHaveLength(3);
  });

  it('refuses to start a run whose steps name another project, saved before the rule or through a parameter', async () => {
    const literal = RecipeSchema.parse({
      ...RecipeInputSchema.parse({
        name: 'Old intruder',
        steps: [step('character_create', { projectId: 'prj_0000000000other', name: 'Intruder' })],
      }),
      id: 'rcp_0000000000old4',
      builtin: false,
      createdBy: person,
      createdAt: '2026-11-01T00:00:00.000Z',
    });
    const studioWide = RecipeSchema.parse({
      ...RecipeInputSchema.parse({ name: 'Old listing', steps: [step('project_list', {})] }),
      id: 'rcp_0000000000old5',
      builtin: false,
      createdBy: person,
      createdAt: '2026-11-01T00:00:00.000Z',
    });
    const { studio, projectId, otherId } = await makeStudio([literal, studioWide]);
    expect(await refused(studio.recipes.run(person, projectId, literal.id))).toMatchObject({
      code: 'validation_error',
      message: expect.stringMatching(
        elsewhere(1, 'character_create', `is "prj_0000000000other": it must be ${projectId}, the project`),
      ),
    });
    expect(await refused(studio.recipes.run(person, projectId, studioWide.id))).toMatchObject({
      code: 'validation_error',
      message: expect.stringMatching(/^step 1: recipes may not use project_list, which takes no projectId/),
    });
    // the same written out as the run's own project still runs there
    const ownId = { ...literal, id: 'rcp_0000000000old6', steps: [step('project_get', { projectId })] };
    await studio.deps.storage.write(studio.deps.layout.recipe(ownId.id), JSON.stringify(ownId), {
      contentType: 'application/json',
    });
    // a parameter filled with another project, directly or as a list's item
    const viaParam = await studio.recipes.create(
      person,
      RecipeInputSchema.parse({
        name: 'Through a parameter',
        params: [
          { name: 'target', type: 'id', required: true },
          { name: 'targets', type: 'ids' },
        ],
        steps: [
          step('character_create', { projectId: '{{target}}', name: 'Intruder' }),
          {
            ...step('character_create', { projectId: '{{item}}', name: 'Intruders' }),
            forEach: '{{targets}}',
          },
        ],
      }),
    );
    expect(
      await refused(studio.recipes.run(person, projectId, viaParam.id, { target: otherId })),
    ).toMatchObject({
      code: 'validation_error',
      message: expect.stringMatching(
        elsewhere(1, 'character_create', `is "${otherId}": it must be ${projectId}`),
      ),
    });
    expect(
      await refused(
        studio.recipes.run(person, projectId, viaParam.id, {
          target: projectId,
          targets: [projectId, otherId],
        }),
      ),
    ).toMatchObject({
      code: 'validation_error',
      message: expect.stringMatching(
        elsewhere(2, 'character_create', `is "${otherId}": it must be ${projectId}`),
      ),
    });
    expect(studio.deps.jobs.list(projectId, { kind: 'recipe.run' })).toEqual([]);
    // filled with the run's own project, it runs
    const job = await studio.recipes.run(person, projectId, viaParam.id, {
      target: projectId,
      targets: [projectId],
    });
    expect(job).toMatchObject({ kind: 'recipe.run', projectId });
  });

  it('refuses a job whose steps name another project before any step runs, and a step an earlier result aims elsewhere before it runs', async () => {
    const { studio, projectId, otherId } = await makeStudio();
    const viaParam = await studio.recipes.create(
      person,
      RecipeInputSchema.parse({
        name: 'Through a parameter',
        params: [{ name: 'target', type: 'id', required: true }],
        steps: [
          step('character_create', { projectId: '{{projectId}}', name: 'Here' }),
          step('character_create', { projectId: '{{target}}', name: 'Intruder' }),
        ],
      }),
    );
    // a job enqueued directly, past the run's check: refused before its first step
    await expect(recipeJob(studio, projectId, viaParam.id, { target: otherId })).rejects.toMatchObject({
      code: 'validation_error',
      message: expect.stringMatching(
        elsewhere(2, 'character_create', `is "${otherId}": it must be ${projectId}`),
      ),
    });
    expect(await cast(studio, projectId)).toEqual([]);
    expect(await cast(studio, otherId)).toEqual([]);
    // the run's project brief holds the other project's id: a step that passes it on is refused before it runs
    const viaResult = await studio.recipes.create(
      person,
      RecipeInputSchema.parse({
        name: 'Through a result',
        steps: [
          step('project_get', { projectId: '{{projectId}}' }),
          step('character_create', { projectId: '{{steps.0.project.brief.prompt}}', name: 'Intruder' }),
        ],
      }),
    );
    await expect(recipeJob(studio, projectId, viaResult.id)).rejects.toMatchObject({
      code: 'validation_error',
      message: expect.stringMatching(
        elsewhere(2, 'character_create', `is "${otherId}": it must be ${projectId}`),
      ),
    });
    expect(await cast(studio, otherId)).toEqual([]);
    // the same steps aimed at the run's project run
    await expect(recipeJob(studio, projectId, viaParam.id, { target: projectId })).resolves.toMatchObject({
      steps: [
        { step: 1, tool: 'character_create', ok: true },
        { step: 2, tool: 'character_create', ok: true },
      ],
    });
    expect((await cast(studio, projectId)).sort()).toEqual(['Here', 'Intruder']);
    expect(await cast(studio, otherId)).toEqual([]);
  });

  it('refuses a recipe that runs a recipe when it is saved, when a run starts and when its job runs', async () => {
    const nested = RecipeSchema.parse({
      ...RecipeInputSchema.parse({
        name: 'Again',
        steps: [step('recipe_run', { projectId: '{{projectId}}', recipeId: 'rcp_0000000000old7' })],
      }),
      id: 'rcp_0000000000old7',
      builtin: false,
      createdBy: person,
      createdAt: '2026-11-01T00:00:00.000Z',
    });
    const { studio, projectId } = await makeStudio([nested]);
    const again = { code: 'validation_error', message: 'step 1: recipes do not run recipes' };
    expect(await refused(studio.recipes.create(person, RecipeInputSchema.parse(nested)))).toEqual(again);
    expect(await refused(studio.recipes.run(person, projectId, nested.id))).toEqual(again);
    await expect(recipeJob(studio, projectId, nested.id)).rejects.toMatchObject(again);
    expect(studio.deps.jobs.list(projectId, { kind: 'recipe.run' })).toEqual([]);
  });

  it('keeps every built-in recipe to the project it runs in, and no tool names a project but by projectId', async () => {
    const { studio, projectId } = await makeStudio();
    const tools = toolRegistry(studio);
    for (const r of BUILTIN_RECIPES) {
      // saved as they are, and started with parameters that fit them
      await expect(studio.recipes.create(person, RecipeInputSchema.parse(r)), r.id).resolves.toBeTruthy();
      const params = Object.fromEntries(
        r.params
          .filter((p) => p.required)
          .map((p) => [p.name, p.type === 'id' ? 'clp_0000000000000001' : 'es']),
      );
      const job = await studio.recipes.run(person, projectId, r.id, params);
      expect(job, r.id).toMatchObject({ kind: 'recipe.run', projectId });
      await studio.deps.jobs.cancel(projectId, job.id).catch(() => undefined);
    }
    // the rule covers projectId: a tool that took another argument naming a project would have to be added to it
    const projectArgs = [...tools.values()].flatMap((def) => {
      const schema = JSON.stringify(z.toJSONSchema(z.object(def.shape), { unrepresentable: 'any' }));
      const keys = [...schema.matchAll(/"([A-Za-z_]*[Pp]roject[A-Za-z_]*)":/g)].map((m) => m[1]!);
      return keys.filter((k) => k !== 'projectId').map((k) => `${def.name}.${k}`);
    });
    expect(projectArgs).toEqual([]);
    expect([...tools.values()].filter((def) => Object.hasOwn(def.shape, 'projectId')).length).toBeGreaterThan(
      100,
    );
  });
});
