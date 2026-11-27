import {
  emptyScores,
  emptyUsage,
  type FeedbackScores,
  FeedbackSignalsSchema,
  type Job,
  type ProjectDocs,
  type ProjectUsage,
} from '@rideo/shared';
import * as f from '@rideo/shared/testing';
import { describe, expect, it } from 'vitest';
import { settingsPatchOf } from '../../src/domain/feedback';
import { RETROSPECTIVE_RULES, type RunFacts, retrospective } from '../../src/domain/retrospective';
import { sceneInput } from '../../src/jobs/handlers/feedback';

function usage(
  over: Partial<ProjectUsage['totals']> = {},
  byKind: ProjectUsage['byKind'] = {},
): ProjectUsage {
  return {
    version: 1,
    projectId: 'prj_0000000000aaaaaa',
    updatedAt: '2026-10-25T00:00:00.000Z',
    totals: { ...emptyUsage(), ...over },
    byKind,
  };
}

function job(over: Partial<Job>): Job {
  return {
    id: `job_${Math.random().toString(36).slice(2, 12).padEnd(10, '0')}`,
    projectId: 'prj_0000000000aaaaaa',
    kind: 'shot.generate',
    lane: 'video',
    status: 'succeeded',
    params: {},
    progress: { done: 1, total: 1 },
    attempts: 1,
    maxAttempts: 3,
    branch: 'main',
    actor: { kind: 'system', id: 'rideo' },
    priority: 0,
    gatewayTasks: [],
    lease: null,
    staged: [],
    usage: null,
    createdAt: '2026-10-25T00:00:00.000Z',
    ...over,
  } as Job;
}

/** A quiet run: nothing fires. */
function quiet(): RunFacts {
  const docs: ProjectDocs = f.docs();
  const scores: FeedbackScores = {
    ...emptyScores(),
    storytelling: 8,
    continuity: 8,
    character: 8,
    temporal: 8,
    physics: 8,
    realism: 8,
    cinematography: 8,
    editing: 8,
    sound: 9,
  };
  return {
    docs,
    usage: usage(),
    jobs: [],
    signals: FeedbackSignalsSchema.parse({ durationSec: 600, targetDurationSec: 600 }),
    scores,
    spans: [],
  };
}

const fired = (facts: RunFacts) => retrospective(facts).map((r) => r.rule);

