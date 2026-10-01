import { describe, expect, it } from 'vitest';
import {
  assembleStoryTimeline,
  CharacterSchema,
  checkRequirement,
  compileVideoRequest,
  DIALOGUE_LAYOUT,
  DIALOGUE_TRACK_ID,
  isRealPersonCharacter,
  layoutDialogue,
  lineSeed,
  newVoice,
  ProjectSettingsSchema,
  type Scene,
  shotSpeakers,
  speakingCharacters,
  staleVoices,
  takeState,
  type Voice,
  voicedLines,
  voiceReady,
  voiceSampleText,
  voiceStatus,
  voicesNotReady,
} from '../src';
import * as f from '../src/testing/fixtures';

const lockedVoice = (overrides: Partial<Voice> = {}): Voice => ({
  ...newVoice('warm alto'),
  provider: 'elevenlabs',
  voiceId: 'mv200xabc',
  source: 'designed',
  sample: f.media({ mime: 'audio/mpeg', path: 'media/voices/mira.mp3' }),
  lock: { locked: true, version: 1 },
  ...overrides,
});

const scene = (overrides: Partial<Scene>): Scene => ({
  id: 'scn_0000000000aaaaaa',
  index: 0,
  beatId: null,
  heading: 'INT. LAMP ROOM - NIGHT',
  location: '',
  timeOfDay: '',
  summary: '',
  action: '',
  dialogue: [],
  characterIds: [],
  locationId: null,
  elementIds: [],
  estDurationSec: 10,
  ...overrides,
});

describe('voices (docs/design/dialogue.md#voice-of-a-character)', () => {
  it('reads characters saved before voices were locked', () => {
    const legacy = CharacterSchema.parse({ ...f.character(), voice: { description: 'gravelly, gentle' } });
    expect(legacy.voice).toEqual(newVoice('gravelly, gentle'));
    expect(voiceStatus(legacy)).toBe('none');
    expect(voiceStatus(f.character())).toBe('none');
  });

  it('is ready for TTS with a provider voice and for native audio with a sample', () => {
    const c = f.character({ voice: lockedVoice() });
    expect(voiceReady(c, 'tts')).toBe(true);
    expect(voiceStatus(c)).toBe('locked');
    const sampleOnly = f.character({ voice: lockedVoice({ voiceId: null }) });
    expect(voiceReady(sampleOnly, 'tts')).toBe(false);
    expect(voiceReady(sampleOnly, 'native')).toBe(true);
    expect(
      voiceReady(f.character({ voice: lockedVoice({ lock: { locked: false, version: 1 } }) }), 'tts'),
    ).toBe(false);
  });

  it('counts a cloned real voice for the disclosure label', () => {
    const consent = {
      depictsRealPerson: true,
      subject: 'Ada',
      grantedBy: 'Ada',
      grantedAt: '2026-09-30',
      recordedBy: { kind: 'user' as const, id: 'u', name: 'U' },
      recordedAt: '2026-09-30T00:00:00.000Z',
    };
    const plain = f.character({ references: [f.reference()] });
    expect(isRealPersonCharacter(plain)).toBe(false);
    expect(isRealPersonCharacter({ ...plain, voice: lockedVoice({ source: 'cloned', consent }) })).toBe(true);
    expect(
      isRealPersonCharacter({
        ...plain,
        voice: lockedVoice({ source: 'cloned', consent: { ...consent, depictsRealPerson: false } }),
      }),
    ).toBe(false);
  });

  it('pads the preview text to the provider minimum with the character’s own lines first', () => {
    const text = voiceSampleText({ name: 'Mira' }, ['Who keeps sending these?']);
    expect(text.startsWith('Who keeps sending these? My name is Mira.')).toBe(true);
    expect(text.length).toBeGreaterThanOrEqual(100);
    expect(voiceSampleText({ name: 'Mira' }, ['x'.repeat(2000)])).toHaveLength(1000);
  });
});

