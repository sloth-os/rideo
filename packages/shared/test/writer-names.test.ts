import { describe, expect, it } from 'vitest';
import {
  appendScenes,
  type Character,
  characterSeed,
  type Element,
  EXISTING_NAMES_LIMITS,
  existingNames,
  lookLine,
  newVoice,
  ScreenplayGenerateOutputSchema,
  screenplayFromLlm,
} from '../src';
import * as f from '../src/testing/fixtures';

/**
 * The project's names the writer is told and keeps (docs/design/continuity.md#storytelling): the lists `existingNames`
 * builds for `screenplay.generate` and `screenplay.extend`, and the merge that links the written scenes to them.
 */

const AT = '2026-11-01T00:00:00.000Z';
const BY = { kind: 'user', id: 'usr_mira' };

/** Fields the entity schemas gain with the studio library (docs/design/library.md): a merge must keep them as they are. */
function withFields<T>(base: T, fields: Record<string, unknown>): T {
  return { ...base, ...fields } as T;
}
const link = (itemId: string) => ({
  library: { itemId, version: 2, digest: 'a'.repeat(64), mode: 'used', at: AT, by: BY },
});
const pin = (kind: string, itemId: string) => ({
  deskUnit: {
    kind,
    itemId,
    version: 3,
    sha256: 'b'.repeat(64),
    name: 'Harbor set',
    actorKind: kind === 'desk-figure' ? 'adult' : null,
    heightM: kind === 'desk-figure' ? 1.7 : null,
    pinnedAt: AT,
    pinnedBy: BY,
  },
});

