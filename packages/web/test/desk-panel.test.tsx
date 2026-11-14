import { DESK_STATE_FORMAT, DESK_STATE_VERSION, type DeskState, evaluateWorkflow } from '@rideo/shared';
import * as f from '@rideo/shared/testing';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import {
  DESK_CONFLICT_NOTICE,
  type DeskBridgeOptions,
  DeskStateConflict,
  type DeskStatus,
} from '../src/features/desk/bridge';
import { DeskPanel } from '../src/features/desk/DeskPanel';
import { ApiError, type PublicConfig } from '../src/lib/api';
import { useConfigStore } from '../src/lib/config';
import { emptySlice, useProject } from '../src/store/project';

/**
 * The desk panel's wiring (docs/design/director-desk.md#the-desk): what it gives its bridge (the stored state's
 * routes, the precondition and the close timeout's AbortSignal as fetch sees them), what it does when it goes away
 * without Close or gets another clip, and the confirmations before Replace and Start over. The bridge itself is a
 * fake here: desk-bridge.test.ts drives the real one.
 */

/** A bridge the panel made: its options, and what the panel asked of it, in order. */
interface MadeBridge {
  opts: DeskBridgeOptions;
  calls: string[];
}
const made = vi.hoisted(() => [] as MadeBridge[]);

vi.mock('../src/features/desk/bridge', async (original) => {
  const actual = await original<typeof import('../src/features/desk/bridge')>();
  class FakeBridge implements MadeBridge {
    calls: string[] = [];
    constructor(readonly opts: DeskBridgeOptions) {
      made.push(this);
    }
    start() {
      this.calls.push('start');
      this.opts.onStatus({
        phase: 'connecting',
        line: 'Connecting to the desk…',
        exportUnavailable: null,
        failure: null,
        remedy: null,
        kept: null,
      });
    }
    flush() {
      this.calls.push('flush');
    }
    dispose() {
      this.calls.push('dispose');
    }
    async close() {
      this.calls.push('close');
    }
    retry() {
      this.calls.push('retry');
    }
    startOver() {
      this.calls.push('startOver');
    }
    replace() {
      this.calls.push('replace');
    }
    // the iframe's load (jsdom may fire it for about:blank) is not what these tests look at
    frameLoaded() {}
  }
  return { ...actual, DeskBridge: FakeBridge };
});

const DESK_URL = 'https://desk.example.com/app/desk.html';
const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const C = 'c'.repeat(64);
const STATE: DeskState = {
  format: DESK_STATE_FORMAT,
  version: DESK_STATE_VERSION,
  data: new Uint8Array([1, 2, 3]).buffer as ArrayBuffer,
};
const OPEN: DeskStatus = {
  phase: 'open',
  line: 'Opened from the stored desk',
  exportUnavailable: null,
  failure: null,
  remedy: null,
  kept: null,
};

type FetchCall = [url: string, init: RequestInit & { headers: Record<string, string> }];
let fetchMock: Mock<(...args: FetchCall) => Promise<Response>>;
let projectId: string;
let clipA: ReturnType<typeof f.clip>;
let clipB: ReturnType<typeof f.clip>;

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers as Record<string, string>) },
  });
const problem = (status: number, code: string, detail: string, headers: Record<string, string> = {}) =>
  json(
    { type: 'about:blank', title: 'Problem', status, detail, code },
    { status, headers: { 'content-type': 'application/problem+json', ...headers } },
  );
const saved = (hash: string) =>
  json({
    deskState: {
      format: DESK_STATE_FORMAT,
      version: DESK_STATE_VERSION,
      media: { path: `media/desk/scene-1-${hash.slice(0, 12)}.bin`, hash, mime: 'application/octet-stream' },
      updatedAt: '2026-11-14T00:00:00.000Z',
    },
  });

