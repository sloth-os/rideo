import { describe, expect, it } from 'vitest';
import {
  compactIdentity,
  DESK_BRIEF_LIMITS,
  deskBrief,
  deskTimeOfDay,
  HostToDeskMessageSchema,
  headingInterior,
  heightInMetres,
  ProjectSettingsSchema,
  type Scene,
} from '../src';
import * as f from '../src/testing/fixtures';

/** The brief of a clip, row by row of docs/design/director-desk.md#the-brief. */

const scene = (overrides: Partial<Scene> = {}): Scene => ({
  id: 'scn_0000000000000001',
  index: 0,
  beatId: null,
  heading: 'INT. LAMP ROOM - NIGHT',
  location: 'Lamp room',
  timeOfDay: 'night',
  summary: '',
  action: '',
  dialogue: [],
  characterIds: [],
  locationId: null,
  elementIds: [],
  estDurationSec: 10,
  continuity: 'Rain on the glass; Mira wears her field jacket',
  ...overrides,
});

function story(
  opts: { heading?: string; timeOfDay?: string; resolution?: { width: number; height: number } } = {},
) {
  const mira = f.character({
    name: 'Mira',
    summary: 'A lighthouse keeper',
    identity: { ...f.character().identity, height: '170 cm' },
  });
  const pip = f.character({ name: 'Pip', summary: 'A golden retriever puppy.' });
  const ghost = f.character({ name: 'Ghost' });
  const room = f.element({ name: 'Lamp room', description: 'Brass lantern, salt-crusted windows.' });
  const lamp = f.element({ kind: 'prop', name: 'Oil lamp', description: 'A dented brass oil lamp' });
  const grain = f.element({ kind: 'style', name: 'Film grain', description: '35mm grain' });
  const sc = scene({
    locationId: room.id,
    elementIds: [grain.id],
    ...(opts.heading ? { heading: opts.heading } : {}),
    ...(opts.timeOfDay !== undefined ? { timeOfDay: opts.timeOfDay } : {}),
  });
  const s0 = f.shot({
    index: 0,
    description: 'Wide: Mira climbs into the lamp room.',
    characterIds: [mira.id],
    elementIds: [lamp.id],
    camera: { framing: 'wide', movement: 'tracking', move: 'tracking_follow', lensMm: 24 },
    layout: [{ characterId: mira.id, side: 'left', facing: 'right' }],
    durationSec: 4,
  });
  const s1 = f.shot({
    index: 1,
    description: 'Close: Pip watches her.',
    // ghost is not in the project (deleted): dropped from the cast and the layout
    characterIds: [pip.id, ghost.id, mira.id],
    elementIds: [room.id, 'ele_00000000000gone'],
    camera: { framing: 'close_up', movement: 'static' },
    layout: [
      { characterId: ghost.id, side: 'left', facing: 'camera' },
      { characterId: pip.id, side: 'right', facing: 'left' },
    ],
    durationSec: 2.5,
    continuity: 'continuous',
  });
  const clip = f.clip({ index: 2, sceneId: sc.id, title: 'INT. LAMP ROOM - NIGHT', shots: [s1, s0] });
  const project = f.project({
    settings: ProjectSettingsSchema.parse({ resolution: opts.resolution ?? { width: 1280, height: 720 } }),
  });
  const docs = f.docs({
    project,
    screenplay: f.screenplay({ scenes: [sc] }),
    characters: f.byId([mira, pip]),
    elements: f.byId([room, lamp, grain]),
    clips: f.byId([clip]),
  });
  return { docs, clip, mira, pip, ghost, room, lamp, grain, s0, s1 };
}

