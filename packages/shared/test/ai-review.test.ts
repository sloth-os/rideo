import { describe, expect, it } from 'vitest';
import {
  assembleStageReview,
  autoApplicable,
  carriedFixes,
  evaluateWorkflow,
  mergeSceneReviews,
  ProjectSettingsSchema,
  reviewRequirement,
  reviewState,
  reviseScenes,
  type StageReview,
  StageReviewOutputSchema,
  StageReviewSchema,
  screenplayReviewSubject,
  stageVerdict,
  storyboardReviewSubject,
} from '../src';
import * as f from '../src/testing/fixtures';

const at = '2026-10-28T00:00:00.000Z';

function screenplayDocs() {
  const rosie = f.character({ name: 'Rosie' });
  const sammy = f.character({ name: 'Sammy' });
  const sp = f.screenplay({
    outline: [
      {
        id: 'bea_0000000000aaaaaa',
        index: 0,
        title: 'Start',
        summary: 'They meet',
        estDurationSec: 30,
        sceneId: null,
        purpose: 'setup',
      },
    ],
    scenes: [
      {
        id: 'scn_0000000000aaaaaa',
        index: 0,
        beatId: 'bea_0000000000aaaaaa',
        heading: 'EXT. PIER - DAY',
        location: 'Pier',
        timeOfDay: 'day',
        summary: 'Rosie meets Sammy',
        action: 'Rosie waves. A crowd of tourists cheers.',
        dialogue: [{ characterId: rosie.id, character: 'Rosie', line: 'Hi!' }],
        characterIds: [rosie.id, sammy.id],
        locationId: null,
        elementIds: [],
        estDurationSec: 30,
        continuity: '',
      },
      {
        id: 'scn_0000000000bbbbbb',
        index: 1,
        beatId: null,
        heading: 'INT. HUT - NIGHT',
        location: 'Hut',
        timeOfDay: 'night',
        summary: 'They talk',
        action: 'Sammy lights a lamp.',
        dialogue: [],
        characterIds: [sammy.id],
        locationId: null,
        elementIds: [],
        estDurationSec: 20,
        continuity: 'Night, lamp light.',
      },
    ],
  });
  return f.docs({ screenplay: sp, characters: { [rosie.id]: rosie, [sammy.id]: sammy } });
}

const review = (over: Partial<StageReview>): StageReview =>
  StageReviewSchema.parse({
    stage: 'screenplay',
    status: 'succeeded',
    createdAt: at,
    updatedAt: at,
    ...over,
  });

describe('AI review verdict (docs/design/ai-review.md#the-verdict)', () => {
  it('passes on the mean of the dimensions, unless an issue is critical or a dimension is very low', () => {
    const all = (v: number) =>
      Object.fromEntries(
        ['story', 'character', 'dialogue', 'pacing', 'visual', 'continuity', 'feasibility', 'brief'].map(
          (d) => [d, v],
        ),
      );
    expect(stageVerdict('screenplay', all(8), [], 7)).toEqual({ passed: true, score: 8, blocking: [] });
    expect(stageVerdict('screenplay', all(6.5), [], 7)).toMatchObject({
      passed: false,
      blocking: ['score 6.5 of 7'],
    });
    expect(stageVerdict('screenplay', { ...all(9), feasibility: 3 }, [], 7)).toMatchObject({
      passed: false,
      score: 8.3,
      blocking: ['feasibility 3/10'],
    });
    expect(
      stageVerdict('screenplay', all(9), [{ severity: 'critical', title: 'A crowd' }], 7).blocking,
    ).toEqual(['critical: A crowd']);
    expect(stageVerdict('storyboard', {}, [], 7)).toMatchObject({ passed: false, blocking: ['no scores'] });
  });
});

