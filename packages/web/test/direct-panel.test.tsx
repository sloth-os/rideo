import { evaluateWorkflow } from '@rideo/shared';
import * as f from '@rideo/shared/testing';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DirectPanel } from '../src/features/clips/DirectPanel';
import { emptySlice, useProject } from '../src/store/project';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

let patches: Record<string, unknown>[];
beforeEach(() => {
  const docs = f.docs({});
  useProject.setState({ ...emptySlice, projectId: docs.project.id, docs, workflow: evaluateWorkflow(docs) });
  patches = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'PATCH') patches.push(JSON.parse(String(init.body)));
      return new Response('{}');
    }),
  );
});

describe('directing a shot (docs/design/directing.md)', () => {
  it('sends only the camera fields that changed, so quick changes never undo each other', async () => {
    // A planned shot with a lens, as version 2 plans give every shot one
    const shot = f.readyShot([], { index: 0, camera: { framing: 'wide', movement: 'static', lensMm: 24 } });
    const clip = f.clip({ index: 0, shots: [shot] });
    render(<DirectPanel clip={clip} shot={shot} />);
    // Two changes before the store hears of the first: the shot prop still has the planned lens
    fireEvent.change(screen.getByTestId('camera-lens'), { target: { value: '85' } });
    fireEvent.change(screen.getByTestId('camera-aperture'), { target: { value: '2' } });
    await waitFor(() => expect(patches).toHaveLength(2));
    expect(patches).toEqual([{ camera: { lensMm: 85 } }, { camera: { aperture: 2 } }]);
  });
});
