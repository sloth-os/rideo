import { describe, expect, it } from 'vitest';
import {
  appendScenes,
  fitOutline,
  mergeCharacters,
  nameIndex,
  normalizePlannedShots,
  ruleSuggestions,
  ScreenplayGenerateOutputSchema,
  screenplayFromLlm,
  suggestionFromLlm,
} from '../src';
import * as f from '../src/testing/fixtures';

const llm = ScreenplayGenerateOutputSchema.parse({
  title: 'The Keeper',
  characters: [
    {
      name: 'Mira Vale',
      role: 'protagonist',
      identity: { age: '30s', gender: 'woman', hair: 'black bob' },
      wardrobe: [{ name: 'Coat', description: 'grey coat' }],
    },
    { name: 'Jonah', role: 'supporting', identity: { age: '40s', gender: 'man' } },
  ],
  outline: [
    { summary: 'Arrival', estDurationSec: 50 },
    { summary: 'Letters', estDurationSec: 50 },
  ],
  scenes: [
    {
      beatIndex: 0,
      heading: 'INT. LAMP ROOM - NIGHT',
      characters: ['Mira', 'Jonah'],
      dialogue: [{ character: 'Mira', line: 'Who?' }],
      estDurationSec: 40,
    },
  ],
});

describe('screenplay normalization', () => {
  it('assigns ids, links scenes to beats and scales the outline to the target', () => {
    const { screenplay, characters } = screenplayFromLlm(llm, {
      targetDurationSec: 60,
      language: 'en',
      existing: [],
    });
    expect(characters.map((c) => c.name)).toEqual(['Mira Vale', 'Jonah']);
    expect(characters[0]!.lock).toEqual({ locked: false, version: 0 });
    expect(characters[0]!.wardrobe[0]).toMatchObject({ name: 'Coat', default: true });
    expect(screenplay.outline.reduce((s, b) => s + b.estDurationSec, 0)).toBeCloseTo(60);
    expect(screenplay.outline[0]!.sceneId).toBe(screenplay.scenes[0]!.id);
    expect(screenplay.scenes[0]!.characterIds).toEqual(characters.map((c) => c.id));
    expect(screenplay.scenes[0]!.dialogue[0]!.characterId).toBe(characters[0]!.id);
    expect(screenplay.scenes[0]!.estDurationSec).toBe(30);
  });

  it('keeps locked characters untouched and preserves identities of existing names', () => {
    const locked = f.character({ name: 'Mira Vale' });
    const merged = mergeCharacters(llm.characters, [locked]);
    expect(merged[0]).toBe(locked);
    const unlocked = { ...locked, lock: { locked: false, version: 1 } };
    const updated = mergeCharacters(llm.characters, [unlocked]);
    expect(updated[0]!.id).toBe(locked.id);
    expect(updated[0]!.identity.hair).toBe('black bob');
    expect(updated[0]!.references).toBe(unlocked.references);
  });

  it('matches first names and appends extension scenes to open beats', () => {
    const cast = [f.character({ name: 'Mira Vale' }), f.character({ name: 'Jonah Reed' })];
    expect(nameIndex(cast)('mira')).toBe(cast[0]!.id);
    const { screenplay } = screenplayFromLlm(llm, { targetDurationSec: 100, language: 'en', existing: cast });
    const { screenplay: next, added } = appendScenes(
      screenplay,
      [
        {
          beatIndex: 1,
          heading: 'EXT. SHORE',
          location: '',
          timeOfDay: '',
          summary: '',
          action: '',
          dialogue: [],
          characters: ['Jonah'],
          estDurationSec: 10,
        },
      ],
      cast,
    );
    expect(added[0]!.index).toBe(1);
    expect(next.outline[1]!.sceneId).toBe(added[0]!.id);
    expect(added[0]!.estDurationSec).toBe(50);
    expect(fitOutline([{ estDurationSec: 100 }], 102)).toEqual([100]);
  });
});

describe('shot planning normalization', () => {
  it('clamps, splits, scales and resolves characters', () => {
    const mira = f.character({ name: 'Mira Vale' });
    const shots = normalizePlannedShots(
      [
        {
          description: 'Wide of the lighthouse',
          action: '',
          camera: { framing: 'wide', movement: 'static' },
          characters: [],
          durationSec: 25,
          continuity: 'continuous',
          dialogue: [],
        },
        {
          description: 'Mira reads',
          action: 'She turns',
          camera: { framing: 'close_up', movement: 'dolly_in' },
          characters: ['mira'],
          durationSec: 1,
          continuity: 'continuous',
          dialogue: [{ character: 'Mira', line: 'Who?' }],
        },
        {
          description: '   ',
          action: '',
          camera: { framing: 'wide', movement: 'static' },
          characters: [],
          durationSec: 5,
          continuity: 'cut',
          dialogue: [],
        },
      ],
      { characters: [mira], minSec: 2, maxSec: 10, targetSec: 26 },
    );
    expect(shots.map((s) => s.durationSec)).toEqual([8.33, 8.33, 8.33, 2]);
    expect(shots.map((s) => s.continuity)).toEqual(['cut', 'continuous', 'continuous', 'continuous']);
    expect(shots[3]!.characterIds).toEqual([mira.id]);
    expect(shots[3]!.wardrobe[mira.id]).toBe(mira.wardrobe[0]!.id);
    expect(shots[3]!.dialogue[0]!.characterId).toBe(mira.id);
    expect(shots.map((s) => s.index)).toEqual([0, 1, 2, 3]);
  });
});

describe('edit suggestions', () => {
  it('derives rule-based suggestions from signal analysis', () => {
    const s = ruleSuggestions({
      durationSec: 30,
      silences: [
        { start: 0, end: 1.5 },
        { start: 10, end: 13 },
        { start: 28, end: 30 },
      ],
      blackSegments: [{ start: 20, end: 21 }],
    });
    expect(s.map((x) => x.params.kind)).toEqual(['cut', 'cut', 'tighten_silence', 'cut', 'fade']);
    expect(s.every((x) => x.source === 'rules' && x.status === 'pending')).toBe(true);
  });

  it('validates LLM suggestions against the schema and the footage length', () => {
    expect(
      suggestionFromLlm(
        { kind: 'transition', at: 5, type: 'crossfade', duration: 0.5, description: 'soften' },
        30,
      ),
    ).toMatchObject({ source: 'ai', params: { kind: 'transition' } });
    expect(suggestionFromLlm({ kind: 'cut', start: 5, end: 2 }, 30)).toBeNull();
    expect(suggestionFromLlm({ kind: 'cut', start: 5, end: 99 }, 30)).toBeNull();
    expect(suggestionFromLlm({ kind: 'explode', at: 1 }, 30)).toBeNull();
    expect(
      suggestionFromLlm({ kind: 'title', text: 'Hi', start: 0, duration: 2, confidence: 7 }, 30)?.confidence,
    ).toBe(0.5);
  });
});
