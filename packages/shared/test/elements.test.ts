import { describe, expect, it } from 'vitest';
import {
  checkRequirement,
  compileElementReferenceRequest,
  compileShotPrompt,
  elementIndex,
  elementsInUse,
  mergeElements,
  normalizePlannedShots,
  orderedShotElements,
  ProjectSettingsSchema,
  ScreenplayGenerateOutputSchema,
  screenplayFromLlm,
  selectReferences,
  staleElements,
  takeState,
} from '../src';
import * as f from '../src/testing/fixtures';

const settings = ProjectSettingsSchema.parse({});

describe('element library', () => {
  it('merges introduced and scene-named locations and props by name or alias', () => {
    const lamp = f.element({
      name: 'Lamp room',
      aliases: ['lantern room'],
      description: '',
      lock: { locked: false, version: 0 },
    });
    const merged = mergeElements(
      {
        locations: [{ name: 'LANTERN ROOM', description: 'brass lantern room' }],
        props: [{ name: 'Brass key', description: 'antique key' }],
      },
      [{ location: 'Harbour road', props: ['brass key', 'storm lantern'] }],
      [lamp],
    );
    expect(merged.map((e) => [e.kind, e.name])).toEqual([
      ['location', 'Lamp room'],
      ['prop', 'Brass key'],
      ['location', 'Harbour road'],
      ['prop', 'storm lantern'],
    ]);
    // an unlocked element without a description takes the writer's
    expect(merged[0]!.description).toBe('brass lantern room');
    expect(merged.slice(1).every((e) => !e.lock.locked && e.references.length === 0)).toBe(true);
    // a locked element is never changed
    const locked = f.element({ name: 'Lamp room', description: 'kept' });
    expect(
      mergeElements({ locations: [{ name: 'lamp room', description: 'new' }], props: [] }, [], [locked])[0],
    ).toEqual(locked);
    // ambiguous names resolve to nothing
    const twins = [f.element({ name: 'Dock' }), f.element({ name: 'dock' })];
    expect(elementIndex(twins)('location', 'Dock')).toBeNull();
  });

  it('links scenes and planned shots to their elements', () => {
    const out = ScreenplayGenerateOutputSchema.parse({
      title: 'T',
      characters: [{ name: 'Mira' }],
      locations: [{ name: 'Lamp room', description: 'brass' }],
      props: [{ name: 'Brass key', description: 'antique' }],
      outline: [{ summary: 'a', estDurationSec: 30 }],
      scenes: [
        { heading: 'INT. LAMP ROOM', location: 'lamp room', characters: ['Mira'], props: ['brass key'] },
      ],
    });
    const { screenplay, elements } = screenplayFromLlm(out, {
      targetDurationSec: 30,
      language: 'en',
      existing: [],
    });
    const scene = screenplay.scenes[0]!;
    const byName = Object.fromEntries(elements.map((e) => [e.name, e]));
    expect(scene.locationId).toBe(byName['Lamp room']!.id);
    expect(scene.elementIds).toEqual([byName['Brass key']!.id]);
    const shots = normalizePlannedShots(
      [
        {
          description: 'Wide',
          action: '',
          camera: { framing: 'wide', movement: 'static' },
          characters: [],
          durationSec: 5,
          continuity: 'cut',
          dialogue: [],
          props: ['Brass key', 'unknown thing'],
        },
        {
          description: 'Close',
          action: '',
          camera: { framing: 'close_up', movement: 'static' },
          characters: [],
          durationSec: 5,
          continuity: 'cut',
          dialogue: [],
          props: [],
        },
      ],
      {
        characters: [],
        minSec: 4,
        maxSec: 10,
        targetSec: 10,
        locationId: scene.locationId,
        sceneElements: [byName['Brass key']!],
      },
    );
    expect(shots.map((s) => s.elementIds)).toEqual([
      [scene.locationId, byName['Brass key']!.id],
      [scene.locationId],
    ]);
  });
});

