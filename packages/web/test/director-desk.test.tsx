import { blockingShotOf, evaluateWorkflow, normalizeBlocking, ProjectSettingsSchema } from '@rideo/shared';
import * as f from '@rideo/shared/testing';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DirectorDesk } from '../src/features/storyboard/DirectorDesk';
import { emptySlice, useProject } from '../src/store/project';

/** The director's desk (docs/design/director-desk.md#the-desk), in jsdom. */
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

let calls: { url: string; method: string; body?: string }[];
beforeEach(() => {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method ?? 'GET', body: init?.body as string | undefined });
      if (url.endsWith('/blocking') && init?.method === 'PUT') {
        const { blocking } = JSON.parse(String(init.body));
        return new Response(
          JSON.stringify({ blocking, state: 'ready', draft: blocking, issues: [], lines: {} }),
        );
      }
      return new Response(JSON.stringify({ id: 'job_0000000000aaaaaa' }), { status: 202 });
    }),
  );
});

function setup() {
  const rosie = f.character({ name: 'Rosie' });
  const sammy = f.character({ name: 'Sammy' });
  const two = f.shot({
    index: 0,
    characterIds: [rosie.id, sammy.id],
    camera: { framing: 'wide', movement: 'static' },
  });
  const single = f.shot({
    index: 1,
    characterIds: [rosie.id],
    camera: { framing: 'close_up', movement: 'static' },
  });
  const settings = ProjectSettingsSchema.parse({
    generation: { promptVersion: 2 },
    blocking: { enabled: true },
  });
  const ctx = {
    shots: [two, single].map(blockingShotOf),
    characterIds: [rosie.id, sammy.id],
    aspect: 16 / 9,
  };
  const empty = normalizeBlocking(
    {
      version: 1,
      source: 'ai',
      updatedAt: '2026-10-29T00:00:00.000Z',
      set: {
        width: 10,
        depth: 8,
        ground: 'sand',
        interior: false,
        sun: { azimuthDeg: 135, elevationDeg: 40 },
        landmarks: [],
      },
      actors: [],
      props: [],
      shots: {},
    },
    ctx,
    { line: true },
  ).blocking;
  const clip = f.clip({ shots: [two, single], blocking: empty });
  const docs = f.docs({
    project: f.project({ settings }),
    characters: { [rosie.id]: rosie, [sammy.id]: sammy },
    clips: { [clip.id]: clip },
  });
  useProject.setState({ ...emptySlice, projectId: docs.project.id, docs, workflow: evaluateWorkflow(docs) });
  return { clip, rosie, sammy };
}

describe("the director's desk", () => {
  it('draws the plan with a camera per shot, the blocking line, and saves an edit', async () => {
    const { clip, rosie } = setup();
    render(<DirectorDesk clip={clip} onClose={() => {}} />);
    expect(screen.getByTestId('desk-state').textContent).toBe('Blocked by the AI');
    expect(screen.getByTestId('desk-camera-1')).toBeTruthy();
    expect(screen.getByTestId('desk-camera-2')).toBeTruthy();
    expect(screen.getByTestId('desk-blocking-line').textContent).toContain('Blocking: Rosie is');
    expect(screen.getByTestId('desk-issues').textContent).toContain('clean');
    // Select Rosie (pointer down on her disc) and pose her: the draft is unsaved
    fireEvent.pointerDown(screen.getByTestId(`desk-actor-${rosie.id}`).querySelector('circle')!);
    fireEvent.change(screen.getByTestId('desk-pose'), { target: { value: 'wave' } });
    expect(screen.getByTestId('director-desk').getAttribute('data-dirty')).toBe('true');
    // The second shot's camera: a push-in
    fireEvent.click(screen.getByTestId('desk-shot-2'));
    fireEvent.change(screen.getByTestId('desk-move'), { target: { value: 'push_in' } });
    fireEvent.click(screen.getByTestId('desk-save'));
    await waitFor(() =>
      expect(calls.some((c) => c.method === 'PUT' && c.url.endsWith(`/clips/${clip.id}/blocking`))).toBe(
        true,
      ),
    );
    const sent = JSON.parse(calls.find((c) => c.method === 'PUT')!.body!);
    expect(sent.fix).toBe(false);
    expect(sent.blocking.shots[clip.shots[0]!.id].marks[rosie.id].pose).toBe('wave');
    expect(sent.blocking.shots[clip.shots[1]!.id].camera.end).not.toBeNull();
    await waitFor(() => expect(screen.getByTestId('director-desk').getAttribute('data-dirty')).toBe('false'));
    // Block with AI is a job
    fireEvent.click(screen.getByTestId('desk-ai'));
    await waitFor(() =>
      expect(calls.some((c) => c.url.endsWith(`/clips/${clip.id}/blocking/generate`))).toBe(true),
    );
  });

  it('lists what breaks the scene: a camera moved over the line', async () => {
    const { clip, rosie } = setup();
    const crossed = structuredClone(clip);
    const cam = crossed.blocking!.shots[crossed.shots[1]!.id]!.camera;
    Object.assign(cam, { z: -cam.z, targetZ: -cam.targetZ });
    render(<DirectorDesk clip={crossed} onClose={() => {}} />);
    const issues = screen.getAllByTestId('desk-issue');
    expect(issues.map((i) => i.getAttribute('data-code'))).toContain('line_crossed');
    expect(screen.getByTestId(`desk-actor-${rosie.id}`).getAttribute('data-facing')).toBe('0');
  });
});
