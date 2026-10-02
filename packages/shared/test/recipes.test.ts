import { describe, expect, it } from 'vitest';
import {
  BUILTIN_RECIPES,
  fillPlaceholders,
  hasPlaceholder,
  RecipeInputSchema,
  RecipeParamsError,
  RecipeSchema,
  recipeParams,
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
});