describe('existingNames', () => {
  it('is undefined for a project with no characters, places or props (styles do not count)', () => {
    expect(existingNames([], [])).toBeUndefined();
    expect(existingNames([], [f.element({ kind: 'style', name: 'Noir grade' })])).toBeUndefined();
  });

  it("lists each character's name, role and look in one line, and each place's and prop's kind, name and aliases", () => {
    const mira = f.character({ name: '  Mira Vale ', role: 'protagonist' });
    const harbor = f.element({ name: 'Harbor', aliases: [' the old docks ', ''] });
    const key = f.element({
      kind: 'prop',
      name: 'brass key',
      description: '',
      lock: { locked: false, version: 0 },
    });
    const style = f.element({ kind: 'style', name: 'Noir grade' });
    expect(existingNames([mira], [key, style, harbor])).toEqual({
      characters: [
        {
          name: 'Mira Vale',
          role: 'protagonist',
          identity:
            'early 30s woman, East Asian, slender athletic build, jet-black straight bob with blunt fringe',
        },
      ],
      elements: [
        { kind: 'location', name: 'Harbor', aliases: ['the old docks'] },
        { kind: 'prop', name: 'brass key', aliases: [] },
      ],
    });
    // Only names and looks: no descriptions, references or ids (the prompt stays short)
    const entry = existingNames([mira], [harbor])!;
    expect(Object.keys(entry.characters[0]!)).toEqual(['name', 'role', 'identity']);
    expect(Object.keys(entry.elements[0]!)).toEqual(['kind', 'name', 'aliases']);
  });

  it('has characters only, or places only, when the project has only those', () => {
    expect(existingNames([f.character()], [])).toMatchObject({ elements: [] });
    expect(existingNames([], [f.element()])).toMatchObject({ characters: [] });
  });

  it('keeps at most 40 characters: by role, the locked ones first, then by name', () => {
    const unlocked = { locked: false, version: 0 };
    const cast = [
      ...Array.from({ length: 40 }, (_, i) =>
        f.character({ name: `Extra ${String(i).padStart(2, '0')}`, role: 'minor', lock: unlocked }),
      ),
      f.character({ name: 'Zed', role: 'supporting', lock: unlocked }),
      f.character({ name: 'Yara', role: 'supporting' }),
      f.character({ name: 'Bran', role: 'antagonist', lock: unlocked }),
      f.character({ name: 'Mira Vale', role: 'protagonist', lock: unlocked }),
      f.character({ name: 'Ada', role: 'protagonist' }),
    ];
    const out = existingNames(cast, [])!;
    expect(out.characters).toHaveLength(EXISTING_NAMES_LIMITS.characters);
    expect(out.characters.slice(0, 5).map((c) => c.name)).toEqual([
      'Ada',
      'Mira Vale',
      'Bran',
      'Yara',
      'Zed',
    ]);
    // The minor extras fill what is left, by name: the last five are left out
    expect(out.characters.slice(5).map((c) => c.name)).toEqual(
      Array.from({ length: 35 }, (_, i) => `Extra ${String(i).padStart(2, '0')}`),
    );
  });

  it('keeps at most 80 places and props: locations first, the locked ones first, then by name', () => {
    const unlocked = { locked: false, version: 0 };
    const props = Array.from({ length: 50 }, (_, i) =>
      f.element({ kind: 'prop', name: `Prop ${String(i).padStart(2, '0')}` }),
    );
    const places = [
      ...Array.from({ length: 39 }, (_, i) =>
        f.element({ name: `Place ${String(i).padStart(2, '0')}`, lock: unlocked }),
      ),
      f.element({ name: 'Zanzibar quay' }),
    ];
    const out = existingNames([], [...props, ...places])!;
    expect(out.elements).toHaveLength(EXISTING_NAMES_LIMITS.elements);
    expect(out.elements.slice(0, 40).every((e) => e.kind === 'location')).toBe(true);
    expect(out.elements[0]!.name).toBe('Zanzibar quay');
    expect(out.elements[1]!.name).toBe('Place 00');
    expect(out.elements.slice(40).map((e) => e.name)).toEqual(
      Array.from({ length: 40 }, (_, i) => `Prop ${String(i).padStart(2, '0')}`),
    );
  });

  it('cuts each look to one line of at most 160 characters', () => {
    const long = f.character({
      identity: {
        age: 'late 40s',
        gender: 'man',
        ethnicity: 'Black British',
        build: 'broad,\n stocky build with a sailor’s rolling gait and the shoulders of a man who hauls nets',
        face: 'square jaw',
        hair: 'short salt-and-pepper curls going white at the temples, usually under a knitted cap',
        eyes: 'hazel',
        skin: 'deep brown',
        distinguishingMarks: 'round wire glasses; an anchor tattoo on the left forearm',
      },
    });
    const { identity } = existingNames([long], [])!.characters[0]!;
    expect(identity.length).toBeLessThanOrEqual(EXISTING_NAMES_LIMITS.line);
    expect(identity).not.toMatch(/\n/);
    expect(identity.startsWith('late 40s man, Black British, broad, stocky build')).toBe(true);
    expect(identity.endsWith('…')).toBe(true);
  });

  it("uses the summary when a character's identity is empty", () => {
    const sketch = f.character({
      summary: 'A postman with a secret.\n',
      identity: { age: '', gender: '', build: '', face: '', hair: '', eyes: '', skin: '' },
    });
    expect(lookLine(sketch)).toBe('A postman with a secret');
    expect(existingNames([sketch], [])!.characters[0]!.identity).toBe('A postman with a secret');
  });

  it('keeps at most 5 aliases of at most 160 characters together, skipping a longer one', () => {
    const long = 'x'.repeat(120);
    const harbor = f.element({
      name: 'Harbor',
      aliases: ['the old docks', 'w'.repeat(100), long, 'quay', 'the wharf', 'pier', 'the moorings', 'jetty'],
    });
    const { aliases } = existingNames([], [harbor])!.elements[0]!;
    expect(aliases).toEqual(['the old docks', 'w'.repeat(100), 'quay', 'the wharf', 'pier']);
    expect(aliases.join('').length).toBeLessThanOrEqual(EXISTING_NAMES_LIMITS.line);
    const short = f.element({ name: 'Harbor', aliases: [long, 'y'.repeat(30), 'the old docks'] });
    expect(existingNames([], [short])!.elements[0]!.aliases).toEqual([long, 'y'.repeat(30)]);
  });

  it('stays small at its worst: the most characters and places with the longest names, looks and aliases', () => {
    // every bound at its maximum: 120-character names, the longest role and kind, 160-character looks, and five
    // aliases of 32 characters (the most aliases that fit in 160 characters, each costing its quotes and comma)
    const name = (i: number) => `${String(i).padStart(3, '0')} ${'n'.repeat(116)}`;
    const cast = Array.from({ length: 100 }, (_, i) =>
      f.character({
        name: name(i),
        role: 'protagonist',
        summary: 's'.repeat(4000),
        identity: { ...f.character().identity, build: 'b'.repeat(200) },
      }),
    );
    const world = Array.from({ length: 200 }, (_, i) =>
      f.element({
        kind: i % 2 ? 'prop' : 'location',
        name: name(i),
        aliases: Array.from({ length: 20 }, (_, k) => `${k}`.padStart(32, 'a')),
      }),
    );
    const out = existingNames(cast, world)!;
    expect(out.characters).toHaveLength(40);
    expect(out.elements).toHaveLength(80);
    expect(out.characters.every((c) => c.name.length === 120 && c.identity.length === 160)).toBe(true);
    expect(out.elements.every((e) => e.kind === 'location' && e.aliases.length === 5)).toBe(true);
    expect(out.elements[0]!.aliases.join('')).toHaveLength(160);
    // The documented worst (docs/design/continuity.md#storytelling): about 10,000 tokens; a library's cast and places
    // are a few hundred characters.
    expect(JSON.stringify(out)).toHaveLength(40_069);
  });
});

