import { describe, expect, it } from 'vitest';
import {
  assembleAnimatic,
  audioSegments,
  boardApprovable,
  boardNeedsGeneration,
  boardPromptHash,
  boardState,
  type Clip,
  checkRequirement,
  chunkGraph,
  detectScriptFormat,
  fountainFromPdfLines,
  importedToScreenplayOutput,
  ProjectSettingsSchema,
  parseFdx,
  parseFountain,
  parseHeading,
  renderInputs,
  type Scene,
  type Shot,
  type ShotBoard,
  sceneSeconds,
  shotContextOf,
  shotListCsv,
  storyboardProgress,
  storyboardScenes,
} from '../src';
import * as f from '../src/testing/fixtures';

const scene = (index: number): Scene => ({
  id: `scn_00000000000000${index.toString().padStart(2, '0')}`,
  index,
  beatId: null,
  heading: `INT. ROOM ${index + 1} - NIGHT`,
  location: '',
  timeOfDay: '',
  summary: '',
  action: '',
  dialogue: [],
  characterIds: [],
  locationId: null,
  elementIds: [],
  estDurationSec: 10,
});

function setup(settings: Record<string, unknown> = {}) {
  const mira = f.character({ name: 'Mira' });
  const docs = f.docs({
    project: f.project({ settings: ProjectSettingsSchema.parse({ storyboard: { scenes: 2 }, ...settings }) }),
    screenplay: f.screenplay({ scenes: [scene(0), scene(1), scene(2)] }),
    characters: f.byId([mira]),
  });
  const board = (shot: Shot, overrides: Partial<ShotBoard> = {}): ShotBoard => ({
    keyframe: f.imageMedia({ path: `media/keyframes/${shot.id}.png` }),
    createdAt: '2026-10-01T00:00:00.000Z',
    request: { prompt: 'p', seed: 1, referenceCount: 1 },
    promptHash: boardPromptHash(shotContextOf(shot, docs)),
    consistency: f.report(),
    characterLocks: Object.fromEntries(
      shot.characterIds.map((id) => [id, docs.characters[id]!.lock.version]),
    ),
    elementLocks: {},
    audio: null,
    gatewayTaskIds: [],
    approved: false,
    approvedAt: null,
    approvedBy: null,
    ...overrides,
  });
  return { docs, mira, board };
}