beforeEach(() => {
  made.length = 0;
  clipA = f.clip({ index: 0, title: 'The pier' });
  clipB = f.clip({ index: 1, title: 'The lighthouse' });
  const docs = f.docs({ clips: { [clipA.id]: clipA, [clipB.id]: clipB } });
  projectId = docs.project.id;
  useProject.setState({ ...emptySlice, projectId, docs, workflow: evaluateWorkflow(docs) });
  useConfigStore.setState({
    config: {
      version: 'test',
      brand: { name: 'Rideo', owner: '', url: '' },
      user: { id: 'u1', name: 'Ada' },
      features: { mcp: false, embeddedDav: false, davUrl: null, desk: { url: DESK_URL } },
    } as unknown as PublicConfig,
    loading: null,
  });
  fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const bridge = (i = 0): MadeBridge => {
  const b = made[i];
  if (!b) throw new Error(`no bridge ${i}`);
  return b;
};
const call = (i: number): FetchCall => {
  const c = fetchMock.mock.calls[i];
  if (!c) throw new Error(`no fetch call ${i}`);
  return c;
};

describe('the desk panel’s store and load (docs/design/director-desk.md#when-rideo-stores-it)', () => {
  it('sends the precondition the bridge names and forwards the close timeout’s AbortSignal to fetch', async () => {
    render(<DeskPanel clip={clipA} onClose={() => undefined} />);
    fetchMock.mockResolvedValueOnce(saved(B));
    const closing = new AbortController();
    await expect(bridge().opts.store(STATE, { ifMatch: A }, closing.signal)).resolves.toBe(B);
    const [url, init] = call(0);
    expect(url).toMatch(new RegExp(`/api/projects/${projectId}/clips/${clipA.id}/desk-state$`));
    expect(init.method).toBe('PUT');
    expect(init.signal).toBe(closing.signal);
    expect(init.headers).toMatchObject({
      'content-type': 'application/octet-stream',
      'x-desk-state-format': DESK_STATE_FORMAT,
      'x-desk-state-version': String(DESK_STATE_VERSION),
      'if-match': `"${A}"`,
    });
    expect(init.headers).not.toHaveProperty('if-none-match');
    expect([...new Uint8Array(init.body as Uint8Array)]).toEqual([1, 2, 3]);

    // none stored: If-None-Match: *; a write on the way out of the panel has no signal
    fetchMock.mockResolvedValueOnce(saved(C));
    await expect(bridge().opts.store(STATE, { ifNoneMatch: '*' })).resolves.toBe(C);
    expect(call(1)[1].headers).toMatchObject({ 'if-none-match': '*' });
    expect(call(1)[1].headers).not.toHaveProperty('if-match');
    expect(call(1)[1]).not.toHaveProperty('signal');
    // a state whose sha256 is not known: whatever is stored, unquoted
    fetchMock.mockResolvedValueOnce(saved(C));
    await bridge().opts.store(STATE, { ifMatch: '*' });
    expect(call(2)[1].headers).toMatchObject({ 'if-match': '*' });
  });

  it('aborting the signal aborts the upload (closing waits for it at most 10 seconds)', async () => {
    render(<DeskPanel clip={clipA} onClose={() => undefined} />);
    fetchMock.mockImplementationOnce(
      (_url, init) =>
        new Promise((_resolve, reject) =>
          init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))),
        ),
    );
    const closing = new AbortController();
    const pending = bridge().opts.store(STATE, { ifMatch: A }, closing.signal);
    closing.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('a 412 desk_state_conflict reaches the bridge as DeskStateConflict naming the stored state', async () => {
    render(<DeskPanel clip={clipA} onClose={() => undefined} />);
    fetchMock.mockResolvedValueOnce(
      problem(
        412,
        'desk_state_conflict',
        'the stored desk state of scene 1 is not the one this write replaces',
        {
          etag: `"${C}"`,
        },
      ),
    );
    const newer = await bridge()
      .opts.store(STATE, { ifMatch: A })
      .catch((err: unknown) => err);
    expect(newer).toBeInstanceOf(DeskStateConflict);
    expect(newer).toMatchObject({
      stored: C,
      message: 'the stored desk state of scene 1 is not the one this write replaces',
    });

    // cleared by another session: no ETag, none stored
    fetchMock.mockResolvedValueOnce(
      problem(412, 'desk_state_conflict', 'scene 1 has no stored desk state any more'),
    );
    const cleared = await bridge()
      .opts.store(STATE, { ifMatch: A })
      .catch((err: unknown) => err);
    expect(cleared).toBeInstanceOf(DeskStateConflict);
    expect(cleared).toMatchObject({ stored: null });

    // another failure stays what it is: the bridge retries it
    fetchMock.mockResolvedValueOnce(problem(503, 'storage_error', 'storage is not reachable'));
    const failed = await bridge()
      .opts.store(STATE, { ifMatch: A })
      .catch((err: unknown) => err);
    expect(failed).toBeInstanceOf(ApiError);
    expect(failed).not.toBeInstanceOf(DeskStateConflict);
    expect(failed).toMatchObject({ code: 'storage_error' });
  });

  it('loads with GET (404: none stored, the ETag is the sha256) and clears with DELETE (Start over)', async () => {
    render(<DeskPanel clip={clipA} onClose={() => undefined} />);
    fetchMock.mockResolvedValueOnce(problem(404, 'not_found', 'no desk state'));
    await expect(bridge().opts.load()).resolves.toBeNull();
    fetchMock.mockResolvedValueOnce(
      new Response(new Uint8Array([7, 8]), {
        headers: {
          'content-type': 'application/octet-stream',
          'x-desk-state-format': DESK_STATE_FORMAT,
          'x-desk-state-version': String(DESK_STATE_VERSION),
          etag: `"${A}"`,
        },
      }),
    );
    const state = await bridge().opts.load();
    expect(state).toMatchObject({ format: DESK_STATE_FORMAT, version: DESK_STATE_VERSION, sha256: A });
    expect([...new Uint8Array(state?.data ?? new ArrayBuffer(0))]).toEqual([7, 8]);
    expect(call(0)[1].method).toBe('GET');
    expect(call(0)[0]).toMatch(new RegExp(`/clips/${clipA.id}/desk-state$`));

    await bridge().opts.clear();
    expect(call(2)[1].method).toBe('DELETE');
    expect(call(2)[0]).toMatch(new RegExp(`/api/projects/${projectId}/clips/${clipA.id}/desk-state$`));
  });
});

describe('leaving the desk panel without Close (docs/design/director-desk.md#the-desk)', () => {
  it('stores the newest state on the way out: the panel flushes its bridge, then disposes it', () => {
    const { unmount } = render(<DeskPanel clip={clipA} onClose={() => undefined} />);
    expect(bridge().calls).toEqual(['start']);
    unmount();
    expect(bridge().calls).toEqual(['start', 'flush', 'dispose']);
  });

  it('another clip loads the desk again in a new iframe (its key) and connects afresh', async () => {
    const { rerender } = render(<DeskPanel clip={clipA} onClose={() => undefined} />);
    const first = screen.getByTestId('desk-frame');
    expect(first.getAttribute('src')).toBe(DESK_URL);

    rerender(<DeskPanel clip={clipB} onClose={() => undefined} />);
    const second = screen.getByTestId('desk-frame');
    expect(second).not.toBe(first);
    expect(first.isConnected).toBe(false);
    // the first clip's newest state was stored on the way out, then a new bridge started for the other clip
    expect(made.map((b) => b.calls)).toEqual([['start', 'flush', 'dispose'], ['start']]);
    expect(screen.getByTestId('desk-title').textContent).toBe('The lighthouse');
    fetchMock.mockResolvedValueOnce(problem(404, 'not_found', 'no desk state'));
    await bridge(1).opts.load();
    expect(call(0)[0]).toMatch(new RegExp(`/clips/${clipB.id}/desk-state$`));
  });
});

describe('the desk panel’s confirmations (docs/design/director-desk.md#the-desk)', () => {
  it('a kept state: the notice, and Replace only once the person confirms what it replaces', () => {
    render(<DeskPanel clip={clipA} onClose={() => undefined} />);
    expect(screen.queryByTestId('desk-kept')).toBeNull();
    act(() =>
      bridge().opts.onStatus({
        ...OPEN,
        line: 'The desk was not stored',
        kept: { reason: 'conflict', notice: DESK_CONFLICT_NOTICE },
      }),
    );
    expect(screen.getByTestId('desk-kept').getAttribute('data-reason')).toBe('conflict');
    expect(screen.getByTestId('desk-kept-notice').textContent).toBe(DESK_CONFLICT_NOTICE);

    fireEvent.click(screen.getByTestId('desk-replace'));
    expect(screen.getByTestId('desk-replace-what').textContent).toContain(
      'replaces the newer desk state another session stored for this clip',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByTestId('desk-replace-what')).toBeNull();
    expect(bridge().calls).not.toContain('replace');

    // kept because the desk could not read it: the confirmation says so
    act(() =>
      bridge().opts.onStatus({
        ...OPEN,
        line: 'Opened from the brief',
        kept: {
          reason: 'unreadable',
          notice: 'The stored desk state was kept: the desk could not read it (saved by a newer desk)',
        },
      }),
    );
    expect(screen.getByTestId('desk-kept').getAttribute('data-reason')).toBe('unreadable');
    fireEvent.click(screen.getByTestId('desk-replace'));
    expect(screen.getByTestId('desk-replace-what').textContent).toContain(
      'replaces the stored desk state, which this desk could not read',
    );
    fireEvent.click(screen.getByTestId('desk-replace-confirm'));
    expect(bridge().calls.filter((c) => c === 'replace')).toHaveLength(1);
    expect(screen.queryByTestId('desk-replace-what')).toBeNull();

    // stored as usual again: no notice
    act(() => bridge().opts.onStatus({ ...OPEN, line: 'Stored' }));
    expect(screen.queryByTestId('desk-kept')).toBeNull();
  });

  it('a stored state that cannot be loaded: Retry, and Start over only once the person confirms what is lost', () => {
    render(<DeskPanel clip={clipA} onClose={() => undefined} />);
    act(() =>
      bridge().opts.onStatus({
        ...OPEN,
        phase: 'failed',
        line: '',
        failure: 'The stored desk state could not be loaded: storage is not reachable',
        remedy: 'retry',
      }),
    );
    fireEvent.click(screen.getByTestId('desk-retry'));
    expect(bridge().calls).toContain('retry');

    fireEvent.click(screen.getByTestId('desk-start-over'));
    const what = screen.getByTestId('desk-start-over-what').textContent ?? '';
    expect(what).toContain('The stored desk state of this scene is cleared and the desk opens again');
    expect(what).toContain('from this browser’s own copy of the scene if it has one, else from the brief');
    expect(what).toContain('What was staged only in the stored desk state is lost');
    expect(bridge().calls).not.toContain('startOver');
    fireEvent.click(screen.getByTestId('desk-start-over-confirm'));
    expect(bridge().calls.filter((c) => c === 'startOver')).toHaveLength(1);
    expect(screen.queryByTestId('desk-start-over-what')).toBeNull();

    // a desk that never answered: the headers, neither Retry nor Start over
    act(() =>
      bridge().opts.onStatus({
        ...OPEN,
        phase: 'failed',
        line: '',
        failure: 'The desk did not answer',
        remedy: 'headers',
      }),
    );
    expect(screen.queryByTestId('desk-retry')).toBeNull();
    expect(screen.queryByTestId('desk-start-over')).toBeNull();
  });
});
