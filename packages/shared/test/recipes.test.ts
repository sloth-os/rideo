import { describe, expect, it } from 'vitest';
import {
  BUILTIN_RECIPES,
  fillPlaceholders,
  hasPlaceholder,
  RecipeInputSchema,
  RecipeParamsError,
  RecipeSchema,
  recipeParams,
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
  });
});
