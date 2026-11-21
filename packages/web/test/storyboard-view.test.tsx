import {
  boardPromptHash,
  evaluateWorkflow,
  type ProjectDocs,
  ProjectSettingsSchema,
  type Scene,
  type Shot,
  type ShotBoard,
  shotContextOf,
} from '@rideo/shared';
import * as f from '@rideo/shared/testing';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StoryboardView } from '../src/features/storyboard/StoryboardView';
import { emptySlice, useProject } from '../src/store/project';
import { useUi } from '../src/store/ui';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  useUi.setState({ toasts: [] });
});

const scene = (index: number): Scene => ({
  id: `scn_00000000000000${index.toString().padStart(2, '0')}`,
  index,
  beatId: null,
  heading: `INT. ROOM ${index + 1} - NIGHT`,
  location: '',
  timeOfDay: '',
  summary: '',
  action: '',
  dialogue: [],
  characterIds: [],
  locationId: null,
  elementIds: [],
  estDurationSec: 10,
  continuity: '',
});

/** A drawn frame waiting for review (docs/design/storyboard.md#board-frames). */
const drawn = (shot: Shot, docs: ProjectDocs): ShotBoard => ({
  keyframe: f.imageMedia({ path: `media/keyframes/${shot.id}.png` }),
  createdAt: '2026-10-01T00:00:00.000Z',
  request: { prompt: 'p', seed: 1, referenceCount: 0 },
  sheet: null,
  promptHash: boardPromptHash(shotContextOf(shot, docs)),
  consistency: f.report(),
  characterLocks: {},
  elementLocks: {},
  audio: null,
  gatewayTaskIds: [],
  approved: false,
  approvedAt: null,
  approvedBy: null,
  seen: null,
});

/** The storyboard of a project that storyboards its first `n` scenes, each planned as one shot with a frame to review. */
function showStoryboard(n: number) {
  const base = f.docs({
    project: f.project({ settings: ProjectSettingsSchema.parse({ storyboard: { scenes: n } }) }),
    screenplay: f.screenplay({ scenes: [scene(0), scene(1), scene(2)] }),
  });
  const shots = Array.from({ length: n }, () => f.shot({ index: 0 }));
  const docs: ProjectDocs = {
    ...base,
    clips: f.byId(
      shots.map((s, i) =>
        f.clip({ index: i, sceneId: scene(i).id, shots: [{ ...s, board: drawn(s, base) }] }),
      ),
    ),
  };
  useProject.setState({ ...emptySlice, projectId: docs.project.id, docs, workflow: evaluateWorkflow(docs) });
  render(
    <MemoryRouter>
      <StoryboardView />
    </MemoryRouter>,
  );
}

describe('storyboard counts (docs/brand.md#voice)', () => {
  it('names no count before the screenplay has scenes', () => {
    const docs = f.docs({ screenplay: f.screenplay({ scenes: [] }) });
    useProject.setState({
      ...emptySlice,
      projectId: docs.project.id,
      docs,
      workflow: evaluateWorkflow(docs),
    });
    render(
      <MemoryRouter>
        <StoryboardView />
      </MemoryRouter>,
    );
    expect(
      screen.getByText(
        'The first scenes of the screenplay: approve a frame per shot before any video is generated. Approved frames start the video pass.',
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/The first 0/)).toBeNull();
    expect(screen.getByText('No scenes yet')).toBeTruthy();
  });

  it('names one scene and one frame in the singular', async () => {
    showStoryboard(1);
    expect(
      screen.getByText(/^The first scene: approve a frame per shot before any video is generated\./),
    ).toBeTruthy();
    expect(screen.getByTestId('storyboard-progress').textContent).toMatch(/^0 of 1 frame approved/);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ approved: 1 }))),
    );
    fireEvent.click(screen.getByTestId('approve-all-boards'));
    await waitFor(() => expect(useUi.getState().toasts.map((t) => t.message)).toEqual(['1 frame approved']));
  });

  it('counts two scenes and two frames in the plural', async () => {
    showStoryboard(2);
    expect(
      screen.getByText(/^The first 2 scenes: approve a frame per shot before any video is generated\./),
    ).toBeTruthy();
    expect(screen.getByTestId('storyboard-progress').textContent).toMatch(/^0 of 2 frames approved/);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ approved: 2 }))),
    );
    fireEvent.click(screen.getByTestId('approve-all-boards'));
    await waitFor(() => expect(useUi.getState().toasts.map((t) => t.message)).toEqual(['2 frames approved']));
  });
});
