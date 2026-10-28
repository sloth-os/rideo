import {
  applyOps,
  docPath,
  emptyTimeline,
  evaluateWorkflow,
  type Job,
  type ProjectDocs,
  type TimelineOp,
} from '@rideo/shared';
import * as f from '@rideo/shared/testing';
import { describe, expect, it, vi } from 'vitest';
import { api } from '../src/lib/api';
import { emptySlice, type ProjectSlice, reduceEvent, replayEdits, useProject } from '../src/store/project';

const agent = { kind: 'agent' as const, id: 'claude-code', name: 'Claude Code' };

function slice(): ProjectSlice {
  const docs = f.docs();
  return {
    ...emptySlice,
    projectId: docs.project.id,
    docs,
    workflow: evaluateWorkflow(docs),
    head: { branch: 'main', commit: 'c0' },
  };
}

const commit = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  parents: ['c0'],
  author: agent,
  message: 'Lock character',
  timestamp: '2026-09-30T10:00:00.000Z',
  changes: [],
  branch: 'main',
  ...extra,
});

describe('loading a project (docs/design/realtime-sync.md#ordering-and-consistency)', () => {
  const state = () => {
    const docs = f.docs();
    return { seq: 3, head: { branch: 'main', commit: 'c1' }, docs, jobs: [], syncIssues: [] };
  };
  const deferred = <T>() => {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  };

  it('renders from the state without waiting for the history, which fills in when it arrives', async () => {
    useProject.setState({ ...emptySlice });
    const s = state();
    const history = deferred<any[]>();
    vi.spyOn(api, 'state').mockResolvedValue(s as never);
    vi.spyOn(api, 'history').mockReturnValue(history.promise as never);
    const loaded = await useProject.getState().load(s.docs.project.id);
    expect(loaded.docs).toBe(s.docs);
    expect(useProject.getState().commits).toEqual([]);
    history.resolve([commit('c1')]);
    await vi.waitFor(() => expect(useProject.getState().commits.map((c) => c.id)).toEqual(['c1']));
    vi.restoreAllMocks();
  });

  it('keeps a history that arrives before the state', async () => {
    useProject.setState({ ...emptySlice });
    const s = state();
    const slow = deferred<any>();
    vi.spyOn(api, 'state').mockReturnValue(slow.promise as never);
    vi.spyOn(api, 'history').mockResolvedValue([commit('c1'), commit('c0')] as never);
    const loading = useProject.getState().load(s.docs.project.id);
    await new Promise((r) => setTimeout(r, 0));
    slow.resolve(s);
    const loaded = await loading;
    expect(loaded.commits.map((c) => c.id)).toEqual(['c1', 'c0']);
    vi.restoreAllMocks();
  });
});

