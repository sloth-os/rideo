import { describe, expect, it } from 'vitest';
import {
  assembleStageReview,
  assembleStoryTimeline,
  ClipReviewSchema,
  castReadyForReview,
  castReviewSubject,
  clipBoardReviewState,
  clipBoardSubject,
  clipGate,
  clipReviewSubject,
  clipReviewVerdict,
  cutReviewSubject,
  cutTakeItems,
  evaluateWorkflow,
  mergeSubjectReviews,
  ProjectSettingsSchema,
  reviewRequirement,
  StageReviewOutputSchema,
  StageReviewSchema,
  TakeWatchOutputSchema,
  takeWatchOf,
  watchVerdict,
  withWatch,
} from '../src';
import * as f from '../src/testing/fixtures';

const at = '2026-10-29T00:00:00.000Z';

describe('takes watched whole (docs/design/ai-review.md#takes-watched-whole)', () => {
  it('fails an attempt on a critical issue, low motion, physics or identity, or an action that does not happen', () => {
    const ok = TakeWatchOutputSchema.parse({
      overall: 8,
      motion: 0.9,
      physics: 0.8,
      action: 0.9,
      camera: 0.8,
      identity: 0.9,
    });
    expect(watchVerdict(ok, 0.5)).toEqual({ passed: true, issues: [] });
    const morph = TakeWatchOutputSchema.parse({
      ...ok,
      motion: 0.2,
      issues: [{ time: 2.5, severity: 'critical', title: 'The figure morphs' }],
    });
    expect(watchVerdict(morph, 0.5).issues).toEqual([
      'watched: The figure morphs at 2.5 s',
      'watched: motion 0.20 (morphing or flicker)',
    ]);
    expect(watchVerdict({ ...ok, action: 0.2 }, 0.5).passed).toBe(false);
    expect(watchVerdict({ ...ok, identity: 0.3 }, 0.5).passed).toBe(false);
    // Lenient: a model's strings and missing fields
    expect(TakeWatchOutputSchema.parse({ motion: '0.7' }).motion).toBe(0.7);
  });

  it('merges the watch into the quality verdict: it passes only when the watch passes', () => {
    const out = TakeWatchOutputSchema.parse({
      overall: 3,
      motion: 0.2,
      physics: 0.8,
      action: 0.9,
      camera: 0.8,
      identity: 0.9,
    });
    const watch = takeWatchOf(out, { model: 'vision-x', via: 'vision', qualityThreshold: 0.5 });
    expect(watch).toMatchObject({ passed: false, via: 'vision', overall: 3 });
    const q = withWatch(null, watch, watchVerdict(out, 0.5).issues);
    expect(q.passed).toBe(false);
    expect(q.watch?.model).toBe('vision-x');
    expect(q.issues[0]).toContain('motion');
  });
});