describe('AI review subject and state (docs/design/ai-review.md#the-gates)', () => {
  it('follows the screenplay as it is now: an edit outdates the review, an override accepts it', () => {
    const docs = screenplayDocs();
    const subject = screenplayReviewSubject(docs);
    expect(subject).toMatch(/^[0-9a-f]+$/);
    expect(reviewState(docs, 'screenplay')).toBe('missing');
    expect(reviewRequirement(docs, 'screenplay')).toMatchObject({
      ok: false,
      message: 'Review the screenplay',
    });
    const passed = review({ subject, threshold: 7, verdict: { passed: true, score: 8, blocking: [] } });
    const withReview = { ...docs, aiReviews: { screenplay: passed } };
    expect(reviewState(withReview, 'screenplay')).toBe('passed');
    expect(reviewRequirement(withReview, 'screenplay')).toMatchObject({
      ok: true,
      message: 'The screenplay review passed (8 of 7)',
    });
    // An edit
    const edited = structuredClone(withReview);
    edited.screenplay!.scenes[1]!.action = 'Sammy blows out the lamp.';
    expect(reviewState(edited, 'screenplay')).toBe('outdated');
    // A failing review, then "continue anyway" for this screenplay
    const failed = review({
      subject,
      threshold: 7,
      verdict: { passed: false, score: 5, blocking: ['score 5 of 7'] },
    });
    const failing = { ...docs, aiReviews: { screenplay: failed } };
    expect(reviewRequirement(failing, 'screenplay')).toMatchObject({
      ok: false,
      message: 'The screenplay review did not pass (5 of 7)',
      details: ['score 5 of 7'],
    });
    const overridden = {
      ...docs,
      aiReviews: {
        screenplay: {
          ...failed,
          override: { by: { kind: 'user' as const, id: 'u' }, at, note: '', subject },
        },
      },
    };
    expect(reviewState(overridden, 'screenplay')).toBe('overridden');
    // Running and failing to run hold the gate; off releases it
    expect(
      reviewState({ ...docs, aiReviews: { screenplay: review({ status: 'running' }) } }, 'screenplay'),
    ).toBe('running');
    expect(
      reviewState(
        { ...docs, aiReviews: { screenplay: review({ status: 'failed', error: 'x' }) } },
        'screenplay',
      ),
    ).toBe('error');
    const off = {
      ...docs,
      project: f.project({ settings: ProjectSettingsSchema.parse({ review: { screenplay: false } }) }),
    };
    expect(reviewState(off, 'screenplay')).toBe('off');
    expect(reviewRequirement(off, 'screenplay').ok).toBe(true);
  });

  it('puts the review on the screenplay and storyboard gates', () => {
    const docs = screenplayDocs();
    const ev = evaluateWorkflow({ ...docs, project: { ...docs.project, kind: 'story' } });
    const ids = (gate: string) =>
      ev.stages.find((s) => s.gate?.id === gate)!.gate!.requirements.map((r) => r.id);
    expect(ids('screenplay_approved')).toContain('screenplay.reviewPassed');
    expect(ids('storyboard_approved')).toContain('storyboard.reviewPassed');
    // The storyboard's review follows its frames; with the storyboard off it is off too
    expect(storyboardReviewSubject(docs)).toMatch(/^[0-9a-f]+$/);
    const noBoard = {
      ...docs,
      project: f.project({ settings: ProjectSettingsSchema.parse({ storyboard: { enabled: false } }) }),
    };
    expect(reviewState(noBoard, 'storyboard')).toBe('off');
  });
});