describe("the writer's merge keeps the project's entities", () => {
  const unlocked = { locked: false, version: 1 };
  const lockedVoice = {
    ...newVoice('low and measured'),
    provider: 'elevenlabs',
    voiceId: 'gv1x0',
    source: 'designed' as const,
    sample: f.media({ mime: 'audio/mpeg' }),
    lock: { locked: true, version: 2, lockedAt: AT },
  };
  const mira = withFields(f.character({ name: 'Mira Vale', role: 'protagonist' }), {
    ...link('lib_mira0000001'),
    ...pin('desk-figure', 'lib_mirafigure01'),
  });
  const jonah = withFields(
    f.character({ name: 'Jonah Reed', role: 'supporting', lock: unlocked, voice: lockedVoice }),
    { ...link('lib_jonah000001'), ...pin('desk-figure', 'lib_jonahfigure1') },
  );
  const harbor = withFields(f.element({ name: 'Harbor', aliases: ['the old docks'] }), {
    ...link('lib_harbor00001'),
    ...pin('desk-set', 'lib_harborset001'),
  });
  const key = withFields(
    f.element({
      kind: 'prop',
      name: 'brass key',
      description: '',
      references: [],
      lock: { locked: false, version: 0 },
    }),
    { ...link('lib_brasskey0001'), ...pin('desk-prop', 'lib_brasskeyunit') },
  );

  /** What a writer told those names answers: it keeps them, describes Jonah anew and adds Ada. */
  const written = ScreenplayGenerateOutputSchema.parse({
    title: 'Episode 2',
    characters: [
      {
        name: 'Mira Vale',
        role: 'supporting',
        identity: { age: '60s', gender: 'woman', hair: 'white' },
        wardrobe: [{ name: 'Raincoat', description: 'yellow raincoat' }],
        voice: 'a squeaky tenor',
      },
      {
        name: 'Jonah Reed',
        role: 'antagonist',
        summary: 'The postman, now the harbour master.',
        identity: { age: 'late 40s', gender: 'man', build: 'broad' },
        wardrobe: [{ name: 'Harbour coat', description: 'navy pea coat' }],
        personality: 'warm, evasive',
        voice: 'gravelly, gentle',
      },
      {
        name: 'Ada',
        role: 'minor',
        identity: { age: 'mid 20s', gender: 'woman' },
        voice: 'quick and bright',
      },
    ],
    locations: [
      { name: 'Harbor', description: 'a different harbour altogether' },
      { name: 'Lamp room', description: 'a lantern room' },
    ],
    props: [{ name: 'brass key', description: 'long antique brass key with a lighthouse-shaped bow' }],
    outline: [
      { summary: 'Arrival', estDurationSec: 30 },
      { summary: 'The key', estDurationSec: 30 },
    ],
    scenes: [
      {
        beatIndex: 0,
        heading: 'EXT. HARBOR - NIGHT',
        location: 'Harbor',
        characters: ['Mira Vale', 'Jonah Reed', 'Ada'],
        props: ['brass key'],
        estDurationSec: 30,
      },
      {
        beatIndex: 1,
        heading: 'EXT. THE OLD DOCKS - DAY',
        location: 'the old docks',
        characters: ['Mira Vale'],
        estDurationSec: 30,
      },
    ],
  });

  const merged = () =>
    screenplayFromLlm(written, {
      targetDurationSec: 60,
      language: 'en',
      existing: [mira, jonah],
      existingElements: [harbor, key],
    });

  it('leaves a locked character exactly as it was, its library link and 3D pin included', () => {
    const { characters } = merged();
    expect(characters.filter((c) => c.name === 'Mira Vale')).toEqual([mira]);
  });

  it("keeps an unlocked character's id, seed, references, lock, library link, 3D pin and locked voice", () => {
    const { characters } = merged();
    const out = characters.find((c) => c.id === jonah.id)! as Character & Record<string, unknown>;
    expect(characters.filter((c) => c.name === 'Jonah Reed')).toHaveLength(1);
    expect(out).toMatchObject({
      id: jonah.id,
      seed: jonah.seed,
      references: jonah.references,
      lock: jonah.lock,
      ...link('lib_jonah000001'),
      ...pin('desk-figure', 'lib_jonahfigure1'),
    });
    // The writer re-describes a draft character (role, summary, look, outfits, personality)...
    expect(out).toMatchObject({
      role: 'antagonist',
      summary: 'The postman, now the harbour master.',
      personality: 'warm, evasive',
    });
    expect(out.identity).toMatchObject({ age: 'late 40s', build: 'broad' });
    expect(out.wardrobe.map((w) => w.name)).toEqual(['Harbour coat']);
    // ...but a locked voice stays as it is (rule V2)
    expect(out.voice).toEqual(lockedVoice);
  });

  it("gives an unlocked voice the writer's description, and a new character a seed of its own", () => {
    const plain = f.character({ name: 'Jonah Reed', lock: unlocked, voice: newVoice('old') });
    const { characters } = screenplayFromLlm(written, {
      targetDurationSec: 60,
      language: 'en',
      existing: [plain],
    });
    expect(characters.find((c) => c.id === plain.id)!.voice).toEqual(newVoice('gravelly, gentle'));
    const ada = characters.find((c) => c.name === 'Ada')!;
    expect([mira.id, jonah.id, plain.id]).not.toContain(ada.id);
    expect(ada.seed).toBe(characterSeed(ada.id));
  });

  it('keeps the places and props it matches by name or alias, links the scenes to them and adds no second one', () => {
    const { elements, screenplay, characters } = merged();
    expect(elements.find((e) => e.id === harbor.id)).toEqual(harbor);
    const placesNamedHarbor = elements.filter((e) =>
      [e.name, ...e.aliases].some((n) => ['harbor', 'the old docks'].includes(n.toLowerCase())),
    );
    expect(placesNamedHarbor.map((e) => e.id)).toEqual([harbor.id]);
    // An unlocked prop keeps everything and only gets the description it lacked
    expect(elements.find((e) => e.id === key.id)).toEqual({
      ...key,
      description: 'long antique brass key with a lighthouse-shaped bow',
    });
    expect(elements.filter((e) => e.name === 'brass key')).toHaveLength(1);
    const ada = characters.find((c) => c.name === 'Ada')!;
    expect(screenplay.scenes.map((s) => s.locationId)).toEqual([harbor.id, harbor.id]);
    expect(screenplay.scenes[0]!.characterIds).toEqual([mira.id, jonah.id, ada.id]);
    expect(screenplay.scenes[0]!.elementIds).toEqual([key.id]);
    // The new place the writer introduced is a draft of its own
    expect(elements.find((e) => e.name === 'Lamp room')).toMatchObject({
      lock: { locked: false, version: 0 },
    });
  });

  it('keeps them when the screenplay is extended', () => {
    const { screenplay, characters, elements } = merged();
    const more = appendScenes(
      {
        ...screenplay,
        outline: [
          ...screenplay.outline,
          { ...screenplay.outline[1]!, id: 'beat_3', index: 2, sceneId: null },
        ],
      },
      [
        {
          beatIndex: 2,
          heading: 'INT. THE OLD DOCKS - NIGHT',
          location: 'The Old Docks',
          timeOfDay: 'night',
          summary: 'The key turns.',
          action: 'Mira Vale turns the brass key.',
          dialogue: [{ character: 'Mira Vale', line: 'It fits.' }],
          characters: ['Mira Vale'],
          props: ['Brass Key', 'storm lantern'],
          estDurationSec: 30,
          continuity: 'night, lamplight',
        },
      ],
      characters,
      {
        existing: elements,
        introduced: { locations: [], props: [{ name: 'storm lantern', description: 'red' }] },
      },
    );
    expect(more.added[0]).toMatchObject({ locationId: harbor.id, characterIds: [mira.id] });
    expect(more.added[0]!.elementIds[0]).toBe(key.id);
    expect(more.elements.find((e) => e.id === harbor.id)).toEqual(harbor);
    expect(
      (more.elements.find((e) => e.id === key.id) as Element & Record<string, unknown>).deskUnit,
    ).toEqual(pin('desk-prop', 'lib_brasskeyunit').deskUnit);
    expect(more.elements.filter((e) => e.name === 'storm lantern')).toHaveLength(1);
    expect(more.elements).toHaveLength(elements.length + 1);
  });
});
