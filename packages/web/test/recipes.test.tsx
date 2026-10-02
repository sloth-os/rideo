import { BUILTIN_RECIPES, evaluateWorkflow, type Recipe } from '@rideo/shared';
import * as f from '@rideo/shared/testing';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RecipesCard } from '../src/features/workspace/RecipesCard';
import { emptySlice, useProject } from '../src/store/project';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const studio: Recipe = {
  id: 'rcp_000000000001',
  builtin: false,
  name: 'Titles from a list',
  description: 'A title per text',
  params: [
    { name: 'texts', type: 'ids', required: true },
    { name: 'seconds', type: 'number', default: 2, required: false },
    { name: 'loud', type: 'boolean', required: false },
  ],
  steps: [{ tool: 'timeline_apply', args: {}, wait: false }],
  createdBy: { kind: 'user', id: 'u1', name: 'Mira' },
  createdAt: '2026-10-02T00:00:00.000Z',
};

describe('recipes card (docs/design/agents.md#surfaces)', () => {
  let calls: { url: string; init?: RequestInit }[];
  beforeEach(() => {
    const docs = f.docs();
    useProject.setState({
      ...emptySlice,
      projectId: docs.project.id,
      docs,
      workflow: evaluateWorkflow(docs),
    });
    calls = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        if (url === '/api/recipes') return new Response(JSON.stringify([...BUILTIN_RECIPES, studio]));
        return new Response(JSON.stringify({ id: 'job_000000000001', kind: 'recipe.run' }), { status: 202 });
      }),
    );
  });

  it('lists built-in and studio recipes with their steps, and runs one with its parameters typed', async () => {
    render(<RecipesCard />);
    await waitFor(() => expect(screen.getAllByTestId('recipe-row')).toHaveLength(5));
    expect(screen.getAllByTestId('recipe-name').map((n) => n.textContent)).toContain('Titles from a list');
    // built-ins cannot be deleted
    expect(screen.getAllByTestId('recipe-delete')).toHaveLength(1);
    fireEvent.click(screen.getAllByTestId('recipe-run')[4]!);
    expect((screen.getByTestId('recipe-param-seconds') as HTMLInputElement).value).toBe('2');
    fireEvent.change(screen.getByTestId('recipe-param-texts'), { target: { value: 'Opening, Closing' } });
    fireEvent.click(screen.getByTestId('recipe-param-loud'));
    fireEvent.click(screen.getByTestId('recipe-start'));
    await waitFor(() =>
      expect(calls.some((c) => c.url.endsWith('/recipes/rcp_000000000001/run'))).toBe(true),
    );
    const run = calls.find((c) => c.url.endsWith('/run'))!;
    expect(run.url).toBe(`/api/projects/${useProject.getState().projectId}/recipes/rcp_000000000001/run`);
    expect(JSON.parse(String(run.init!.body))).toEqual({
      params: { texts: ['Opening', 'Closing'], seconds: 2, loud: true },
    });
  });
});
