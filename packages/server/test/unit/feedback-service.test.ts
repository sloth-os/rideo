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
