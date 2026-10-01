import * as f from '@rideo/shared/testing';
import { describe, expect, it } from 'vitest';
import { verifyFrames } from '../../src/consistency/gate';
import { type ConsistencyJudge, OffJudge } from '../../src/consistency/judge';
import { Metrics } from '../../src/metrics';

const judgeWith = (score: number, elementScore = score): ConsistencyJudge => ({
  id: 'fake',
  judge: async (req) => ({
    characters: req.frames.map(() =>
      req.characters.map((c) => ({
        characterId: c.id,
        present: true,
        identityScore: score,
        outfitScore: score,
      })),
    ),
    elements: req.frames.map(() =>
      (req.elements ?? []).map((e) => ({ elementId: e.id, present: elementScore > 0, score: elementScore })),
    ),
  }),
});

describe('verifyFrames', () => {
  const mira = f.character();
  const base = {
    shot: f.shot(),
    characters: [mira],
    references: new Map([[mira.id, [Buffer.from('r')]]]),
    frames: [Buffer.from('f')],
    frameRefs: [],
    threshold: 0.75,
    attempts: 1,
  };

  it('passes, fails and counts outcomes', async () => {
    const metrics = new Metrics();
    expect((await verifyFrames({ ...base, judge: judgeWith(0.9), metrics })).status).toBe('passed');
    const failed = await verifyFrames({ ...base, judge: judgeWith(0.4), metrics });
    expect(failed).toMatchObject({ status: 'failed', score: 0.4, judge: 'fake' });
    expect(metrics.consistency.get({ result: 'passed' })).toBe(1);
    expect(metrics.consistency.get({ result: 'failed' })).toBe(1);
  });

  it('fails closed when the judge is unavailable and skips empty casts', async () => {
    const off = await verifyFrames({ ...base, judge: new OffJudge() });
    expect(off.status).toBe('unverified');
    expect(off.note).toContain('judge unavailable');
    const empty = await verifyFrames({ ...base, characters: [], judge: new OffJudge() });
    expect(empty.status).toBe('passed');
  });

  it('judges locations and props when asked (rule E4)', async () => {
    const lamp = f.element({ kind: 'location', name: 'Lamp room' });
    const withElements = {
      ...base,
      elements: [lamp],
      elementReferences: new Map([[lamp.id, [Buffer.from('e')]]]),
    };
    const ok = await verifyFrames({ ...withElements, judge: judgeWith(0.9, 0.85) });
    expect(ok).toMatchObject({ status: 'passed', score: 0.85 });
    expect(ok.elements).toEqual([{ elementId: lamp.id, present: true, score: 0.85, issues: [] }]);
    const drifted = await verifyFrames({ ...withElements, judge: judgeWith(0.9, 0.3) });
    expect(drifted).toMatchObject({ status: 'failed', score: 0.3 });
    const missing = await verifyFrames({ ...withElements, judge: judgeWith(0.9, 0) });
    expect(missing.elements[0]).toMatchObject({
      present: false,
      issues: ['element not visible in any sampled frame'],
    });
    // a shot without characters is still judged for its location
    const locationOnly = await verifyFrames({ ...withElements, characters: [], judge: judgeWith(0, 0.9) });
    expect(locationOnly.status).toBe('passed');
    expect((await verifyFrames({ ...withElements, characters: [], judge: new OffJudge() })).status).toBe(
      'unverified',
    );
  });
});
