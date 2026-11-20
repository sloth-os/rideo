import { describe, expect, it } from 'vitest';
import {
  BUILTIN_RECIPES,
  fillPlaceholders,
  hasPlaceholder,
  RecipeInputSchema,
  RecipeParamsError,
  RecipeSchema,
  recipeParams,
  recipeProjectRefusal,
  recipeStepsRefusal,
  recipeStepTargetRefusal,
  recipeToolRefusal,
} from '../src';

const recipe = RecipeInputSchema.parse({
  name: 'Titles',
  params: [
    { name: 'texts', type: 'ids', required: true },
    { name: 'seconds', type: 'number', default: 3 },
    { name: 'loud', type: 'boolean' },
  ],
  steps: [{ tool: 'timeline_apply', args: { projectId: '{{projectId}}' } }],
});

describe('recipes (docs/design/agents.md#recipes)', () => {
  it('fills defaults, checks types and refuses missing, wrong and unknown parameters', () => {
    expect(recipeParams(recipe, { texts: ['a', 'b'] })).toEqual({ texts: ['a', 'b'], seconds: 3 });
    expect(recipeParams(recipe, { texts: ['a'], seconds: 5, loud: true })).toEqual({
      texts: ['a'],
      seconds: 5,
      loud: true,
    });
    expect(() => recipeParams(recipe, {})).toThrow(new RecipeParamsError('texts is required'));
    expect(() => recipeParams(recipe, { texts: 'a' })).toThrow('texts must be a list of ids');
    expect(() => recipeParams(recipe, { texts: ['a'], seconds: '5' })).toThrow('seconds must be a number');
    expect(() => recipeParams(recipe, { texts: ['a'], colour: 'red' })).toThrow('unknown parameter colour');
  });

  it('names each parameter type with its article when a value does not fit', () => {
    const typed = RecipeInputSchema.parse({
      name: 'Typed',
      params: [
        { name: 'clipId', type: 'id' },
        { name: 'title', type: 'string' },
        { name: 'count', type: 'number' },
        { name: 'loud', type: 'boolean' },
        { name: 'shotIds', type: 'ids' },
      ],
      steps: [{ tool: 'timeline_apply', args: { projectId: '{{projectId}}' } }],
    });
    for (const [name, value, message] of [
      ['clipId', 7, 'clipId must be an id'],
      ['title', 7, 'title must be a string'],
      ['count', '7', 'count must be a number'],
      ['loud', 'yes', 'loud must be a boolean'],
      ['shotIds', 'shot', 'shotIds must be a list of ids'],
    ] as const)
      expect(() => recipeParams(typed, { [name]: value }), name).toThrow(new RecipeParamsError(message));
  });

  it('fills placeholders keeping types, interpolates inside strings and reads earlier steps', () => {
    const scope = {
      projectId: 'prj_000000000001',
      count: 2,
      ids: ['a', 'b'],
      steps: [{ id: 'job_1', n: { k: 4 } }],
      item: 'x',
    };
    expect(
      fillPlaceholders(
        {
          projectId: '{{projectId}}',
          count: '{{count}}',
          shotIds: '{{ids}}',
          text: 'Take {{count}} of {{item}} ({{steps.0.n.k}})',
          nested: [{ job: '{{steps.0.id}}' }],
          gone: '{{nothing}}',
          plain: 7,
        },
        scope,
      ),
    ).toEqual({
      projectId: 'prj_000000000001',
      count: 2,
      shotIds: ['a', 'b'],
      text: 'Take 2 of x (4)',
      nested: [{ job: 'job_1' }],
      plain: 7,
    });
    expect(hasPlaceholder({ a: ['x', { b: '{{y}}' }] })).toBe(true);
    expect(hasPlaceholder({ a: ['x', { b: 'y' }] })).toBe(false);
  });

  it('ships valid built-in recipes', () => {
    expect(BUILTIN_RECIPES.map((r) => r.id)).toEqual([
      'builtin:storyboard_to_animatic',
      'builtin:cast_voices',
      'builtin:dub',
      'builtin:clip_variations',
    ]);
    for (const r of BUILTIN_RECIPES) expect(RecipeSchema.parse(r)).toEqual(r);
    expect(() => RecipeInputSchema.parse({ name: 'x', steps: [{ tool: 'Bad Tool' }] })).toThrow();
    expect(() =>
      RecipeInputSchema.parse({
        name: 'x',
        params: [{ name: '9x', type: 'string' }],
        steps: [{ tool: 'a_b' }],
      }),
    ).toThrow();
  });

  it('refuses the library tools that read the studio library or change it, and keeps the run project’s status', () => {
    for (const tool of [
      'library_list',
      'library_get',
      'library_uses',
      'library_save',
      'library_update',
      'library_apply',
      'library_detach',
    ])
      expect(recipeToolRefusal(tool)).toMatch(
        new RegExp(`^recipes may not use ${tool}, which .+: use the Library page, REST or MCP directly$`),
      );
    // library_status reads only the run's project, which the run was allowed to read
    for (const tool of ['library_status', 'timeline_apply']) expect(recipeToolRefusal(tool)).toBeNull();
    // the names every object has are no tool's
    for (const tool of ['constructor', 'toString', '__proto__']) expect(recipeToolRefusal(tool)).toBeNull();
    // no built-in recipe uses one
    const builtin = BUILTIN_RECIPES.flatMap((r) => r.steps.map((s) => s.tool));
    expect(builtin.length).toBeGreaterThan(0);
    expect(builtin.filter((tool) => recipeToolRefusal(tool) !== null)).toEqual([]);
    // nor does a recipe run a recipe, at whichever check
    expect(recipeStepsRefusal([{ tool: 'timeline_get' }, { tool: 'recipe_run' }])).toBe(
      'step 2: recipes do not run recipes',
    );
  });

  describe('a recipe acts only on the project it runs in', () => {
    const HERE = 'prj_0000000000here';
    const THERE = 'prj_000000000there';
    /** Tools as the registry has them: a project tool, a studio tool, and one the registry lacks. */
    const takes = (tool: string) =>
      tool === 'project_list' ? false : tool === 'no_such_tool' ? undefined : true;
    const step = (args: Record<string, unknown>, forEach?: string) => ({
      tool: 'character_create',
      args,
      ...(forEach ? { forEach } : {}),
    });
    const saved = (args: Record<string, unknown>, forEach?: string) =>
      recipeProjectRefusal([step({ projectId: '{{projectId}}' }), step(args, forEach)], takes);
    const run = (args: Record<string, unknown>, params: Record<string, unknown> = {}, forEach?: string) =>
      recipeProjectRefusal([step(args, forEach)], takes, { projectId: HERE, params });
    const aimed = (k: number, value: string, project: string) =>
      `step ${k} (character_create): projectId is ${value}: it must be ${project}, the project the recipe runs in`;

    it('saves {{projectId}} and the placeholders a run fills in, and refuses a projectId written out or left out', () => {
      expect(saved({ projectId: '{{projectId}}' })).toBeNull();
      for (const later of ['{{target}}', '{{item}}', '{{steps.0.id}}', 'prj_{{suffix}}'])
        expect(saved({ projectId: later }), later).toBeNull();
      expect(saved({ projectId: THERE })).toBe(aimed(2, `"${THERE}"`, '{{projectId}}'));
      // even the project the recipe will run in: a recipe runs on any project
      expect(saved({ projectId: HERE })).toBe(aimed(2, `"${HERE}"`, '{{projectId}}'));
      expect(saved({ name: 'Nobody' })).toBe(aimed(2, 'missing', '{{projectId}}'));
      expect(saved({ projectId: 7 })).toBe(aimed(2, '7', '{{projectId}}'));
      // a tool that takes no projectId acts on the studio; one the registry lacks is left to the other checks
      expect(recipeProjectRefusal([{ tool: 'project_list', args: {} }], takes)).toBe(
        'step 1: recipes may not use project_list, which takes no projectId: a recipe acts only on the project it runs in',
      );
      expect(recipeProjectRefusal([{ tool: 'no_such_tool', args: {} }], takes)).toBeNull();
    });

    it('fills in the run’s parameters and project, and the items of a list it runs over, when a run starts', () => {
      expect(run({ projectId: '{{projectId}}' })).toBeNull();
      expect(run({ projectId: '{{target}}' }, { target: HERE })).toBeNull();
      expect(run({ projectId: '{{target}}' }, { target: THERE })).toBe(aimed(1, `"${THERE}"`, HERE));
      // a parameter left out fills in nothing; a parameter named projectId is the run's project
      expect(run({ projectId: '{{target}}' })).toBe(aimed(1, 'missing', HERE));
      expect(run({ projectId: '{{projectId}}' }, { projectId: THERE })).toBeNull();
      // a literal stored before the rule passes only on its own project
      expect(run({ projectId: HERE })).toBeNull();
      expect(run({ projectId: THERE })).toBe(aimed(1, `"${THERE}"`, HERE));
      expect(run({ projectId: 'prj_{{suffix}}' }, { suffix: '000000000there' })).toBe(
        aimed(1, `"${THERE}"`, HERE),
      );
      // each item of a forEach over a parameter
      expect(run({ projectId: '{{item}}' }, { ids: [HERE, HERE] }, '{{ids}}')).toBeNull();
      expect(run({ projectId: '{{item}}' }, { ids: [HERE, THERE] }, '{{ids}}')).toBe(
        aimed(1, `"${THERE}"`, HERE),
      );
      expect(run({ projectId: '{{item}}' })).toBe(aimed(1, 'missing', HERE));
      // what an earlier step returns is checked by the job before the step runs
      expect(run({ projectId: '{{steps.0.project.id}}' })).toBeNull();
      expect(run({ projectId: '{{item}}' }, {}, '{{steps.0.ids}}')).toBeNull();
    });

    it('checks each step as its job is about to run it, its placeholders filled in', () => {
      const filled = (args: Record<string, unknown>) =>
        recipeStepTargetRefusal(1, 'character_create', args, HERE);
      expect(filled({ projectId: HERE, name: 'Here' })).toBeNull();
      expect(filled({ projectId: THERE, name: 'There' })).toBe(aimed(2, `"${THERE}"`, HERE));
      expect(filled({ name: 'Nowhere' })).toBe(aimed(2, 'missing', HERE));
      const long = { id: THERE, note: 'x'.repeat(200) };
      expect(filled({ projectId: long })).toMatch(
        /^step 2 \(character_create\): projectId is \{"id":.{60,}…: it must be/,
      );
    });

    it('keeps every built-in recipe to the project it runs in', () => {
      for (const r of BUILTIN_RECIPES) {
        expect(
          recipeProjectRefusal(r.steps, () => true),
          r.id,
        ).toBeNull();
        const params = Object.fromEntries(r.params.map((p) => [p.name, p.default ?? 'x']));
        expect(
          recipeProjectRefusal(r.steps, () => true, { projectId: HERE, params }),
          r.id,
        ).toBeNull();
      }
    });
  });
});
