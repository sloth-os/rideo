import { describe, expect, it } from 'vitest';
import {
  compileMultiShotRequest,
  missedCuts,
  multiShotBoundaries,
  needsOwnRequest,
  ProjectSettingsPatchSchema,
  ProjectSettingsSchema,
  planShotGroups,
  plansForSequences,
  shotRangeFor,
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

describe('planning for sequences (docs/design/multi-shot.md#planning-for-sequences)', () => {
  const wan = {
    max_shots: 8,
    exclusive_frames_and_references: true,
    min_duration_seconds: 2,
    max_duration_seconds: 30,
  };
  it('plans shots of at most 5 s for a model that renders sequences from a first frame', () => {
    const settings = ProjectSettingsSchema.parse({});
    expect(plansForSequences(settings, wan)).toBe(true);
    expect(shotRangeFor(settings, wan)).toEqual({ min: 2, max: 5, sequences: true });
    // a model that takes references with its frame, or renders one shot, plans as before (up to 10 s)
    expect(shotRangeFor(settings, { ...wan, exclusive_frames_and_references: false })).toEqual({
      min: 2,
      max: 10,
      sequences: false,
    });
    expect(shotRangeFor(settings, { ...wan, max_shots: 1 }).sequences).toBe(false);
    expect(shotRangeFor(settings, null).sequences).toBe(false);
    // multi-shot off, or native dialogue (spoken shot by shot)
    const off = ProjectSettingsSchema.parse({ generation: { multiShot: 'off' } });
    expect(plansForSequences(off, wan)).toBe(false);
    const native = ProjectSettingsSchema.parse({ dialogue: { mode: 'native' } });
    expect(plansForSequences(native, wan)).toBe(false);
  });
});

describe('splitting', () => {
  it('uses the cuts found near the planned ones, and the planned lengths when there are none', () => {
    expect(multiShotBoundaries([5.02, 9.01], [5, 4, 6], 15)).toEqual({
      boundaries: [0, 5.02, 9.01, 15],
      cut: 'detected',
      found: 2,
    });
    // A flash far from any expected cut is not one: the cuts near 5.5 and 9.9 are
    expect(multiShotBoundaries([2, 5, 9], [5, 4, 6], 16.5)).toEqual({
      boundaries: [0, 5, 9, 16.5],
      cut: 'detected',
      found: 2,
    });
    expect(multiShotBoundaries([], [10, 10], 20)).toEqual({
      boundaries: [0, 10, 20],
      cut: 'planned',
      found: 0,
    });
  });

  it('takes the cuts it finds and the planned time only for one it does not (docs/design/multi-shot.md#splitting-and-verification)', () => {
    // fp53's riding scene: Wan's first cut too faint to find, the fourth 1.3 s off its planned time
    const riding = multiShotBoundaries(
      [8.99, 12.82, 15.59, 20.39, 23.76, 26.96],
      [5, 4, 4, 3, 3, 4, 3, 4],
      30.2,
    );
    expect(riding.cut).toBe('aligned');
    expect(riding.found).toBe(6);
    expect(riding.boundaries).toEqual([0, 5.033, 8.99, 12.82, 15.59, 20.39, 23.76, 26.96, 30.2]);
    // As many cuts as expected, one of them a flash: the flash is left out and the missing cut planned
    const flash = multiShotBoundaries([2, 9], [5, 4, 6], 16.5);
    expect(flash).toEqual({ boundaries: [0, 5.5, 9, 16.5], cut: 'aligned', found: 1 });
    // fp53's kite 2: two of its joins dissolves the scene filter does not see, a hard cut a second early: one found
    const fewer = multiShotBoundaries([4.02, 16.73], [5, 2, 4, 5, 4], 20.1);
    expect(fewer.found).toBe(1);
    expect(fewer.boundaries[4]).toBe(16.73);
    expect(missedCuts(fewer.found, 4)).toBe(true);
    expect(missedCuts(riding.found, 7)).toBe(false);
    // Boundaries always rise
    for (const b of [riding, flash, fewer].map((r) => r.boundaries))
      expect(b.every((t, k) => k === 0 || t > b[k - 1]!)).toBe(true);
  });
});

describe('a render that missed its cuts (docs/design/multi-shot.md#splitting-and-verification)', () => {
  it('misses them when its split finds at most half the cuts its plan expects', () => {
    expect(missedCuts(0, 1)).toBe(true);
    expect(missedCuts(1, 1)).toBe(false);
    expect(missedCuts(1, 4)).toBe(true);
    expect(missedCuts(2, 4)).toBe(true);
    expect(missedCuts(3, 4)).toBe(false);
    expect(missedCuts(3, 7)).toBe(true);
    expect(missedCuts(4, 7)).toBe(false);
    // a single shot has no cut to miss
    expect(missedCuts(0, 0)).toBe(false);
  });

  it('is rendered again only when a project asks: off in the schema, carried by the patch schema', () => {
    expect(ProjectSettingsSchema.parse({}).generation.rerenderMissedCuts).toBe(false);
    expect(ProjectSettingsPatchSchema.parse({ generation: { rerenderMissedCuts: true } }).generation).toEqual(
      { rerenderMissedCuts: true },
    );
    expect(() => ProjectSettingsPatchSchema.parse({ generation: { rerenderMissedCuts: 'yes' } })).toThrow();
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

  it('renders a voiced sequence with its sound: each line in its own shot, in its speaker’s voice', () => {
    const settings = ProjectSettingsSchema.parse({
      generation: { promptVersion: 2, includeAudio: true },
      dialogue: { mode: 'off' },
    });
    const rosie = f.character({ name: 'Rosie' });
    const sammy = f.character({ name: 'Sammy' });
    const a = f.shot({
      description: 'Rosie raises a paw',
      durationSec: 3,
      characterIds: [rosie.id, sammy.id],
      dialogue: [{ characterId: rosie.id, line: 'Slow down. Breathe.' }],
    });
    const b = f.shot({
      description: 'Sammy coughs, then swims on',
      durationSec: 4,
      characterIds: [sammy.id],
      dialogue: [{ characterId: sammy.id, line: 'I can keep going.' }],
    });
    const req = compileMultiShotRequest(
      [a, b].map((shot) => ({
        shot,
        characters: [rosie, sammy].filter((c) => shot.characterIds.includes(c.id)),
        elements: [],
        screenplay: null,
        settings,
      })),
      { firstFrameUri: 'data:kf', referenceUris: [], attempt: 0, includeAudio: true },
    );
    const text = (req.input[0] as { text: string }).text;
    expect(req.parameters).toMatchObject({ duration_seconds: 7, include_audio: true });
    const first = text.indexOf('Shot 1 [0-3s]:');
    const second = text.indexOf('Shot 2 [3-7s]:');
    expect(first).toBeGreaterThanOrEqual(0);
    expect(second).toBeGreaterThan(first);
    // each line inside its own shot, said in its speaker's voice
    const rosieSays = text.search(/Rosie says, in [^:]+ voice: "Slow down\. Breathe" Lip sync\./);
    const sammySays = text.search(/Sammy says, in [^:]+ voice: "I can keep going" Lip sync\./);
    expect(rosieSays).toBeGreaterThan(first);
    expect(rosieSays).toBeLessThan(second);
    expect(sammySays).toBeGreaterThan(second);
    expect(text).toContain('No BGM');
  });
});