describe('AI review assembly (docs/design/ai-review.md#how-a-review-runs)', () => {
  it('points issues and fixes at scenes and shots, orders fixes by priority and keeps what a stage can apply', () => {
    const out = StageReviewOutputSchema.parse({
      scores: { story: 8, feasibility: 3.04, bogus: 9 },
      summary: 'ok',
      strengths: ['A premise', 7],
      issues: [
        { scene: 1, dimension: 'Feasibility', severity: 'critical', title: 'A crowd', detail: 'tourists' },
        { title: '' },
        { scene: 2, dimension: 'weird', severity: 'oops', title: 'Dark', detail: '' },
      ],
      recommendations: [
        { dimension: 'story', priority: 3, title: 'Plant the end', action: { kind: 'note' } },
        {
          scene: 1,
          dimension: 'feasibility',
          priority: 1,
          title: 'Lose the crowd',
          action: { kind: 'revise_scene', instruction: 'No crowd' },
        },
        {
          scene: 9,
          dimension: 'story',
          priority: 2,
          title: 'Unknown scene',
          action: { kind: 'revise_scene', instruction: 'x' },
        },
        {
          dimension: 'pacing',
          priority: 2,
          title: 'Faster',
          detail: 'Shorter beats',
          action: { kind: 'revise_outline' },
        },
        {
          scene: 1,
          shot: 0,
          dimension: 'composition',
          priority: 1,
          title: 'Redraw',
          action: { kind: 'redraw_board' },
        },
      ],
    });
    // Malformed items are dropped one by one, not the whole list
    expect(out.strengths).toEqual(['A premise']);
    expect(out.issues).toHaveLength(2);
    const targets = {
      scenes: new Map([
        [1, 'scn_0000000000aaaaaa'],
        [2, 'scn_0000000000bbbbbb'],
      ]),
    };
    const a = assembleStageReview('screenplay', out, targets, 7);
    expect(a.scores).toMatchObject({ story: 8, feasibility: 3, pacing: null });
    expect(a.scores).not.toHaveProperty('bogus');
    expect(a.issues[0]).toMatchObject({
      id: 'i1',
      dimension: 'feasibility',
      scene: 1,
      sceneId: 'scn_0000000000aaaaaa',
    });
    expect(a.issues[1]).toMatchObject({
      dimension: 'story',
      severity: 'minor',
      sceneId: 'scn_0000000000bbbbbb',
    });
    expect(a.recommendations.map((r) => [r.priority, r.action?.kind])).toEqual([
      [1, 'revise_scene'],
      [1, 'note'], // a storyboard action in a screenplay review
      [2, 'note'], // an unknown scene
      [2, 'revise_outline'],
      [3, 'note'],
    ]);
    expect(a.recommendations[0]).toMatchObject({
      id: 'r1',
      round: 1,
      issueIds: ['i1'],
      action: { kind: 'revise_scene', sceneId: 'scn_0000000000aaaaaa', instruction: 'No crowd' },
    });
    expect(a.recommendations[3]!.action).toEqual({ kind: 'revise_outline', instruction: 'Shorter beats' });
    expect(a.verdict).toMatchObject({
      passed: false,
      blocking: expect.arrayContaining(['critical: A crowd']),
    });
    // What a round applies by itself: open, priority 1-2, with something to do
    expect(autoApplicable({ recommendations: a.recommendations }).map((r) => r.id)).toEqual(['r1', 'r4']);

    // The storyboard: shots by their place in the scene; later rounds number their own
    const board = assembleStageReview(
      'storyboard',
      out,
      {
        scenes: new Map([[1, 'scn_0000000000aaaaaa']]),
        clips: new Map([
          [
            1,
            { clipId: 'clp_0000000000aaaaaa', shots: [{ shotId: 'sht_0000000000aaaaaa', label: 'C1·S1' }] },
          ],
        ]),
      },
      7,
      2,
    );
    const redraw = board.recommendations.find((r) => r.action?.kind === 'redraw_board')!;
    expect(redraw).toMatchObject({
      id: 'r2.2',
      round: 2,
      action: { clipId: 'clp_0000000000aaaaaa', shotId: 'sht_0000000000aaaaaa' },
    });
    expect(
      carriedFixes({
        recommendations: [
          { ...redraw, status: 'applied' },
          { ...redraw, id: 'x' },
        ],
      }).map((r) => r.id),
    ).toEqual(['r2.2']);
  });

  it('merges a storyboard’s scenes, weighting scores by their length', () => {
    const scene = (scores: Record<string, number>, title: string) =>
      StageReviewOutputSchema.parse({
        scores,
        summary: title,
        issues: [{ shot: 0, dimension: 'continuity', title }],
        recommendations: [],
      });
    const merged = mergeSceneReviews([
      { number: 1, durationSec: 30, out: scene({ continuity: 8 }, 'one') },
      { number: 2, durationSec: 10, out: scene({ continuity: 4, coverage: 6 }, 'two') },
    ]);
    expect(merged.scores).toEqual({ continuity: 7, coverage: 6 });
    expect(merged.summary).toBe('Scene 1: one Scene 2: two');
    expect(merged.issues.map((i) => i.scene)).toEqual([1, 2]);
  });
});

describe('screenplay revision (docs/design/ai-review.md#how-a-review-runs)', () => {
  it('replaces the scenes it names, keeps their ids and beats, and patches the outline', () => {
    const docs = screenplayDocs();
    const sp = docs.screenplay!;
    const { screenplay, changed, elements } = reviseScenes(
      sp,
      [
        {
          number: 1,
          heading: 'EXT. PIER - DAY',
          location: 'Quiet pier',
          timeOfDay: 'day',
          summary: 'Rosie meets Sammy',
          action: 'Rosie waves.',
          dialogue: [{ character: 'Rosie', line: 'Hi Sammy!' }],
          characters: ['Rosie', 'Sammy'],
          props: ['Lantern'],
          estDurationSec: 99,
          continuity: 'Morning sun.',
        },
        {
          number: 7,
          heading: 'X',
          location: '',
          timeOfDay: '',
          summary: '',
          action: '',
          dialogue: [],
          characters: [],
          props: [],
          estDurationSec: 5,
          continuity: '',
        },
      ] as never,
      [{ index: 0, summary: 'They meet on the pier', estDurationSec: 40 }],
      Object.values(docs.characters),
    );
    expect(changed).toEqual(['scn_0000000000aaaaaa']);
    const revised = screenplay.scenes.find((s) => s.id === 'scn_0000000000aaaaaa')!;
    expect(revised).toMatchObject({
      index: 0,
      beatId: 'bea_0000000000aaaaaa',
      action: 'Rosie waves.',
      continuity: 'Morning sun.',
    });
    // The beat's (revised) estimate, not the writer's
    expect(revised.estDurationSec).toBe(40);
    expect(revised.dialogue[0]!.characterId).toBe(
      Object.values(docs.characters).find((c) => c.name === 'Rosie')!.id,
    );
    expect(screenplay.scenes.find((s) => s.id === 'scn_0000000000bbbbbb')).toEqual(sp.scenes[1]);
    expect(screenplay.outline[0]).toMatchObject({
      summary: 'They meet on the pier',
      estDurationSec: 40,
      title: 'Start',
    });
    expect(elements.map((e) => e.name).sort()).toEqual(['Lantern', 'Quiet pier']);
  });
});