describe('reduceEvent', () => {
  it('applies committed documents, recomputes the workflow and marks remote changes', () => {
    const s = slice();
    const c = f.character();
    const { next, refetch } = reduceEvent(s, 1, {
      kind: 'commit',
      commit: commit('c1'),
      docs: { [docPath.character(c.id)]: c },
    });
    expect(refetch).toBe(false);
    expect(next.docs!.characters[c.id]).toEqual(c);
    expect(next.workflow!.stages[1]!.gate!.requirements.find((r) => r.id === 'characters.nonEmpty')?.ok).toBe(
      true,
    );
    expect(next.commits[0]!.id).toBe('c1');
    expect(next.head!.commit).toBe('c1');
    expect(next.touched[`character:${c.id}`]).toBeGreaterThan(0);
    expect(next.seq).toBe(1);
  });

  it('replaces coalesced commits and refetches when documents are not inline', () => {
    let s = slice();
    s = reduceEvent(s, 1, { kind: 'commit', commit: commit('c1'), docs: {} }).next;
    const r = reduceEvent(s, 2, {
      kind: 'commit',
      commit: commit('c2', { meta: { replaces: 'c1' } }),
      docs: null,
    });
    expect(r.refetch).toBe(true);
    expect(r.next.commits.map((c) => c.id)).toEqual(['c2']);
  });

  it('ignores document changes of other branches but keeps their history entry', () => {
    const s = slice();
    const c = f.character();
    const r = reduceEvent(s, 1, {
      kind: 'commit',
      commit: commit('x1', { branch: 'alt' }),
      docs: { [docPath.character(c.id)]: c },
    });
    expect(r.next.docs!.characters[c.id]).toBeUndefined();
    expect(r.next.commits[0]!.id).toBe('x1');
  });

  it('upserts jobs, records activity and sync issues, and refetches on head changes', () => {
    const s = slice();
    const job = { id: 'job_01m3s0000000000000', status: 'running', kind: 'shot.generate' } as unknown as Job;
    const withJob = reduceEvent(s, 1, { kind: 'job', job }).next;
    expect(withJob.jobs[job.id]).toBe(job);
    const act = reduceEvent(withJob, 2, {
      kind: 'activity',
      actor: agent,
      action: 'tool:character_lock',
      summary: 'Claude Code → character_lock',
      at: '2026-09-30T10:00:00.000Z',
    }).next;
    expect(act.activity[0]!.summary).toContain('character_lock');
    const issue = reduceEvent(act, 3, { kind: 'sync-issue', path: 'screenplay.json', error: 'bad' }).next;
    const again = reduceEvent(issue, 4, { kind: 'sync-issue', path: 'screenplay.json', error: 'worse' }).next;
    expect(again.syncIssues).toEqual([{ path: 'screenplay.json', error: 'worse' }]);
    expect(reduceEvent(again, 5, { kind: 'head', branch: 'alt', commit: 'z' }).refetch).toBe(true);
  });
});