describe('lines of a shot', () => {
  const mira = f.character({ name: 'Mira', voice: lockedVoice() });
  const tom = f.character({ name: 'Tom', voice: lockedVoice({ voiceId: 'mv150xdef' }) });
  const characters = f.byId([mira, tom]);
  const shot = f.shot({
    dialogue: [
      { characterId: tom.id, line: 'Then read the next one.' },
      { characterId: null, line: 'A gull cries.' },
      { characterId: mira.id, line: 'Who keeps sending these?' },
      { characterId: tom.id, line: '  ' },
    ],
  });

  it('voices lines of known characters, in order, with fixed seeds (V3)', () => {
    expect(voicedLines(shot, characters)).toEqual([
      { index: 0, characterId: tom.id, text: 'Then read the next one.' },
      { index: 2, characterId: mira.id, text: 'Who keeps sending these?' },
    ]);
    expect(shotSpeakers(shot, characters)).toEqual([tom.id, mira.id]);
    const line = { index: 2, text: 'Who keeps sending these?' };
    expect(lineSeed(shot.id, line)).toBe(lineSeed(shot.id, line));
    expect(lineSeed(shot.id, line)).not.toBe(lineSeed(shot.id, { ...line, index: 3 }));
  });

  it('places lines one after another and sizes the shot to hold them', () => {
    // lead 0.4 s, 1.5 s line, 0.3 s gap, 2 s line, 0.5 s tail
    expect(layoutDialogue([1.5, 2])).toEqual({ offsets: [DIALOGUE_LAYOUT.leadSec, 2.2], totalSec: 4.7 });
    expect(layoutDialogue([])).toEqual({ offsets: [], totalSec: 0.9 });
  });

  it('needs locked voices for the speakers only when dialogue is on (V1)', () => {
    const unlocked = {
      ...characters,
      [tom.id]: { ...tom, voice: lockedVoice({ lock: { locked: false, version: 0 } }) },
    };
    expect(voicesNotReady([shot], unlocked, 'tts').map((c) => c.name)).toEqual(['Tom']);
    expect(voicesNotReady([shot], unlocked, 'off')).toEqual([]);
    expect(voicesNotReady([shot], characters, 'tts')).toEqual([]);
  });

  it('asks the video model for speech, reference audio and the dialogue length', () => {
    const settings = ProjectSettingsSchema.parse({ dialogue: { mode: 'tts' } });
    const ctx = { shot: { ...shot, durationSec: 5 }, characters: [mira, tom], screenplay: null, settings };
    const req = compileVideoRequest(ctx, {
      referenceUris: [],
      attempt: 0,
      referenceAudioUris: ['data:audio/wav;base64,AA=='],
      includeAudio: true,
      durationSec: 7.3,
    });
    expect((req.input[0] as { text: string }).text).toContain(
      'Dialogue: Tom says "Then read the next one" Narrator says "A gull cries" Mira says "Who keeps sending these?".',
    );
    expect(req.input.at(-1)).toEqual({
      type: 'audio',
      uri: 'data:audio/wav;base64,AA==',
      role: 'reference_audio',
    });
    expect(req.parameters).toMatchObject({ include_audio: true, duration_seconds: 7.3 });
    // Off: no lines in the prompt, no sound unless asked for.
    const off = compileVideoRequest(
      { ...ctx, settings: ProjectSettingsSchema.parse({}) },
      { referenceUris: [], attempt: 0 },
    );
    expect((off.input[0] as { text: string }).text).not.toContain('Dialogue:');
    expect(off.parameters).toMatchObject({ include_audio: false, duration_seconds: 5 });
  });
});

