import { describe, expect, it } from 'vitest';
import { aggregateVerdicts, clipBlockers, takeState } from '../src';
import * as f from '../src/testing/fixtures';

describe('takeState', () => {
  it('is passed for a verified take of the current lock', () => {
    const mira = f.character();
    const shot = f.readyShot([mira]);
    expect(takeState(shot.takes[0]!, shot, { [mira.id]: mira })).toBe('passed');
  });

  it('becomes stale when a character was relocked (R6)', () => {
    const mira = f.character();
    const shot = f.readyShot([mira]);
    const relocked = { ...mira, lock: { ...mira.lock, version: 2 } };
    expect(takeState(shot.takes[0]!, shot, { [mira.id]: relocked })).toBe('stale');
  });

  it('reports failed and unverified reports, and overrides win (R8)', () => {
    const mira = f.character();
    const shot = f.readyShot([mira]);
    const t = shot.takes[0]!;
    expect(takeState({ ...t, consistency: f.report({ status: 'failed' }) }, shot, { [mira.id]: mira })).toBe(
      'failed',
    );
    expect(
      takeState({ ...t, consistency: f.report({ status: 'unverified' }) }, shot, { [mira.id]: mira }),
    ).toBe('unverified');
    const overridden = {
      ...t,
      consistency: f.report({ status: 'failed' }),
      override: { actor: { kind: 'user' as const, id: 'u' }, reason: 'looks right', at: 'x' },
    };
    expect(takeState(overridden, shot, { [mira.id]: mira })).toBe('overridden');
  });
});

describe('clipBlockers (R7)', () => {
  it('lists missing, failed and stale takes', () => {
    const mira = f.character();
    const ok = f.readyShot([mira], { index: 0 });
    const missing = f.shot({ index: 1, characterIds: [mira.id] });
    const failedShot = f.readyShot([mira], { index: 2 });
    failedShot.takes[0]!.consistency = f.report({ status: 'failed' });
    const clip = f.clip({ shots: [ok, missing, failedShot] });
    const blockers = clipBlockers(clip, { [mira.id]: mira });
    expect(blockers.map((b) => b.state)).toEqual(['missing', 'failed']);
    expect(blockers[1]!.message).toContain('failed the consistency check');
    expect(clipBlockers(f.clip({ shots: [] }), {})[0]!.message).toContain('no shots');
  });
});

describe('aggregateVerdicts', () => {
  it('passes when every expected character is present above threshold in all frames where visible', () => {
    const r = aggregateVerdicts(
      ['a', 'b'],
      [
        [
          { characterId: 'a', present: true, identityScore: 0.9 },
          { characterId: 'b', present: false, identityScore: 0 },
        ],
        [
          { characterId: 'a', present: true, identityScore: 0.8 },
          { characterId: 'b', present: true, identityScore: 0.95 },
        ],
      ],
      { threshold: 0.75 },
    );
    expect(r.status).toBe('passed');
    expect(r.score).toBe(0.8);
    expect(r.characters.find((c) => c.characterId === 'b')!.present).toBe(true);
  });

  it('fails when a character morphs in one frame or never appears', () => {
    const morph = aggregateVerdicts(
      ['a'],
      [
        [{ characterId: 'a', present: true, identityScore: 0.9 }],
        [{ characterId: 'a', present: true, identityScore: 0.4, issues: ['hair colour changed'] }],
      ],
      { threshold: 0.75 },
    );
    expect(morph.status).toBe('failed');
    expect(morph.characters[0]!.issues).toContain('hair colour changed');
    const absent = aggregateVerdicts(['a'], [[]], { threshold: 0.75 });
    expect(absent.status).toBe('failed');
    expect(absent.characters[0]!.issues[0]).toMatch(/not visible/);
  });

  it('weights outfit when a wardrobe is expected and passes empty casts', () => {
    const r = aggregateVerdicts(
      ['a'],
      [[{ characterId: 'a', present: true, identityScore: 0.8, outfitScore: 0.4 }]],
      {
        threshold: 0.75,
        expectsWardrobe: () => true,
      },
    );
    expect(r.score).toBe(0.7);
    expect(r.status).toBe('failed');
    expect(aggregateVerdicts([], [], { threshold: 0.75 }).status).toBe('passed');
  });
});