describe('the scene review verdict and the clip gate (docs/design/ai-review.md#the-clip-gate)', () => {
  const scores = {
    storytelling: 7,
    continuity: 6.5,
    character: 8,
    temporal: 7,
    physics: 7,
    realism: 7,
    cinematography: 7,
    editing: 7,
  };

  it('passes a scene at the threshold without critical issues or very low dimensions', () => {
    expect(clipReviewVerdict({ overall: 7, scores, issues: [] }, 6)).toEqual({
      passed: true,
      score: 7,
      blocking: [],
    });
    expect(clipReviewVerdict({ overall: 5.5, scores, issues: [] }, 6).blocking).toEqual(['score 5.5 of 6']);
    expect(
      clipReviewVerdict({ overall: 7, scores: { ...scores, continuity: 3 }, issues: [] }, 6).passed,
    ).toBe(false);
    const critical = ClipReviewSchema.shape.issues.parse([
      {
        id: 'i1',
        dimension: 'continuity',
        severity: 'critical',
        title: 'The ball changes side',
        start: 0,
        end: 1,
        source: 'vision',
        shot: 'C1·S2',
      },
    ]);
    expect(clipReviewVerdict({ overall: 8, scores, issues: critical }, 6).blocking[0]).toBe(
      'critical: C1·S2 The ball changes side',
    );
    expect(clipReviewVerdict({ overall: null, scores: {}, issues: [] }, 6).blocking).toEqual(['no scores']);
  });

  it('approves a clip only when every take passes its checks and watch, and the scene review is current and passed', () => {
    const rosie = f.character({ name: 'Rosie' });
    const watched = (passed: boolean) => {
      const out = TakeWatchOutputSchema.parse({ overall: passed ? 8 : 3, motion: passed ? 0.9 : 0.1 });
      return f.report({
        quality: withWatch(
          null,
          takeWatchOf(out, { model: 'v', via: 'vision', qualityThreshold: 0.5 }),
          watchVerdict(out, 0.5).issues,
        ),
      });
    };
    const shotOf = (passed: boolean, index: number) => {
      const t = f.take({ consistency: watched(passed), characterLocks: { [rosie.id]: rosie.lock.version } });
      return f.shot({ index, characterIds: [rosie.id], takes: [t], selectedTakeId: t.id, status: 'ready' });
    };
    const clip = f.clip({ shots: [shotOf(true, 0), shotOf(true, 1)] });
    const settings = ProjectSettingsSchema.parse({ review: { watchTakes: true } });
    const docs = (c: typeof clip) =>
      f.docs({ project: f.project({ settings }), characters: { [rosie.id]: rosie }, clips: { [c.id]: c } });
    // No scene review yet
    expect(clipGate(clip, docs(clip)).blocking).toEqual(['the scene review is missing']);
    const review = ClipReviewSchema.parse({
      status: 'succeeded',
      subject: clipReviewSubject(clip),
      overall: 7.5,
      scores,
      watched: 'video',
      heard: true,
      verdict: { passed: true, score: 7.5, blocking: [] },
      checkedAt: at,
    });
    const reviewed = { ...clip, review };
    expect(clipGate(reviewed, docs(reviewed))).toEqual({ ok: true, blocking: [] });
    // A take that failed its watch holds the clip back
    const bad = { ...reviewed, shots: [reviewed.shots[0]!, shotOf(false, 1)] };
    const g = clipGate({ ...bad, review: { ...review, subject: clipReviewSubject(bad) } }, docs(bad));
    expect(g.ok).toBe(false);
    expect(g.blocking[0]).toContain('shot 2');
  });
});

describe('the cast review subject', () => {
  it('changes with a reference, an identity or a wardrobe, not with approving or locking', () => {
    const rosie = f.character({ name: 'Rosie', references: [f.reference({ approved: false })] });
    const docs = f.docs({ characters: { [rosie.id]: rosie } });
    const subject = castReviewSubject(docs);
    expect(castReadyForReview(docs)).toBe(true);
    const approved = {
      ...rosie,
      references: rosie.references.map((r) => ({ ...r, approved: true })),
      lock: { ...rosie.lock, locked: true, version: 1 },
    };
    expect(castReviewSubject(f.docs({ characters: { [rosie.id]: approved } }))).toBe(subject);
    const redrawn = { ...rosie, references: [f.reference()] };
    expect(castReviewSubject(f.docs({ characters: { [rosie.id]: redrawn } }))).not.toBe(subject);
    expect(castReadyForReview(f.docs({ characters: { [rosie.id]: { ...rosie, references: [] } } }))).toBe(
      false,
    );
  });

  it('merges each subject’s answer and points its fixes at the character', () => {
    const rosie = f.character({ name: 'Rosie' });
    const out = (bad: boolean) =>
      StageReviewOutputSchema.parse({
        scores: { likeness: 8, consistency: bad ? 3 : 8, distinct: 8, clarity: 8, style: 8 },
        issues: bad ? [{ dimension: 'consistency', severity: 'critical', title: 'Views differ' }] : [],
        recommendations: bad
          ? [
              {
                dimension: 'consistency',
                priority: 1,
                title: 'Draw again',
                action: { kind: 'regenerate_refs', instruction: 'one face' },
              },
            ]
          : [],
      });
    const merged = mergeSubjectReviews([
      { name: 'Rosie', kind: 'character', out: out(true) },
      { name: 'Beach', kind: 'element', out: out(false) },
    ]);
    expect(merged.scores.consistency).toBe(5.5);
    const parts = assembleStageReview(
      'cast',
      merged,
      { scenes: new Map(), characters: new Map([['rosie', rosie.id]]), elements: new Map() },
      7,
    );
    expect(parts.verdict?.passed).toBe(false);
    expect(parts.issues[0]).toMatchObject({ characterId: rosie.id, severity: 'critical' });
    expect(parts.recommendations[0]?.action).toEqual({
      kind: 'regenerate_refs',
      characterId: rosie.id,
      instruction: 'one face',
    });
    expect(parts.recommendations[0]?.issueIds).toEqual(['i1']);
  });
});

