import { evaluateWorkflow } from '@rideo/shared';
import * as f from '@rideo/shared/testing';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PerformanceRecorder } from '../src/features/clips/PerformanceRecorder';
import { emptySlice, useProject } from '../src/store/project';

vi.mock('../src/engine/prepare', () => ({
  // recorders write no length in the header: the probe has none
  prepareMedia: async () => ({
    probe: { formatName: 'matroska,webm', durationSec: 0, hasVideo: true, hasAudio: true },
    poster: null,
  }),
}));
vi.mock('../src/engine/media-files', () => ({ rememberUpload: () => undefined }));

/** A camera that hands out one track, and a recorder that yields one chunk when stopped. */
class FakeRecorder {
  static isTypeSupported = (t: string) => t === 'video/webm;codecs=vp8,opus';
  state: 'inactive' | 'recording' = 'inactive';
  mimeType: string;
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  constructor(_stream: unknown, opts?: { mimeType?: string }) {
    this.mimeType = opts?.mimeType ?? '';
  }
  start() {
    this.state = 'recording';
  }
  stop() {
    this.state = 'inactive';
    this.ondataavailable?.({ data: new Blob(['webm-bytes'], { type: 'video/webm' }) });
    this.onstop?.();
  }
}

let stopped = 0;
let calls: { url: string; method: string; body?: unknown }[];
beforeEach(() => {
  const docs = f.docs();
  useProject.setState({ ...emptySlice, projectId: docs.project.id, docs, workflow: evaluateWorkflow(docs) });
  stopped = 0;
  calls = [];
  const track = { stop: () => stopped++ };
  vi.stubGlobal('navigator', {
    ...navigator,
    mediaDevices: { getUserMedia: vi.fn(async () => ({ getTracks: () => [track] })) },
  });
  vi.stubGlobal('MediaRecorder', FakeRecorder);
  vi.stubGlobal(
    'URL',
    Object.assign(URL, { createObjectURL: () => 'blob:take', revokeObjectURL: () => undefined }),
  );
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method ?? 'GET', body: init?.body });
      if (url.endsWith('/uploads'))
        return new Response(JSON.stringify({ id: 'res_00000000perf', media: f.media() }), { status: 201 });
      return new Response('{}');
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('performance recorder (docs/design/performance.md#recording-in-the-studio)', () => {
  it('counts down, records up to the shot length, and makes the recording the shot performance', async () => {
    const clip = f.clip({ id: 'clp_000000000001', index: 0 });
    const shot = f.shot({ id: 'sht_000000000001', index: 1, durationSec: 2 });
    const onClose = vi.fn();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<PerformanceRecorder open onClose={onClose} clip={clip} shot={shot} />);
    const recorder = screen.getByTestId('performance-recorder');
    await waitFor(() => expect(recorder.dataset.phase).toBe('ready'));
    fireEvent.click(screen.getByTestId('performance-record'));
    expect(screen.getByTestId('performance-countdown').textContent).toBe('3');
    // one second per number: each re-render starts the next
    for (const left of ['2', '1']) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
      expect(screen.getByTestId('performance-countdown').textContent).toBe(left);
    }
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(recorder.dataset.phase).toBe('recording');
    // stops on its own at the shot's 2 s
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2200);
    });
    expect(recorder.dataset.phase).toBe('recorded');
    expect(screen.getByTestId('performance-playback').getAttribute('src')).toBe('blob:take');

    fireEvent.click(screen.getByTestId('performance-use'));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    const upload = calls.find((c) => c.url.endsWith('/uploads'))!;
    const form = upload.body as FormData;
    expect((form.get('file') as File).name).toBe('performance-c1-s2.webm');
    const meta = JSON.parse(form.get('meta') as string);
    expect(meta.role).toBe('reference');
    // the length from the recording's clock
    expect(meta.probe.durationSec).toBeGreaterThan(1.9);
    const patch = calls.find((c) => c.method === 'PATCH')!;
    expect(patch.url).toContain(`/clips/${clip.id}/shots/${shot.id}`);
    expect(JSON.parse(patch.body as string)).toEqual({
      motionReference: { resourceId: 'res_00000000perf', mode: 'performance' },
    });
  });

  it('releases the camera when it closes, and says when it is blocked', async () => {
    const clip = f.clip();
    const shot = f.shot();
    const { rerender } = render(
      <PerformanceRecorder open onClose={() => undefined} clip={clip} shot={shot} />,
    );
    await waitFor(() => expect(screen.getByTestId('performance-recorder').dataset.phase).toBe('ready'));
    rerender(<PerformanceRecorder open={false} onClose={() => undefined} clip={clip} shot={shot} />);
    expect(stopped).toBe(1);
    vi.stubGlobal('navigator', {
      ...navigator,
      mediaDevices: { getUserMedia: vi.fn(async () => Promise.reject(new Error('NotAllowedError'))) },
    });
    rerender(<PerformanceRecorder open onClose={() => undefined} clip={clip} shot={shot} />);
    await waitFor(() => expect(screen.getByTestId('performance-recorder').dataset.phase).toBe('denied'));
    expect(screen.getByTestId('performance-recorder').textContent).toContain('blocked');
  });
});
