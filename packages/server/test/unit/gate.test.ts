import * as f from '@rideo/shared/testing';
import { describe, expect, it } from 'vitest';
import { verifyFrames } from '../../src/consistency/gate';
import { type ConsistencyJudge, OffJudge } from '../../src/consistency/judge';
import { Metrics } from '../../src/metrics';

const judgeWith = (score: number): ConsistencyJudge => ({
  id: 'fake',
  judge: async (req) =>
    req.frames.map(() =>
      req.characters.map((c) => ({
        characterId: c.id,
        present: true,
        identityScore: score,
        outfitScore: score,
      })),
    ),
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
});
