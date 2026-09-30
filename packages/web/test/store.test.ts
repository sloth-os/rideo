import { docPath, evaluateWorkflow, type Job } from '@rideo/shared';
import * as f from '@rideo/shared/testing';
import { describe, expect, it } from 'vitest';
import { emptySlice, type ProjectSlice, reduceEvent, useProject } from '../src/store/project';

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

describe('optimistic timeline edits', () => {
  it('apply locally, confirm with the server result, roll back on rejection', () => {
    const docs = f.docs();
    useProject.setState({ ...slice(), docs, loading: false });
    const media = f.media({ durationSec: 8 });
    const track = 'trk_primaryvideo01';
    const rollback = useProject.getState().applyLocalOps([
      {
        op: 'insert',
        trackId: track,
        item: { kind: 'video', source: { type: 'media', media }, in: 0, out: 8 },
      },
    ]);
    const local = useProject.getState().docs!.timeline!;
    expect(local.tracks[0]!.items).toHaveLength(1);
    rollback();
    expect(useProject.getState().docs!.timeline ?? null).toBeNull();
    const again = useProject.getState().applyLocalOps([
      {
        op: 'insert',
        trackId: track,
        item: { kind: 'video', source: { type: 'media', media }, in: 0, out: 4 },
      },
    ]);
    const server = { ...useProject.getState().docs!.timeline!, fps: 25 };
    useProject.getState().confirmTimeline(server);
    again(); // a late rollback must not undo the confirmed server state
    expect(useProject.getState().docs!.timeline!.fps).toBe(25);
    expect(() =>
      useProject.getState().applyLocalOps([{ op: 'remove', itemId: 'itm_doesnotexist0000' }]),
    ).toThrow();
    useProject.getState().clear();
  });
});