describe('board frames (docs/design/storyboard.md#board-frames)', () => {
  it('moves through missing → unapproved → approved, and back when the shot or a lock changes', () => {
    const { docs, mira, board } = setup();
    const shot = f.shot({ characterIds: [mira.id] });
    expect(boardState(shot, docs)).toBe('missing');
    const drawn = { ...shot, board: board(shot) };
    expect(boardState(drawn, docs)).toBe('unapproved');
    expect(boardApprovable('unapproved')).toBe(true);
    const approved = { ...drawn, board: { ...drawn.board!, approved: true } };
    expect(boardState(approved, docs)).toBe('approved');
    // editing the shot changes its keyframe prompt
    expect(boardState({ ...approved, description: 'Something else entirely.' }, docs)).toBe('outdated');
    expect(boardState({ ...approved, negativePrompt: 'no rain' }, docs)).toBe('outdated');
    // relocking the character with changes
    const relocked = { ...docs, characters: { [mira.id]: { ...mira, lock: { ...mira.lock, version: 2 } } } };
    expect(boardState(approved, relocked)).toBe('stale');
    const failed = { ...shot, board: board(shot, { consistency: f.report({ status: 'failed' }) }) };
    expect(boardState(failed, docs)).toBe('failed');
    expect(boardApprovable('failed')).toBe(false);
    for (const s of ['missing', 'failed', 'stale', 'outdated'] as const)
      expect(boardNeedsGeneration(s)).toBe(true);
    expect(boardNeedsGeneration('unapproved')).toBe(false);
  });

  it('gates the pilot on the approved frames of the first scenes', () => {
    const { docs, board } = setup();
    expect(storyboardScenes(docs).map((s) => s.index)).toEqual([0, 1]);
    expect(checkRequirement('storyboard.approved', docs)).toMatchObject({
      ok: false,
      message: '2 storyboard scene(s) to plan and draw',
    });
    const shots = [f.shot({ index: 0 }), f.shot({ index: 1 })];
    const clips: Clip[] = [
      f.clip({ index: 0, sceneId: scene(0).id, shots: [{ ...shots[0]!, board: board(shots[0]!) }] }),
      f.clip({ index: 1, sceneId: scene(1).id, shots: [{ ...shots[1]!, board: null }] }),
      f.clip({ index: 2, sceneId: scene(2).id, shots: [f.shot()] }),
    ];
    const planned = { ...docs, clips: f.byId(clips) };
    const p = storyboardProgress(planned);
    expect(p).toMatchObject({ scenes: 2, planned: 2, shots: 2, approved: 0 });
    expect(p.pending).toEqual(['c1-s1 (unapproved)', 'c2-s2 (missing)']);
    expect(checkRequirement('storyboard.approved', planned)).toMatchObject({
      ok: false,
      message: '0 of 2 storyboard frames approved',
    });
    const done = {
      ...planned,
      clips: f.byId(
        clips.map((c) => ({
          ...c,
          shots: c.shots.map((s) => ({ ...s, board: { ...board(s), approved: true } })),
        })),
      ),
    };
    expect(checkRequirement('storyboard.approved', done)).toMatchObject({ ok: true });
    const off = {
      ...docs,
      project: f.project({ settings: ProjectSettingsSchema.parse({ storyboard: { enabled: false } }) }),
    };
    expect(checkRequirement('storyboard.approved', off)).toEqual({
      ok: true,
      message: 'The storyboard is off',
      id: 'storyboard.approved',
    });
  });
});

describe('animatic (docs/design/storyboard.md#animatic)', () => {
  it('lays the frames as stills for their shot or dialogue length, with dialogue and captions', () => {
    const { docs, mira, board } = setup();
    const a = f.shot({
      index: 0,
      durationSec: 4,
      dialogue: [{ characterId: mira.id, line: 'Who keeps sending these?' }],
    });
    const b = f.shot({ index: 1, durationSec: 3 });
    const mix = f.media({ mime: 'audio/wav', path: 'media/dialogue/a.wav', durationSec: 5.2 });
    const clip = f.clip({
      sceneId: scene(0).id,
      shots: [
        {
          ...a,
          board: board(a, {
            audio: {
              mode: 'tts',
              dialogue: mix,
              lines: [
                {
                  index: 0,
                  characterId: mira.id,
                  text: 'Who keeps sending these?',
                  start: 0.4,
                  end: 2.6,
                  media: null,
                },
              ],
              voiceLocks: {},
              lipSync: 'none',
            },
          }),
        },
        { ...b, board: board(b) },
        f.shot({ index: 2 }),
      ],
    });
    const t = assembleAnimatic({
      clips: [clip],
      fps: 24,
      width: 320,
      height: 180,
      captions: true,
      characters: docs.characters,
    });
    const [video, , dialogue, titles] = t.tracks;
    expect(t.tracks.map((x) => x.name)).toEqual(['Video', 'Music', 'Dialogue', 'Titles']);
    expect(video!.items.map((i) => [(i as { out: number }).out, (i as { start: number }).start])).toEqual([
      [5.2, 0],
      [3, 5.2],
    ]);
    expect(video!.items.every((i) => (i as { transitionIn?: unknown }).transitionIn == null)).toBe(true);
    expect(dialogue!.items).toEqual([
      expect.objectContaining({ start: 0, out: 5.2, source: { type: 'media', media: mix } }),
    ]);
    expect(titles!.items).toEqual([
      expect.objectContaining({ start: 0.4, text: 'Mira: Who keeps sending these?' }),
    ]);
    // stills are pictures only
    expect(audioSegments(t).map((s) => s.media.path)).toEqual(['media/dialogue/a.wav']);
    expect(
      renderInputs(t)
        .map((m) => m.mime)
        .sort(),
    ).toEqual(['audio/wav', 'image/png', 'image/png']);
  });

  it('renders stills by looping the image in the chunk graph', () => {
    const { board } = setup();
    const shot = f.shot({ durationSec: 2 });
    const t = assembleAnimatic({
      clips: [f.clip({ shots: [{ ...shot, board: board(shot) }] })],
      fps: 24,
      width: 320,
      height: 180,
    });
    const g = chunkGraph(
      t,
      { index: 0, start: 0, end: 2, frames: 48 },
      {
        quality: 'draft',
        inputPath: (m) => `/in/${m.hash}`,
        textPath: (i) => `/t/${i}`,
      },
    );
    const i = g.args.indexOf('-loop');
    expect(g.args.slice(i, i + 6)).toEqual(['-loop', '1', '-framerate', '24', '-t', '2.25']);
    expect(g.args).not.toContain('-ss');
    expect(g.args.join(' ')).toContain('[0:v]trim=start=0:end=2,setpts=PTS-STARTPTS,scale=320:180');
  });
});