describe('retrospective rules (docs/design/feedback.md#retrospective-improvements-after-every-project)', () => {
  it('stays quiet on a clean run and each rule has a unique id', () => {
    expect(fired(quiet())).toEqual([]);
    expect(new Set(RETROSPECTIVE_RULES.map((r) => r.id)).size).toBe(RETROSPECTIVE_RULES.length);
  });

  it('reports retries, waste, unverified, overridden and quality failures with their numbers', () => {
    const facts = quiet();
    facts.usage = usage({ llmRetries: 7, videoSeconds: 100, discardedVideoSeconds: 40, discardedCostUsd: 4 });
    facts.signals = {
      ...facts.signals,
      takes: { total: 10, passed: 6, failed: 0, unverified: 2, overridden: 1, stale: 0, qualityFailed: 3 },
      unexpectedCuts: [{ at: 3, score: 0.6 }],
      framingRuns: [{ clipId: 'clp_0000000000aaaaaa', framing: 'medium', count: 5, start: 0, end: 25 }],
      rushedLines: [
        {
          clipId: 'clp_0000000000aaaaaa',
          shotId: 'sht_0000000000aaaaaa',
          shot: 'C1·S1',
          words: 20,
          durationSec: 5,
          start: 0,
        },
      ],
    };
    const items = retrospective(facts);
    expect(items.map((r) => r.rule)).toEqual([
      'discarded_generations',
      'unverified_takes',
      'overridden_takes',
      'quality_failures',
      'llm_retries',
      'unexpected_cuts',
      'framing_runs',
      'rushed_lines',
    ]);
    expect(items.find((r) => r.rule === 'discarded_generations')!.title).toBe(
      '40% of the generated video was thrown away',
    );
    expect(items.find((r) => r.rule === 'llm_retries')!.title).toContain('7');
  });

  it('says what the new takes since the last feedback changed, naming the ones no better', () => {
    const facts = quiet();
    const retake = (shot: string, before: number, after: number) => ({
      clipId: 'clp_0000000000aaaaaa',
      shotId: `sht_00000000000000${shot.slice(-1)}`,
      shot,
      recommendationId: null,
      before: { takeId: 'tke_0000000000aaaaaa', issues: before },
      after: { takeId: 'tke_0000000000bbbbbb', issues: after },
      outcome: (after < before ? 'better' : after > before ? 'worse' : 'same') as 'better' | 'same' | 'worse',
    });
    facts.retakes = [retake('C1·S1', 4, 0), retake('C1·S2', 2, 2), retake('C1·S3', 1, 3)];
    const item = retrospective(facts).find((r) => r.rule === 'retake_results')!;
    expect(item).toMatchObject({
      area: 'quality',
      title: '3 shots have a new take since the last feedback: 1 better, 1 the same, 1 worse',
    });
    expect(item.detail).toContain('Worse now: C1·S3. No better: C1·S2.');
    facts.retakes = [retake('C1·S1', 4, 0)];
    expect(retrospective(facts).find((r) => r.rule === 'retake_results')!.detail).toBe(
      'Every new take fixed what the previous feedback saw.',
    );
  });

  it('prices the film per minute or says which models have no price', () => {
    const priced = quiet();
    priced.usage = usage({ costUsd: 30 });
    expect(retrospective(priced).find((r) => r.rule === 'cost_per_minute')!.title).toBe(
      'About $3.00 per finished minute',
    );
    const unpriced = quiet();
    unpriced.usage = usage({
      byModel: { wan: { modality: 'video', calls: 3, seconds: 1, units: 15, costUsd: 0, unpriced: 3 } },
    });
    expect(retrospective(unpriced).find((r) => r.rule === 'cost_per_minute')!.detail).toContain('wan');
  });

  it('names the weakest dimensions with what addresses them, and a missed target', () => {
    const facts = quiet();
    facts.scores = { ...facts.scores, physics: 4.5, storytelling: 6 };
    facts.signals = { ...facts.signals, durationSec: 400 };
    const items = retrospective(facts);
    const low = items.find((r) => r.rule === 'low_dimension')!;
    expect(low.title).toBe('Weakest: physics (4.5/10) and storytelling (6.0/10)');
    expect(low.detail).toContain('quality checks');
    expect(items.find((r) => r.rule === 'target_missed')!.title).toBe('The film is shorter than its target');
  });

  it('sees slow shots, queue waits and failed jobs in the job records and the ledger', () => {
    const facts = quiet();
    const at = (min: number) => new Date(Date.UTC(2026, 9, 25, 0, min)).toISOString();
    facts.jobs = [
      ...Array.from({ length: 10 }, (_, i) => job({ startedAt: at(0), finishedAt: at(i < 8 ? 3 : 15) })),
      job({
        kind: 'clip.plan',
        status: 'failed',
        error: { code: 'llm_invalid_output', message: 'x', retryable: true },
      }),
      job({
        kind: 'clip.plan',
        status: 'failed',
        error: { code: 'llm_invalid_output', message: 'x', retryable: true },
      }),
    ];
    facts.usage = usage(
      {},
      {
        'shot.generate': {
          jobs: 10,
          succeeded: 10,
          failed: 0,
          cancelled: 0,
          runSeconds: 600,
          waitSeconds: 1200,
          costUsd: 0,
        },
      },
    );
    const items = retrospective(facts);
    expect(items.map((r) => r.rule)).toEqual(['queue_wait', 'slow_shots', 'failed_jobs']);
    expect(items.find((r) => r.rule === 'failed_jobs')!.detail).toBe(
      'clip.plan: 2 (mostly llm_invalid_output)',
    );
  });

  it('writes each count with its noun and verb agreeing, for 1 and for 2 (docs/brand.md#voice)', () => {
    const clipId = 'clp_0000000000aaaaaa';
    const shotId = 'sht_0000000000aaaaaa';
    const at = (min: number) => new Date(Date.UTC(2026, 9, 25, 0, min)).toISOString();
    const counted = (n: number) => {
      const facts = quiet();
      facts.usage = usage(
        { llmRetries: n, videoSeconds: 3, discardedVideoSeconds: n },
        {
          'shot.generate': {
            jobs: 5,
            succeeded: 5,
            failed: 0,
            cancelled: 0,
            runSeconds: 60 * n,
            waitSeconds: 120 * n,
            costUsd: 0,
          },
        },
      );
      const times = <T>(make: (i: number) => T) => Array.from({ length: n }, (_, i) => make(i));
      facts.signals = {
        ...facts.signals,
        takes: { total: 10, passed: 6, failed: 0, unverified: n, overridden: n, stale: 0, qualityFailed: n },
        unexpectedCuts: times((i) => ({ at: 3 + i, score: 0.6 })),
        framingRuns: times((i) => ({ clipId, framing: 'medium', count: 5, start: i * 30, end: i * 30 + 25 })),
        rushedLines: times((i) => ({
          clipId,
          shotId,
          shot: `C1·S${i + 1}`,
          words: 20,
          durationSec: 5,
          start: i,
        })),
        dialogue: {
          lines: n + 1,
          heard: 1,
          missing: times((i) => ({
            clipId,
            shotId: `sht_00000000000000${i}`,
            shot: `C1·S${i + 1}`,
            character: 'Mira',
            line: 'Not tonight.',
            heard: 0,
            start: i,
            end: i + 1,
          })),
        },
      };
      facts.jobs = times(() =>
        job({ kind: 'clip.plan', status: 'failed', startedAt: at(0), finishedAt: at(1) }),
      );
      facts.retakes = times((i) => ({
        clipId,
        shotId: `sht_00000000000000${i}`,
        shot: `C1·S${i + 1}`,
        recommendationId: null,
        before: { takeId: 'tke_0000000000aaaaaa', issues: 2 },
        after: { takeId: 'tke_0000000000bbbbbb', issues: 0 },
        outcome: 'better' as const,
      }));
      return Object.fromEntries(retrospective(facts).map((r) => [r.rule, `${r.title} | ${r.detail}`]));
    };
    const one = counted(1);
    const two = counted(2);
    const pick = (said: Record<string, string>, rule: string) => said[rule]!.split(' | ');

    expect(pick(one, 'rushed_lines')[0]).toBe('1 line is too long for its shot');
    expect(pick(two, 'rushed_lines')[0]).toBe('2 lines are too long for their shots');
    expect(pick(one, 'rushed_lines')[1]).toMatch(
      /^It is spoken too fast or cut off\..*shorten or split it\.$/,
    );
    expect(pick(two, 'rushed_lines')[1]).toMatch(
      /^They are spoken too fast or cut off\..*shorten or split these\.$/,
    );
    expect(pick(one, 'undelivered_lines')[0]).toBe('1 of 2 lines is not heard in the film');
    expect(pick(two, 'undelivered_lines')[0]).toBe('2 of 3 lines are not heard in the film');
    expect(pick(one, 'undelivered_lines')[1]).toMatch(
      /^The video model did not voice it clearly\. Apply the recommendations to generate that shot again,/,
    );
    expect(pick(two, 'undelivered_lines')[1]).toMatch(
      /^The video model did not voice them clearly\. Apply the recommendations to generate those shots again,/,
    );
    expect(pick(one, 'unverified_takes')[0]).toBe('1 take in the cut was never verified');
    expect(pick(two, 'unverified_takes')[0]).toBe('2 takes in the cut were never verified');
    expect(pick(one, 'unverified_takes')[1]).toContain('unavailable when it was made');
    expect(pick(two, 'unverified_takes')[1]).toContain('unavailable when they were made');
    expect(pick(one, 'overridden_takes')).toEqual([
      '1 take in the cut was overridden',
      'A person accepted it without a passing check: look at it first when the film looks wrong.',
    ]);
    expect(pick(two, 'overridden_takes')[0]).toBe('2 takes in the cut were overridden');
    expect(pick(one, 'quality_failures')[0]).toBe('1 take in the cut failed the temporal or physics check');
    expect(pick(one, 'quality_failures')[1]).toMatch(
      /^It was kept because no attempt did better\. Regenerate it /,
    );
    expect(pick(two, 'quality_failures')[1]).toMatch(
      /^They were kept because no attempt did better\. Regenerate them /,
    );
    expect(pick(one, 'llm_retries')[0]).toBe('1 language or vision call was turned away for load');
    expect(pick(two, 'llm_retries')[0]).toBe('2 language or vision calls were turned away for load');
    expect(pick(one, 'llm_retries')[1]).toContain('the call was made again');
    expect(pick(two, 'llm_retries')[1]).toContain('the calls were made again');
    expect(pick(one, 'unexpected_cuts')[0]).toBe('1 shot jumps inside the shot');
    expect(pick(two, 'unexpected_cuts')[0]).toBe('2 shots jump inside the shot');
    expect(pick(one, 'framing_runs')[0]).toBe('1 run of more than three shots with the same framing');
    expect(pick(two, 'framing_runs')[0]).toBe('2 runs of more than three shots with the same framing');
    expect(pick(one, 'failed_jobs')[0]).toBe('1 job failed');
    expect(pick(two, 'failed_jobs')[0]).toBe('2 jobs failed');
    expect(pick(one, 'retake_results')[0]).toBe(
      '1 shot has a new take since the last feedback: 1 better, 0 the same, 0 worse',
    );
    expect(pick(two, 'retake_results')[0]).toBe(
      '2 shots have a new take since the last feedback: 2 better, 0 the same, 0 worse',
    );
    expect(pick(one, 'discarded_generations')[1]).toMatch(
      /^1 of 3 seconds was an attempt the gate discarded\./,
    );
    expect(pick(two, 'discarded_generations')[1]).toMatch(
      /^2 of 3 seconds were attempts the gate discarded\./,
    );
    expect(pick(one, 'queue_wait')[1]).toMatch(/^2 minutes waiting against 1 minute running:/);
  });

  it('turns a settings action into a project settings patch from the fixed table', () => {
    expect(
      settingsPatchOf({ qualityChecks: true, threshold: 0.8, storyboard: false, promptVersion: 2 }),
    ).toEqual({
      consistency: { qualityChecks: true, threshold: 0.8 },
      storyboard: { enabled: false },
      generation: { promptVersion: 2 },
    });
  });
});