describe('deskBrief', () => {
  it('maps a clip row by row', () => {
    const { docs, clip, mira, pip, room, lamp, grain, s0, s1 } = story();
    const brief = deskBrief(docs, clip.id)!;
    expect(brief).toMatchObject({
      id: clip.id,
      name: 'INT. LAMP ROOM - NIGHT',
      fps: 24,
      width: 1280,
      height: 720,
    });
    expect(brief.set).toEqual({
      description:
        'Lamp room. Brass lantern, salt-crusted windows. Rain on the glass; Mira wears her field jacket.',
      interior: true,
      timeOfDay: 'night',
    });
    // the characters in order of first appearance (shots by index), those in the project
    expect(brief.cast.map((c) => c.id)).toEqual([mira.id, pip.id]);
    expect(brief.cast[0]).toEqual({
      id: mira.id,
      name: 'Mira',
      description: `${compactIdentity(mira)} A lighthouse keeper.`,
      kind: null,
      heightM: 1.7,
    });
    expect(brief.cast[1]!.heightM).toBeNull();
    // the scene's location, then the scene's and the shots' elements; a style is `other`
    expect(brief.elements.map((e) => [e.id, e.kind])).toEqual([
      [room.id, 'location'],
      [grain.id, 'other'],
      [lamp.id, 'prop'],
    ]);
    expect(brief.shots.map((s) => [s.id, s.index])).toEqual([
      [s0.id, 0],
      [s1.id, 1],
    ]);
    expect(brief.shots[0]).toEqual({
      id: s0.id,
      index: 0,
      durationSec: 4,
      description: 'Wide: Mira climbs into the lamp room.',
      action: s0.action,
      castIds: [mira.id],
      elementIds: [lamp.id],
      framing: 'wide',
      movement: 'tracking',
      move: 'tracking_follow',
      lensMm: 24,
      continuity: 'cut',
      layout: [{ castId: mira.id, side: 'left', facing: 'right' }],
    });
    // only the brief's cast and elements; layout entries of characters out of the cast dropped
    expect(brief.shots[1]).toMatchObject({
      castIds: [pip.id, mira.id],
      elementIds: [room.id],
      move: null,
      lensMm: null,
      continuity: 'continuous',
      layout: [{ castId: pip.id, side: 'right', facing: 'left' }],
    });
    // what goes to the desk is a valid `open`
    const open = {
      type: 'open',
      scene: brief,
      state: null,
      options: { hostName: 'Rideo', modes: ['camera'] },
    };
    expect(HostToDeskMessageSchema.safeParse(open).success).toBe(true);
  });

  it('has none for a clip without shots or one that is not there', () => {
    const { docs, clip } = story();
    const empty = { ...clip, shots: [] };
    expect(deskBrief({ ...docs, clips: { [clip.id]: empty } }, clip.id)).toBeNull();
    expect(deskBrief(docs, 'clp_00000000000none')).toBeNull();
    // ids that name members of every object are no clips either
    for (const id of ['constructor', '__proto__', 'toString', 'hasOwnProperty'])
      expect(deskBrief(docs, id)).toBeNull();
  });

  it('takes characters, elements and the location only from the project, never from object members', () => {
    const { docs, clip, s0, mira } = story();
    const odd = {
      ...s0,
      characterIds: ['constructor', '__proto__', mira.id],
      elementIds: ['toString', 'valueOf'],
      layout: [{ characterId: 'constructor', side: 'left' as const, facing: 'right' as const }],
    };
    const brief = deskBrief({ ...docs, clips: { [clip.id]: { ...clip, shots: [odd] } } }, clip.id)!;
    expect(brief.cast.map((c) => c.id)).toEqual([mira.id]);
    expect(brief.shots[0]).toMatchObject({ castIds: [mira.id], elementIds: [], layout: [] });
  });

  it("keeps a shot's layout to the shot's own cast: a character taken out of the shot but still in another is dropped", () => {
    const { docs, clip, s0, s1, mira, pip } = story();
    // Pip is in the brief's cast (shot 2), not in shot 1: the layout entry left behind is not staged
    const stale = {
      ...s0,
      layout: [
        { characterId: mira.id, side: 'left' as const, facing: 'right' as const },
        { characterId: pip.id, side: 'right' as const, facing: 'left' as const },
      ],
    };
    const brief = deskBrief({ ...docs, clips: { [clip.id]: { ...clip, shots: [s1, stale] } } }, clip.id)!;
    expect(brief.cast.map((c) => c.id)).toEqual([mira.id, pip.id]);
    expect(brief.shots[0]).toMatchObject({
      castIds: [mira.id],
      layout: [{ castId: mira.id, side: 'left', facing: 'right' }],
    });
  });

  it('names a scene without a title by its number, and cuts long titles', () => {
    const { docs, clip } = story();
    const untitled = deskBrief({ ...docs, clips: { [clip.id]: { ...clip, title: '  ' } } }, clip.id)!;
    expect(untitled.name).toBe('Scene 3');
    const long = deskBrief({ ...docs, clips: { [clip.id]: { ...clip, title: 'x'.repeat(300) } } }, clip.id)!;
    expect(long.name).toHaveLength(200);
  });

  it('rounds odd sizes down to even ones', () => {
    for (const [resolution, size] of [
      [{ width: 1281, height: 721 }, [1280, 720]],
      [{ width: 64, height: 65 }, [64, 64]],
      [{ width: 4095, height: 4096 }, [4094, 4096]],
    ] as const) {
      const { docs, clip } = story({ resolution });
      const brief = deskBrief(docs, clip.id)!;
      expect([brief.width, brief.height]).toEqual(size);
    }
  });

  it('reads interiors from the heading', () => {
    expect(headingInterior('INT. LAMP ROOM - NIGHT')).toBe(true);
    expect(headingInterior('int lamp room')).toBe(true);
    expect(headingInterior('EXT. HARBOUR - DAY')).toBe(false);
    expect(headingInterior('INT./EXT. CAR - DAY')).toBeNull();
    expect(headingInterior('EXT/INT CAR')).toBeNull();
    expect(headingInterior('I/E. CAR - DAY')).toBeNull();
    expect(headingInterior('EST. LIGHTHOUSE')).toBeNull();
    expect(headingInterior('The lighthouse')).toBeNull();
    const ext = story({ heading: 'EXT. CLIFF - DAWN' });
    expect(deskBrief(ext.docs, ext.clip.id)!.set.interior).toBe(false);
    const { docs, clip } = story({ heading: 'I/E. CAR - DAY' });
    expect(deskBrief(docs, clip.id)!.set.interior).toBeNull();
  });

  it('takes the time of day from the scene, else the heading, by the first rule that matches', () => {
    for (const [text, time] of [
      ['dawn', 'dawn'],
      ['Sunrise', 'dawn'],
      ['daybreak', 'dawn'],
      ['first light', 'dawn'],
      ['EARLY MORNING', 'dawn'],
      ['golden hour', 'golden_hour'],
      ['magic hour', 'golden_hour'],
      ['dusk', 'dusk'],
      ['sunset', 'dusk'],
      ['twilight', 'dusk'],
      ['evening', 'dusk'],
      ['night', 'night'],
      ['midnight', 'night'],
      ['noon', 'noon'],
      ['midday', 'noon'],
      ['late afternoon', 'afternoon'],
      ['morning', 'morning'],
      ['day', null],
      ['continuous', null],
      ['later', null],
      ['', null],
    ] as const)
      expect(deskTimeOfDay(text), text).toBe(time);
    // the scene's own field first, else the heading's time
    const a = story({ timeOfDay: 'Golden hour', heading: 'EXT. MEADOW - NIGHT' });
    expect(deskBrief(a.docs, a.clip.id)!.set.timeOfDay).toBe('golden_hour');
    const b = story({ timeOfDay: '', heading: 'EXT. MEADOW - SUNSET' });
    expect(deskBrief(b.docs, b.clip.id)!.set.timeOfDay).toBe('dusk');
    const c = story({ timeOfDay: 'DAY', heading: 'EXT. MEADOW - NIGHT' });
    expect(deskBrief(c.docs, c.clip.id)!.set.timeOfDay).toBeNull();
  });

  it('reads heights the identity names, 0.1–4 m', () => {
    expect(heightInMetres('170 cm')).toBe(1.7);
    expect(heightInMetres('about 180cm, broad')).toBe(1.8);
    expect(heightInMetres('1.2 m')).toBe(1.2);
    expect(heightInMetres('1,75 metres')).toBe(1.75);
    expect(heightInMetres('5 ft 8 in')).toBe(1.73);
    expect(heightInMetres(`5'8"`)).toBe(1.73);
    expect(heightInMetres('tall')).toBeNull();
    expect(heightInMetres('900 cm')).toBeNull();
    expect(heightInMetres('5 cm')).toBeNull();
    expect(heightInMetres(undefined)).toBeNull();
  });

  it.each([
    // millimetres, with and without a thousands separator
    ['1700 mm', 1.7],
    ['1,700 mm', 1.7],
    // a comma read as a decimal mark when the thousands reading is out of range
    ['1,70 m', 1.7],
    ['1,750 m', 1.75],
    // metres and centimetres written together
    ['1 m 70', 1.7],
    ['1m70', 1.7],
    ['1 m 75 cm', 1.75],
    ['1 m 70 tall', 1.7],
    // a weight after the metres is not centimetres
    ['1 m 80 kg', 1],
    ['1.8 m 80 kg', 1.8],
    ['175cm, 70 kg', 1.75],
    // feet and inches, the inches optional or with decimals; a weight in pounds is not inches
    ['5 ft 7 in', 1.7],
    ['5 ft 8', 1.73],
    [`5'7"`, 1.7],
    ['6 ft 180 lbs', 1.83],
    ['5.5 ft', 1.68],
    ['5 ft 11.5 in', 1.82],
    ['6 feet 2 inches', 1.88],
    ['about 2 metres', 2],
    ['50 cm (a small dog)', 0.5],
    ['12 m', null],
    ['', null],
  ])('reads %j as %s m', (written, metres) => {
    expect(heightInMetres(written)).toBe(metres);
  });

  it('keeps the protocol limits: 16 cast, 64 elements, 200 shots, strings cut', () => {
    const cast = Array.from({ length: 20 }, (_, i) =>
      f.character({ name: `C${i}`, summary: 'y'.repeat(5000) }),
    );
    const elements = Array.from({ length: 70 }, (_, i) =>
      f.element({ kind: 'prop', name: `E${i}`, description: 'z'.repeat(2500) }),
    );
    const shots = Array.from({ length: 205 }, (_, i) =>
      f.shot({
        index: i,
        description: 'd'.repeat(5000),
        action: 'a'.repeat(5000),
        characterIds: cast.slice(i % 20).map((c) => c.id),
        elementIds: elements.map((e) => e.id),
        layout: cast.slice(10, 18).map((c) => ({ characterId: c.id, side: 'centre', facing: 'camera' })),
      }),
    );
    const sc = scene({ continuity: 'c'.repeat(5000) });
    const clip = f.clip({ sceneId: sc.id, shots });
    const docs = f.docs({
      screenplay: f.screenplay({ scenes: [sc] }),
      characters: f.byId(cast),
      elements: f.byId(elements),
      clips: f.byId([clip]),
    });
    const brief = deskBrief(docs, clip.id)!;
    expect(brief.cast).toHaveLength(DESK_BRIEF_LIMITS.cast);
    expect(brief.cast.map((c) => c.id)).toEqual(cast.slice(0, 16).map((c) => c.id));
    expect(brief.elements).toHaveLength(64);
    expect(brief.shots).toHaveLength(200);
    expect(brief.shots.at(-1)!.index).toBe(199);
    expect(brief.set.description).toHaveLength(4000);
    expect(brief.cast[0]!.description).toHaveLength(4000);
    expect(brief.elements[0]!.description).toHaveLength(2000);
    expect(brief.shots[0]!.description).toHaveLength(4000);
    expect(brief.shots[0]!.action).toHaveLength(4000);
    // only cast members of the brief, in the layout too (C16–C17 are past the 16)
    expect(brief.shots[0]!.castIds).toHaveLength(16);
    expect(brief.shots[0]!.layout.map((p) => p.castId)).toEqual(cast.slice(10, 16).map((c) => c.id));
  });
});
