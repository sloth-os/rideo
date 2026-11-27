import {
  boardPromptHash,
  type Clip,
  clipBoardSubject,
  type Job,
  type ProjectDocs,
  ProjectSettingsSchema,
  type Shot,
  type ShotBoard,
  StageReviewSchema,
  shotContextOf,
} from '@rideo/shared';
import * as f from '@rideo/shared/testing';
import { describe, expect, it } from 'vitest';
import { batchGenerate } from '../../src/jobs/handlers/clips';
import type { HandlerDeps } from '../../src/jobs/handlers/common';
import type { JobContext } from '../../src/jobs/queue';

/**
 * The production batch and its storyboards (docs/design/ai-review.md#production-storyboards): a scene whose review
 * passed has its frames approved again only when none of them needs drawing; a frame outdated without the review's
 * subject changing (a prompt changed by an upgrade) makes the batch storyboard the scene again (drawn and reviewed)
 * before its video.
 */

const NOW = '2026-11-01T00:00:00.000Z';

/** A batch over one production scene of one shot, its frame approved or not, current or outdated. */
function world(frame: { approved: boolean; current: boolean }) {
  const settings = ProjectSettingsSchema.parse({
    targetDurationSec: 10,
    storyboard: { production: true },
  });
  const project = f.project({ settings });
  const shot = f.shot({ index: 0, durationSec: 10 });
  const clip = f.clip({ index: 0, shots: [shot] });
  let docs: ProjectDocs = f.docs({ project, clips: f.byId([clip]) });
  const boardOf = (s: Shot, opts: { approved: boolean; current: boolean; hash: string }): ShotBoard => ({
    keyframe: f.imageMedia({ hash: opts.hash }),
    createdAt: NOW,
    request: { prompt: 'p', seed: 1, referenceCount: 0 },
    promptHash: opts.current ? boardPromptHash(shotContextOf(s, docs)) : 'drawn-from-an-older-prompt',
    consistency: f.report(),
    characterLocks: {},
    elementLocks: {},
    audio: null,
    sheet: null,
    gatewayTaskIds: [],
    approved: opts.approved,
    approvedAt: opts.approved ? NOW : null,
    approvedBy: null,
    seen: null,
  });
  /** The scene's storyboard review passed on the clip as it is. */
  const passed = (c: Clip): Clip => ({
    ...c,
    boardReview: StageReviewSchema.parse({
      stage: 'storyboard',
      status: 'succeeded',
      subject: clipBoardSubject(c),
      verdict: { passed: true, score: 8 },
      createdAt: NOW,
      updatedAt: NOW,
    }),
  });
  const setClip = (c: Clip) => {
    docs = { ...docs, clips: { [c.id]: c } };
  };
  const withBoard = (c: Clip, opts: { approved: boolean; current: boolean; hash: string }): Clip => ({
    ...c,
    shots: c.shots.map((s) => ({ ...s, board: boardOf(s, opts) })),
  });
  setClip(passed(withBoard(clip, { ...frame, hash: 'kf-1' })));

  const events: string[] = [];
  const jobs = new Map<string, Job>();
  let ids = 0;
  const ctx = {
    job: { id: 'job_batch', projectId: 'prj_1', branch: 'main', params: {} },
    signal: new AbortController().signal,
    log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    actor: { type: 'system', id: 'jobs' },
    progress: () => {},
    gatewayTask: () => {},
    spawn: async (kind: string, params: Record<string, unknown>) => {
      events.push(kind);
      const c = docs.clips[params.clipId as string]!;
      // the storyboard draws the scene's outdated frames again, reviews them and approves them on a pass
      if (kind === 'clip.storyboard')
        setClip(passed(withBoard(c, { approved: true, current: true, hash: 'kf-2' })));
      const job = { id: `job_${++ids}`, kind, status: 'succeeded' } as unknown as Job;
      jobs.set(job.id, job);
      return job;
    },
    waitFor: async (jobIds: string[]) => jobIds.map((id) => jobs.get(id)!),
  } as unknown as JobContext;
  const deps = {
    projects: { docs: async () => docs },
    jobs: { find: (id: string) => jobs.get(id) },
    config: { gateway: { configured: false } },
    services: {
      storyboard: {
        approveFrames: async (_actor: unknown, _projectId: string, clipId: string) => {
          events.push('approveFrames');
          // only current frames can be approved (boardApprovable)
          const c = docs.clips[clipId]!;
          setClip({
            ...c,
            shots: c.shots.map((s) =>
              s.board && s.board.promptHash === boardPromptHash(shotContextOf(s, docs))
                ? { ...s, board: { ...s.board, approved: true } }
                : s,
            ),
          });
        },
      },
      clips: { recheck: async () => {} },
    },
  } as unknown as HandlerDeps;
  return { run: () => batchGenerate(deps, ctx), events, docs: () => docs };
}

describe('the production batch and storyboards whose review passed', () => {
  it('storyboards a scene again when an approved frame is outdated, then generates its video', async () => {
    const w = world({ approved: true, current: false });
    const result = await w.run();
    expect(w.events).toEqual(['clip.storyboard', 'clip.generate']);
    expect(result.stopReason).toBe('target reached');
    expect(Object.values(w.docs().clips)[0]!.shots[0]!.board?.keyframe.hash).toBe('kf-2');
  });

  it('storyboards a scene whose frame is outdated and not approved, never approving it as it is', async () => {
    const w = world({ approved: false, current: false });
    const result = await w.run();
    expect(w.events).toEqual(['clip.storyboard', 'clip.generate']);
    expect(result.stopReason).toBe('target reached');
  });

  it('only approves frames that are current but not approved, then generates the video', async () => {
    const w = world({ approved: false, current: true });
    const result = await w.run();
    expect(w.events).toEqual(['approveFrames', 'clip.generate']);
    expect(result.stopReason).toBe('target reached');
  });

  it('generates the video of a scene whose frames are current and approved', async () => {
    const w = world({ approved: true, current: true });
    await w.run();
    expect(w.events).toEqual(['clip.generate']);
  });
});