describe('the scene reviewers’ input (docs/design/feedback.md#how-a-film-is-watched, step 3)', () => {
  it('gives the listener where each shot is in the scene’s video and the cast’s voices; the strips get neither', () => {
    const rosie = f.character({ name: 'Rosie' });
    const shots = [0, 1].map((index) =>
      f.shot({ index, characterIds: [rosie.id], takes: [f.take({ id: `tk_${index}` })] }),
    );
    const clip = f.clip({ shots });
    const docs = f.docs({ clips: { [clip.id]: clip }, characters: { [rosie.id]: rosie } });
    const spans = shots.map((s, i) => ({
      clipId: clip.id,
      shotId: s.id,
      takeId: `tk_${i}`,
      label: `C1·S${i + 1}`,
      clipIndex: 0,
      shotIndex: i,
      start: 30 + i * 5,
      end: 35 + i * 5,
      clean: { start: 30 + i * 5, end: 35 + i * 5 },
    }));
    const signals = FeedbackSignalsSchema.parse({ durationSec: 60 });
    const neighbours = { previous: null, next: null };
    const heard = sceneInput(docs, clip.id, spans, neighbours, signals, true);
    expect(heard.listening).toBe(true);
    expect(heard.shots.map((s) => s.video)).toEqual([
      { from: 0, to: 5 },
      { from: 5, to: 10 },
    ]);
    expect(heard.cast).toEqual([{ name: 'Rosie', look: expect.any(String), voice: expect.any(String) }]);
    const seen = sceneInput(docs, clip.id, spans, neighbours, signals);
    expect(seen.shots[0]).not.toHaveProperty('video');
    expect(seen.cast[0]).not.toHaveProperty('voice');
  });
});