describe('optimistic timeline edits (docs/design/editor.md#operations)', () => {
  const media = f.media({ durationSec: 8 });
  const track = 'trk_primaryvideo01';
  const insert = (id: string, out: number): TimelineOp => ({
    op: 'insert',
    trackId: track,
    item: { id, kind: 'video', source: { type: 'media', media }, in: 0, out },
  });
  const ids = () => useProject.getState().docs!.timeline!.tracks[0]!.items.map((i) => i.id);
  /** The server's copy: the project's empty timeline at 25 fps (so it can be told apart) with the given ops. */
  const server = (docs: ProjectDocs, ...ops: TimelineOp[]) =>
    applyOps(
      emptyTimeline({
        fps: 25,
        width: docs.project.settings.resolution.width,
        height: docs.project.settings.resolution.height,
      }),
      ops,
    );

  /** A loaded project (its id and documents) in the store. */
  const open = () => {
    const s = slice();
    useProject.setState({ ...s, loading: false });
    return { docs: s.docs!, pid: s.projectId! };
  };

  it('queue locally, replay the rest on each answer, and drop a refused edit', () => {
    const { docs, pid } = open();
    const store = useProject.getState;
    store().applyLocalOps([insert('itm_first00000000000', 8)]);
    store().applyLocalOps([insert('itm_second0000000000', 4)]);
    expect(store().pendingEdits).toHaveLength(2);
    expect(ids()).toEqual(['itm_first00000000000', 'itm_second0000000000']);
    // the first is answered: the second replays on the server's copy, so nothing jumps back
    const first = server(docs, insert('itm_first00000000000', 8));
    store().confirmEdit(pid, first);
    expect(store().pendingEdits).toHaveLength(1);
    expect(store().serverTimeline).toBe(first);
    expect(store().docs!.timeline!.fps).toBe(25);
    expect(ids()).toEqual(['itm_first00000000000', 'itm_second0000000000']);
    // an answer for another project changes nothing
    store().confirmEdit('prj_someotherproject', server(docs));
    expect(store().pendingEdits).toHaveLength(1);
    // the second is refused: the server's copy is shown
    store().rejectEdit(pid);
    expect(store().pendingEdits).toEqual([]);
    expect(store().docs!.timeline).toEqual(first);
    // invalid ops throw before anything is queued
    expect(() => store().applyLocalOps([{ op: 'remove', itemId: 'itm_doesnotexist0000' }])).toThrow();
    expect(store().pendingEdits).toEqual([]);
    store().clear();
  });

  it('a refused first edit of a project without a timeline leaves it without one', () => {
    const { docs } = open();
    useProject.getState().applyLocalOps([insert('itm_first00000000000', 8)]);
    expect(ids()).toEqual(['itm_first00000000000']);
    useProject.getState().rejectEdit(docs.project.id);
    expect(useProject.getState().docs!.timeline).toBeNull();
    useProject.getState().clear();
  });

  it('skips a queued edit that no longer applies until the server refuses it', () => {
    const docs = f.docs();
    const base = server(docs, insert('itm_first00000000000', 8));
    const gone: TimelineOp[] = [{ op: 'remove', itemId: 'itm_first00000000000' }];
    const shown = replayEdits(base, [gone, gone, [insert('itm_second0000000000', 4)]], () => server(docs));
    expect(shown!.tracks[0]!.items.map((i) => i.id)).toEqual(['itm_second0000000000']);
    expect(replayEdits(null, [], () => server(docs))).toBeNull();
  });

  it('keeps the shown timeline when a commit changes it while edits are pending, and catches up after', () => {
    const { docs, pid } = open();
    const store = useProject.getState;
    store().applyLocalOps([insert('itm_first00000000000', 8)]);
    // the first edit's own commit, or anyone's: which pending edits it includes is unknown
    const theirs = server(docs, insert('itm_theirs0000000000', 2));
    const c = f.character();
    store().applyEvent(1, {
      kind: 'commit',
      commit: commit('c1'),
      docs: { 'timeline.json': theirs, [docPath.character(c.id)]: c },
    });
    expect(ids()).toEqual(['itm_first00000000000']);
    expect(store().docs!.characters[c.id]).toEqual(c);
    expect(store().timelineBehind).toBe(true);
    // answered, then fetched: the shown timeline is the server's
    store().confirmEdit(
      pid,
      server(docs, insert('itm_theirs0000000000', 2), insert('itm_first00000000000', 8)),
    );
    expect(store().timelineBehind).toBe(true);
    const fetched = server(docs, insert('itm_theirs0000000000', 2), insert('itm_first00000000000', 8));
    store().confirmTimeline(fetched);
    expect(store().timelineBehind).toBe(false);
    expect(ids()).toEqual(['itm_theirs0000000000', 'itm_first00000000000']);
    // with nothing pending a commit's timeline is shown at once
    const later = server(docs, insert('itm_later00000000000', 3));
    store().applyEvent(2, { kind: 'commit', commit: commit('c2'), docs: { 'timeline.json': later } });
    expect(store().docs!.timeline).toEqual(later);
    expect(store().serverTimeline).toEqual(later);
    store().clear();
  });

  it('a reload while edits are pending keeps the shown timeline and marks it behind', async () => {
    const { docs } = open();
    useProject.getState().applyLocalOps([insert('itm_first00000000000', 8)]);
    const reloaded = { ...docs, timeline: server(docs, insert('itm_theirs0000000000', 2)) };
    vi.spyOn(api, 'state').mockResolvedValue({
      seq: 9,
      head: { branch: 'main', commit: 'c9' },
      docs: reloaded,
      jobs: [],
      syncIssues: [],
    } as unknown as Awaited<ReturnType<typeof api.state>>);
    vi.spyOn(api, 'history').mockResolvedValue([]);
    await useProject.getState().refresh();
    expect(ids()).toEqual(['itm_first00000000000']);
    expect(useProject.getState().pendingEdits).toHaveLength(1);
    expect(useProject.getState().timelineBehind).toBe(true);
    vi.restoreAllMocks();
    useProject.getState().clear();
  });
});