describe('screenplay import (docs/design/storyboard.md#screenplay-import)', () => {
  const FOUNTAIN = `Title: The Night Ferry
Author: A. Writer

/* a boneyard note */
INT. FERRY CABIN - NIGHT

= Ada finds the ticket.

Rain on the porthole. [[a note]] ADA (40s) counts coins.

ADA
(to herself)
One more crossing.
Just one.

ELI (O.S.)
Last call!

CUT TO:

.FLASHBACK - THE PIER

@McGREGOR
Tide's turning.

>THE END<
`;

  it('reads Fountain: headings, synopses, cues, parentheticals, extensions and forced elements', () => {
    const s = parseFountain(FOUNTAIN);
    expect(s.title).toBe('The Night Ferry');
    expect(s.scenes.map((x) => x.heading)).toEqual(['INT. FERRY CABIN - NIGHT', 'FLASHBACK - THE PIER']);
    const [cabin, pier] = s.scenes;
    expect(cabin).toMatchObject({
      location: 'Ferry Cabin',
      timeOfDay: 'night',
      summary: 'Ada finds the ticket.',
    });
    expect(cabin!.action).toBe('Rain on the porthole.  ADA (40s) counts coins.');
    expect(cabin!.dialogue).toEqual([
      { character: 'ADA', line: 'One more crossing. Just one.', parenthetical: 'to herself' },
      { character: 'ELI', line: 'Last call!' },
    ]);
    expect(cabin!.characters).toEqual(['ADA', 'ELI']);
    expect(pier!.dialogue).toEqual([{ character: 'McGREGOR', line: "Tide's turning." }]);
    expect(sceneSeconds(cabin!)).toBeGreaterThanOrEqual(10);
  });

  it('reads Final Draft paragraphs and entities, and rebuilds Fountain from PDF lines', () => {
    const fdx = parseFdx(
      '<FinalDraft><Content><Paragraph Type="Scene Heading"><Text>EXT. ROAD - DAY</Text></Paragraph>' +
        '<Paragraph Type="Action"><Text>Fish &amp; chips.</Text></Paragraph>' +
        '<Paragraph Type="Character"><Text>TOM</Text></Paragraph>' +
        '<Paragraph Type="Parenthetical"><Text>(quietly)</Text></Paragraph>' +
        '<Paragraph Type="Dialogue"><Text>Hi </Text><Text Style="Italic">there</Text></Paragraph>' +
        '</Content><TitlePage><Content><Paragraph><Text>Road Story</Text></Paragraph></Content></TitlePage></FinalDraft>',
    );
    expect(fdx).toEqual({
      title: 'Road Story',
      scenes: [
        expect.objectContaining({
          heading: 'EXT. ROAD - DAY',
          action: 'Fish & chips.',
          dialogue: [{ character: 'TOM', line: 'Hi there', parenthetical: 'quietly' }],
        }),
      ],
    });
    expect(() => parseFdx('<xml/>')).toThrow();
    const text = fountainFromPdfLines([
      { page: 1, x: 108, y: 72, text: '1   INT. ROOM - DAY   1' },
      { page: 1, x: 108, y: 96, text: 'A door opens.' },
      { page: 1, x: 266, y: 120, text: 'ANNA' },
      { page: 1, x: 180, y: 132, text: 'Hello.' },
      { page: 2, x: 540, y: 60, text: '2.' },
      { page: 2, x: 266, y: 84, text: "ANNA (CONT'D)" },
      { page: 2, x: 180, y: 96, text: 'Again.' },
      { page: 2, x: 400, y: 120, text: '(MORE)' },
    ]);
    expect(text).toBe("INT. ROOM - DAY\n\nA door opens.\n\nANNA\nHello.\n\nANNA (CONT'D)\nAgain.\n");
    expect(parseFountain(text).scenes[0]!.dialogue).toEqual([
      { character: 'ANNA', line: 'Hello.' },
      { character: 'ANNA', line: 'Again.' },
    ]);
  });

  it('detects formats, parses headings and maps the script to the screenwriter shape', () => {
    expect(detectScriptFormat('a.pdf', '', '')).toBe('pdf');
    expect(detectScriptFormat('x', '', '%PDF-1.7')).toBe('pdf');
    expect(detectScriptFormat('a.fdx', '', '')).toBe('fdx');
    expect(detectScriptFormat('x', '', '<?xml?><FinalDraft>')).toBe('fdx');
    expect(detectScriptFormat('a.fountain', 'text/plain', 'INT.')).toBe('fountain');
    expect(parseHeading('INT./EXT. CAR - MOVING - NIGHT')).toEqual({
      location: 'Car - Moving',
      timeOfDay: 'night',
    });
    expect(parseHeading('EXT. HARBOUR ROAD #12#')).toEqual({ location: 'Harbour Road', timeOfDay: '' });
    const out = importedToScreenplayOutput(parseFountain(FOUNTAIN), 'Fallback');
    expect(out.characters.map((c) => [c.name, c.role])).toEqual([
      ['Ada', 'protagonist'],
      ['Eli', 'minor'],
      ['Mcgregor', 'minor'],
    ]);
    expect(out.locations.map((l) => l.name)).toEqual(['Ferry Cabin', 'Flashback - The Pier']);
    expect(parseHeading('INT. ROOM - LATER')).toEqual({ location: 'Room', timeOfDay: 'later' });
    expect(out.scenes[0]!.dialogue[0]).toMatchObject({ character: 'Ada', parenthetical: 'to herself' });
    expect(out.outline.map((b) => b.estDurationSec)).toEqual(out.scenes.map((s) => s.estDurationSec));
    expect(() => importedToScreenplayOutput({ title: '', scenes: [] }, 'x')).toThrow('no scene found');
  });
});

describe('shot list (docs/design/storyboard.md#shot-list)', () => {
  it('writes one CSV row per shot, quoting commas, quotes and line breaks', () => {
    const { docs, mira } = setup();
    const lamp = f.element({ name: 'Lamp room' });
    const clip = f.clip({
      sceneId: scene(0).id,
      shots: [
        f.shot({
          characterIds: [mira.id],
          elementIds: [lamp.id],
          description: 'She says "go", then runs',
          action: 'Line one\nline two',
          dialogue: [{ characterId: mira.id, line: 'Go, now!' }],
        }),
      ],
    });
    const csv = shotListCsv({ ...docs, elements: f.byId([lamp]), clips: f.byId([clip]) });
    expect(csv.startsWith('﻿scene,clip,shot,duration_sec')).toBe(true);
    const row = csv.split('\r\n')[1]!;
    expect(row).toBe(
      '1. INT. ROOM 1 - NIGHT,1,1,5.0,medium,tracking,cut,Mira,Lamp room,,"She says ""go"", then runs","Line one\nline two","Mira: Go, now!",missing,none',
    );
  });
});
