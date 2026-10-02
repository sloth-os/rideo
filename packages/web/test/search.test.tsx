import {
  emptyTimeline,
  evaluateWorkflow,
  type SearchResponse,
  type SearchStatus,
  type TimelineOp,
} from '@rideo/shared';
import * as f from '@rideo/shared/testing';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OverlayPicker } from '../src/features/editor/OverlayPicker';
import { SearchView } from '../src/features/search/SearchView';
import { emptySlice, useProject } from '../src/store/project';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const footage = f.media({ path: 'media/uploads/harbour-0123456789ab.mp4', durationSec: 8 });
const take = f.media({ path: 'media/takes/take-0123456789ab.mp4', durationSec: 5 });
const status: SearchStatus = {
  mode: 'words',
  indexed: 3,
  pending: 1,
  failed: 0,
  files: 2,
  updatedAt: '2026-10-02T00:00:00.000Z',
  usedAt: null,
  job: null,
};
const response: SearchResponse = {
  query: 'harbour',
  mode: 'words',
  indexed: 3,
  pending: 1,
  results: [
    {
      source: { kind: 'resource', resourceId: 'res_000000000001' },
      media: footage,
      at: 6,
      caption: 'Boats in the harbour at night, wide shot.',
      names: [],
      score: 1,
      label: 'harbour.mp4',
    },
    {
      source: {
        kind: 'take',
        clipId: 'clp_000000000001',
        shotId: 'sht_000000000001',
        takeId: 'tak_000000000001',
      },
      media: take,
      at: 2.5,
      caption: 'Mira on the harbour wall, medium shot.',
      names: ['Mira'],
      score: 0.5,
      label: 'Clip 1 · shot 1: the harbour wall',
    },
  ],
};

let calls: { url: string; method: string }[];
beforeEach(() => {
  const docs = f.docs();
  useProject.setState({ ...emptySlice, projectId: docs.project.id, docs, workflow: evaluateWorkflow(docs) });
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method ?? 'GET' });
      if (url.includes('/search/status')) return new Response(JSON.stringify(status));
      if (url.includes('/search/index'))
        return new Response(JSON.stringify({ job: { id: 'job_000000000001', kind: 'search.index' } }), {
          status: 202,
        });
      if (url.includes('/search?')) return new Response(JSON.stringify(response));
      return new Response('{}');
    }),
  );
});

function Where() {
  return <p data-testid="where">{useLocation().pathname}</p>;
}

describe('search view (docs/design/search.md#searching)', () => {
  it('shows the index, indexes, searches by kind and shows where a result is', async () => {
    const pid = useProject.getState().projectId!;
    render(
      <MemoryRouter initialEntries={[`/p/${pid}/search`]}>
        <Routes>
          <Route path="/p/:projectId/search" element={<SearchView />} />
          <Route path="*" element={<Where />} />
        </Routes>
      </MemoryRouter>,
    );
    expect((await screen.findByTestId('search-status')).textContent).toContain(
      '3 frames indexed in 2 files · 1 waiting',
    );
    expect(screen.getByTestId('search-mode').textContent).toContain('by words');
    fireEvent.click(screen.getByTestId('search-index'));
    await waitFor(() =>
      expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/search/index'))).toBe(true),
    );

    fireEvent.change(screen.getByTestId('search-input'), { target: { value: 'harbour' } });
    fireEvent.click(screen.getByTestId('search-submit'));
    expect(await screen.findAllByTestId('search-result')).toHaveLength(2);
    expect(screen.getByTestId('search-summary').textContent).toContain(
      '2 results, matched by words · 1 frames',
    );
    expect(screen.getAllByTestId('result-caption')[0]?.textContent).toContain(
      'Boats in the harbour at night',
    );
    // the video opens at the matched frame
    expect(screen.getAllByTestId('result-video')[0]!.getAttribute('src')).toMatch(/#t=6$/);

    fireEvent.click(screen.getByTestId('search-kind-take'));
    await waitFor(() => expect(calls.at(-1)!.url).toContain('kinds=take'));
    fireEvent.click((await screen.findAllByTestId('result-show'))[1]!);
    expect((await screen.findByTestId('where')).textContent).toContain(`/p/${pid}/clips`);
    expect(useProject.getState().highlight).toMatchObject({ kind: 'take', id: 'tak_000000000001' });
  });
});

describe('overlay picker search', () => {
  it('finds footage by what it shows and adds it at the playhead from a second before the match', async () => {
    const apply = vi.fn<(ops: TimelineOp[]) => void>();
    render(
      <OverlayPicker
        open
        onClose={() => undefined}
        timeline={emptyTimeline({ fps: 24, width: 1920, height: 1080 })}
        time={4}
        apply={apply}
      />,
    );
    fireEvent.change(screen.getByTestId('overlay-search'), { target: { value: 'boats at night' } });
    fireEvent.submit(screen.getByTestId('overlay-search'));
    await waitFor(() =>
      expect(calls.at(-1)!.url).toMatch(/search\?q=boats\+at\+night&kinds=take%2Cresource&limit=12$/),
    );
    const options = await screen.findAllByTestId('overlay-option');
    expect(options[0]?.textContent).toContain('Boats in the harbour at night');
    fireEvent.click(options[0]!);
    const ops = apply.mock.calls[0]![0];
    expect(ops[0]).toMatchObject({ op: 'add_track', track: { kind: 'video' } });
    // 5 s of the 8 s file, ending at its end: from 3 s (not 5 s, a second before the match)
    expect(ops[1]).toMatchObject({
      op: 'insert',
      item: { start: 4, in: 3, out: 8, source: { type: 'media', resourceId: 'res_000000000001' } },
    });
  });
});