describe('the gates of every step (docs/design/ai-review.md#the-gates)', () => {
  it('requires the cast review when it is on, and accepts continuing anyway for the current cast', () => {
    const rosie = f.character({ name: 'Rosie', references: [f.reference({ approved: true })] });
    const project = f.project({ settings: ProjectSettingsSchema.parse({ review: { cast: true } }) });
    const docs = f.docs({ project, characters: { [rosie.id]: rosie } });
    expect(reviewRequirement(docs, 'cast')).toMatchObject({ ok: false, message: 'Review the cast' });
    const review = StageReviewSchema.parse({
      stage: 'cast',
      status: 'succeeded',
      subject: castReviewSubject(docs),
      verdict: { passed: false, score: 5, blocking: ['score 5 of 7'] },
      createdAt: at,
      updatedAt: at,
    });
    expect(reviewRequirement({ ...docs, aiReviews: { cast: review } }, 'cast').ok).toBe(false);
    const overridden = {
      ...review,
      override: { by: f.project().workflow.approvals as never, at, note: '', subject: review.subject },
    };
    expect(
      reviewRequirement(
        {
          ...docs,
          aiReviews: {
            cast: {
              ...overridden,
              override: { by: { kind: 'user', id: 'u', name: 'U' }, at, note: '', subject: review.subject },
            },
          },
        },
        'cast',
      ).ok,
    ).toBe(true);
    // Off for older projects: their gates stay as they were
    const old = f.docs({ characters: { [rosie.id]: rosie } });
    expect(reviewRequirement(old, 'cast')).toMatchObject({ ok: true, message: 'The cast review is off' });
    const cast = evaluateWorkflow({
      ...docs,
      project: { ...project, workflow: { stage: 'cast', approvals: {} } },
    }).stages.find((s) => s.id === 'cast');
    expect(cast?.gate?.requirements.map((r) => r.id)).toContain('cast.reviewPassed');
  });

  it('makes the cut review current for the takes in the cut and the scenes they come from', () => {
    const t = f.take({ video: f.media({ durationSec: 4 }) });
    const s = f.shot({ index: 0, takes: [t], selectedTakeId: t.id });
    const clip = f.clip({ shots: [s], status: 'approved' });
    const timeline = assembleStoryTimeline({ clips: [clip], fps: 24, width: 320, height: 180 });
    const docs = f.docs({ clips: { [clip.id]: clip }, timeline });
    expect(cutTakeItems(docs).map((x) => x.takeId)).toEqual([t.id]);
    const subject = cutReviewSubject(docs);
    // Another take selected for the scene: the scene's review, and so the cut's, is out of date
    const t2 = f.take({ video: f.media({ durationSec: 4 }) });
    const changed = { ...clip, shots: [{ ...s, takes: [t, t2], selectedTakeId: t2.id }] };
    expect(cutReviewSubject({ ...docs, clips: { [clip.id]: changed } })).not.toBe(subject);
    expect(cutReviewSubject({ ...docs, timeline: null })).not.toBe(subject);
  });

  it('keeps a production scene’s storyboard review current while its frames are', () => {
    const s = f.shot({ index: 0 });
    const clip = f.clip({ shots: [s] });
    const review = StageReviewSchema.parse({
      stage: 'storyboard',
      status: 'succeeded',
      subject: clipBoardSubject(clip),
      verdict: { passed: true, score: 8, blocking: [] },
      createdAt: at,
      updatedAt: at,
    });
    expect(clipBoardReviewState({ ...clip, boardReview: review })).toBe('passed');
    expect(
      clipBoardReviewState({ ...clip, shots: [{ ...s, description: 'Changed' }], boardReview: review }),
    ).toBe('outdated');
    expect(clipBoardReviewState({ ...clip, boardReview: null })).toBe('missing');
  });
});
