import { describe, expect, it } from 'vitest';
import {
  compileMultiShotRequest,
  multiShotBoundaries,
  needsOwnRequest,
  ProjectSettingsSchema,
  planShotGroups,
} from '../src';
import * as f from '../src/testing/fixtures';

const shot = (index: number, durationSec = 5, continuity: 'cut' | 'continuous' = 'cut') => ({
  id: `sht_00000000000000${index}`,
  index,
  durationSec,
  continuity,
});

describe('shot groups (docs/design/multi-shot.md#when)', () => {
  const all = () => true;
  it('groups consecutive shots within the shot count and the length', () => {
    const shots = [shot(0), shot(1), shot(2), shot(3), shot(4)];
    expect(
      planShotGroups(shots, { maxShots: 3, maxDurationSec: 20, eligible: all }).map((g) => g.length),
    ).toEqual([3, 2]);
    expect(
      planShotGroups(shots, { maxShots: 4, maxDurationSec: 10, eligible: all }).map((g) => g.length),
    ).toEqual([2, 2, 1]);
  });

  it('never starts a group with a continuation, skips gaps and isolates shots with their own request', () => {
    const shots = [shot(0), shot(1), shot(2, 5, 'continuous'), shot(4), shot(5)];
    // shot 2 continues shot 1 but the group 0–1 is full: alone; 3 is missing: 4 and 5 group
    expect(planShotGroups(shots, { maxShots: 2, maxDurationSec: 20, eligible: all })).toEqual([
      [shots[0]!.id, shots[1]!.id],
      [shots[2]!.id],
      [shots[3]!.id, shots[4]!.id],
    ]);
    const own = new Set([shots[1]!.id]);
    expect(
      planShotGroups(shots, { maxShots: 4, maxDurationSec: 30, eligible: (id) => !own.has(id) }),
    ).toEqual([[shots[0]!.id], [shots[1]!.id], [shots[2]!.id], [shots[3]!.id, shots[4]!.id]]);
    expect(needsOwnRequest(f.shot())).toBe(false);
    expect(
      needsOwnRequest(f.shot({ endFrame: { mode: 'generate', description: 'x', resourceId: null } })),
    ).toBe(true);
  });
});

describe('splitting', () => {
  it('uses the detected cuts when they match the shots, the planned lengths otherwise', () => {
    expect(multiShotBoundaries([5.02, 9.01], [5, 4, 6], 15)).toEqual({
      boundaries: [0, 5.02, 9.01, 15],
      cut: 'detected',
    });
    // a flash detected as a cut: the planned durations, scaled to the render
    expect(multiShotBoundaries([2, 5, 9], [5, 4, 6], 16.5)).toEqual({
      boundaries: [0, 5.5, 9.9, 16.5],
      cut: 'planned',
    });
    expect(multiShotBoundaries([], [10, 10], 20).cut).toBe('planned');
  });
});

describe('the request (docs/design/multi-shot.md#request)', () => {
  it('lists every shot once, the cast and the elements once, and asks for the whole length', () => {
    const settings = ProjectSettingsSchema.parse({});
    const mira = f.character({ name: 'Mira' });
    const lamp = f.element({ name: 'Lamp room' });
    const a = f.shot({ description: 'Mira climbs the stairs', durationSec: 5, characterIds: [mira.id] });
    const b = f.shot({
      description: 'Close on the lantern',
      durationSec: 4,
      camera: { framing: 'close_up', movement: 'static', move: 'push_in' },
    });
    const req = compileMultiShotRequest(
      [
        { shot: a, characters: [mira], elements: [lamp], screenplay: null, settings },
        { shot: b, characters: [mira], elements: [lamp], screenplay: null, settings },
      ],
      { firstFrameUri: 'data:kf', referenceUris: ['data:ref'], attempt: 0, model: 'multi' },
    );
    const text = (req.input[0] as { text: string }).text;
    expect(text).toContain('A multi-shot sequence of 2 shots separated by hard cuts.');
    expect(text).toContain('Shot 1 (5 s): Mira climbs the stairs.');
    expect(text).toContain('Shot 2 (4 s): Close on the lantern. Action:');
    expect(text).toContain('Camera: close-up, slow push-in toward the subject.');
    expect(text.match(/Characters \(keep identities/g)).toHaveLength(1);
    expect(text.match(/Location \(keep exactly/g)).toHaveLength(1);
    expect(req.input.slice(1)).toEqual([
      { type: 'image', uri: 'data:kf', role: 'first_frame' },
      { type: 'image', uri: 'data:ref', role: 'reference_image' },
    ]);
    expect(req.parameters).toMatchObject({ duration_seconds: 9, include_audio: false });
    expect(req.model).toBe('multi');
  });
});