describe('element conditioning (E3)', () => {
  const lamp = f.element({
    kind: 'location',
    name: 'Lamp room',
    description: 'circular brass lantern room.',
  });
  const key = f.element({
    kind: 'prop',
    name: 'Brass key',
    description: 'antique key',
    references: [f.elementReference({ view: 'detail' })],
  });

  it('orders location, props, styles and writes fixed sentences', () => {
    const style = f.element({ kind: 'style', name: 'Noir', description: 'high contrast' });
    const shot = f.shot({ elementIds: [style.id, key.id, lamp.id] });
    const ordered = orderedShotElements(shot, f.byId([lamp, key, style]));
    expect(ordered.map((e) => e.kind)).toEqual(['location', 'prop', 'style']);
    const prompt = compileShotPrompt(
      { shot, characters: [], elements: ordered, screenplay: null, settings },
      'keyframe',
    );
    expect(prompt).toContain(
      'Location (keep exactly as in the reference images): Lamp room — circular brass lantern room. Props (keep exactly as in the reference images): Brass key — antique key. Style reference: Noir — high contrast.',
    );
    // deterministic
    expect(
      compileShotPrompt({ shot, characters: [], elements: ordered, screenplay: null, settings }, 'keyframe'),
    ).toBe(prompt);
  });

  it('gives elements a quarter of the image budget, as a sheet when they outnumber it', () => {
    const mira = f.character();
    const one = selectReferences([mira], f.shot(), 4, 2, [lamp]);
    expect(one).toMatchObject({ needsSheet: false, elementSheet: false });
    expect(one.perElement.map((p) => p.elementId)).toEqual([lamp.id]);
    expect(one.perCharacter[0]!.refs.length).toBe(1); // 3 images left for one character, capped by its refs
    const two = selectReferences([mira], f.shot(), 4, 2, [lamp, key]);
    expect(two.elementSheet).toBe(true);
    expect(two.perElement.map((p) => p.refs[0]!.view)).toEqual(['establishing', 'detail']);
    // the cast needs the whole budget: elements are text only
    const crowd = selectReferences([f.character(), f.character()], f.shot(), 2, 2, [lamp]);
    expect(crowd.perElement).toEqual([]);
    // no elements: unchanged behaviour
    expect(selectReferences([mira], f.shot(), 4)).toMatchObject({ perElement: [], elementSheet: false });
  });

  it('compiles element reference sheets anchored on the first approved view', () => {
    const req = compileElementReferenceRequest(lamp, 'establishing', { screenplay: null, settings });
    expect(req.input[0]).toEqual({
      type: 'text',
      text: 'Element reference sheet, location: establishing wide shot of the place, empty of people, even natural light; no text. Lamp room: circular brass lantern room.',
    });
    const angle = compileElementReferenceRequest(lamp, 'angle', {
      screenplay: null,
      settings,
      baseImageUri: 'data:x',
    });
    expect(angle.input).toHaveLength(2);
    expect(angle.parameters?.seed).not.toBe(req.parameters?.seed);
  });
});

describe('element staleness (E6) and workflow requirements', () => {
  it('marks takes stale when an element is relocked', () => {
    const lamp = f.element();
    const shot = f.readyShot([], { elementIds: [lamp.id] });
    const take = { ...shot.takes[0]!, elementLocks: { [lamp.id]: 1 } };
    expect(takeState(take, shot, {}, { [lamp.id]: lamp })).toBe('passed');
    const relocked = { ...lamp, lock: { ...lamp.lock, version: 2 } };
    expect(staleElements(take, shot, { [lamp.id]: relocked })).toEqual([lamp.id]);
    expect(takeState(take, shot, {}, { [lamp.id]: relocked })).toBe('stale');
    // takes made before elements existed are not stale for shots without elements
    expect(takeState(shot.takes[0]!, { ...shot, elementIds: [] }, {}, { [lamp.id]: relocked })).toBe(
      'passed',
    );
  });

  it('requires elements in use for the cast gate and every element before production', () => {
    const used = f.element({ lock: { locked: false, version: 0 }, references: [] });
    const spare = f.element({ kind: 'prop', name: 'Spare', lock: { locked: false, version: 0 } });
    const sp = f.screenplay({
      scenes: [
        {
          id: 'scn_0000000000aaaaaa',
          index: 0,
          beatId: null,
          heading: 'INT',
          location: '',
          timeOfDay: '',
          summary: '',
          action: '',
          dialogue: [],
          characterIds: [],
          locationId: used.id,
          elementIds: [],
          estDurationSec: 10,
        },
      ],
    });
    const docs = f.docs({ screenplay: sp, elements: f.byId([used, spare]) });
    expect(elementsInUse(docs).map((e) => e.id)).toEqual([used.id]);
    expect(checkRequirement('elements.inUseLocked', docs)).toMatchObject({ ok: false, details: [used.name] });
    expect(checkRequirement('elements.inUseHaveApprovedRefs', docs).ok).toBe(false);
    expect(checkRequirement('elements.allLocked', docs)).toMatchObject({
      ok: false,
      details: [used.name, 'Spare'],
    });
    const locked = f.docs({
      screenplay: sp,
      elements: f.byId([f.element({ id: used.id }), { ...spare, lock: { locked: true, version: 1 } }]),
    });
    expect(checkRequirement('elements.inUseLocked', locked).ok).toBe(true);
    expect(checkRequirement('elements.inUseHaveApprovedRefs', locked).ok).toBe(true);
    expect(checkRequirement('elements.allLocked', locked).ok).toBe(true);
  });
});