describe('workflow and drift (V6)', () => {
  it('requires a locked voice for every speaking character when dialogue is on', () => {
    const mira = f.character({ name: 'Mira', voice: lockedVoice({ lock: { locked: false, version: 0 } }) });
    const tom = f.character({ name: 'Tom' });
    const quiet = f.character({ name: 'Quiet' });
    const sp = f.screenplay({
      scenes: [scene({ dialogue: [{ characterId: mira.id, character: 'Mira', line: 'Hi' }] })],
    });
    const planned = f.clip({ shots: [f.shot({ dialogue: [{ characterId: tom.id, line: 'Hello' }] })] });
    const docs = (mode: 'tts' | 'off') =>
      f.docs({
        project: f.project({ settings: ProjectSettingsSchema.parse({ dialogue: { mode } }) }),
        screenplay: sp,
        characters: f.byId([mira, tom, quiet]),
        clips: f.byId([planned]),
      });
    expect(speakingCharacters(docs('tts')).map((c) => c.name)).toEqual(['Mira', 'Tom']);
    expect(checkRequirement('voices.speakingLocked', docs('tts'))).toMatchObject({
      ok: false,
      details: ['Mira', 'Tom'],
    });
    expect(checkRequirement('voices.speakingLocked', docs('off')).ok).toBe(true);
  });

  it('marks takes stale when a speaker’s voice is relocked', () => {
    const mira = f.character({ voice: lockedVoice() });
    const shot = f.readyShot([mira]);
    const take = {
      ...shot.takes[0]!,
      audio: {
        mode: 'tts' as const,
        dialogue: null,
        lines: [],
        voiceLocks: { [mira.id]: 1 },
        lipSync: 'none' as const,
      },
    };
    expect(takeState(take, shot, f.byId([mira]))).toBe('passed');
    const relocked = { ...mira, voice: lockedVoice({ lock: { locked: true, version: 2 } }) };
    expect(staleVoices(take, f.byId([relocked]))).toEqual([mira.id]);
    expect(takeState(take, shot, f.byId([relocked]))).toBe('stale');
  });
});

describe('timeline (docs/design/dialogue.md#timeline)', () => {
  it('puts the TTS mixes on a Dialogue track, mutes the takes under them and times the captions', () => {
    const mira = f.character({ name: 'Mira' });
    const mix = f.media({ mime: 'audio/wav', path: 'media/dialogue/c1-s1.wav', durationSec: 3.2 });
    const spoken = f.take({
      durationSec: 5,
      video: f.media({ durationSec: 5 }),
      audio: {
        mode: 'tts',
        dialogue: mix,
        lines: [
          {
            index: 0,
            characterId: mira.id,
            text: 'Who keeps sending these?',
            start: 0.5,
            end: 2.7,
            media: null,
          },
        ],
        voiceLocks: { [mira.id]: 1 },
        lipSync: 'conditioned',
      },
    });
    const silent = f.take({ durationSec: 4, video: f.media({ durationSec: 4 }) });
    const clip = f.clip({
      status: 'approved',
      shots: [
        f.shot({
          index: 0,
          takes: [spoken],
          selectedTakeId: spoken.id,
          dialogue: [{ characterId: mira.id, line: 'Who keeps sending these?' }],
        }),
        f.shot({ index: 1, takes: [silent], selectedTakeId: silent.id }),
      ],
    });
    const t = assembleStoryTimeline({
      clips: [clip],
      fps: 24,
      width: 320,
      height: 180,
      captions: true,
      characters: f.byId([mira]),
      music: { media: f.media({ mime: 'audio/mpeg', durationSec: 30 }) },
    });
    expect(t.tracks.map((x) => x.name)).toEqual(['Video', 'Music', 'Dialogue', 'Titles']);
    const [video, music, dialogue, titles] = t.tracks;
    expect(dialogue!.id).toBe(DIALOGUE_TRACK_ID);
    expect(video!.items.map((i) => (i as { volume: number }).volume)).toEqual([0, 1]);
    expect(dialogue!.items).toEqual([
      expect.objectContaining({
        kind: 'audio',
        start: 0,
        in: 0,
        out: 3.2,
        volume: 1,
        source: { type: 'media', media: mix },
      }),
    ]);
    expect(music!.items.length).toBeGreaterThan(0);
    expect(titles!.items).toEqual([
      expect.objectContaining({ start: 0.5, duration: 2.2, text: 'Mira: Who keeps sending these?' }),
    ]);
  });
});
