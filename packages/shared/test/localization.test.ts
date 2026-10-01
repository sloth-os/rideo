import { describe, expect, it } from 'vitest';
import {
  activeAt,
  applyDocChanges,
  applyOps,
  assembleStoryTimeline,
  captionWords,
  chunkGraph,
  cutLines,
  cutTakes,
  DIALOGUE_TRACK_ID,
  type Dub,
  docSpecForPath,
  dubIsCurrent,
  type Localization,
  localizationState,
  localizeTimeline,
  needsLipSync,
  newVoice,
  planChunks,
  primaryTrack,
  splitWords,
  subtitleCues,
  type TextItem,
  type Timeline,
  textAt,
  textFrames,
  toSrt,
  toVtt,
  type VideoItem,
  type Voice,
  validateDoc,
  withoutCaptions,
} from '../src';
import * as f from '../src/testing/fixtures';

const lockedVoice = (version = 1): Voice => ({
  ...newVoice('warm alto'),
  provider: 'elevenlabs',
  voiceId: 'mv200xabc',
  source: 'designed',
  sample: f.media({ mime: 'audio/mpeg', path: 'media/voices/mira.mp3' }),
  lock: { locked: true, version },
});

const caption = (overrides: Partial<TextItem> = {}): TextItem => ({
  id: 'itm_caption0001',
  kind: 'text',
  start: 10,
  duration: 3,
  text: 'Mira: Who keeps writing?',
  style: { preset: 'caption', position: 'bottom' },
  words: [
    { from: 6, to: 9, start: 0.2, end: 0.5 },
    { from: 10, to: 15, start: 0.6, end: 1 },
    { from: 16, to: 24, start: 1.1, end: 1.8 },
  ],
  ...overrides,
});

describe('word timing (docs/design/localization.md#captions-and-word-timing)', () => {
  it('splits words and times them from the alignment or by length', () => {
    expect(splitWords('  No,  you. ')).toEqual([
      { from: 2, to: 5 },
      { from: 7, to: 11 },
    ]);
    // aligned: one time per word of the line, after the speaker prefix
    expect(
      captionWords('Mira: Who keeps', 6, {
        start: 0,
        end: 1,
        words: [
          { text: 'Who', start: 0.1, end: 0.3 },
          { text: 'keeps', start: 0.4, end: 0.9 },
        ],
      }),
    ).toEqual([
      { from: 6, to: 9, start: 0.1, end: 0.3 },
      { from: 10, to: 15, start: 0.4, end: 0.9 },
    ]);
    // no alignment: in proportion to the word lengths
    expect(captionWords('ab abcdef', 0, { start: 0, end: 2 })).toEqual([
      { from: 0, to: 2, start: 0, end: 0.5 },
      { from: 3, to: 9, start: 0.5, end: 2 },
    ]);
  });

  it('shows whole lines, the line up to the spoken word, or the spoken word alone', () => {
    expect(textFrames(caption())).toEqual([{ start: 0, end: 3, text: 'Mira: Who keeps writing?' }]);
    const build = caption({ style: { preset: 'caption', animate: 'build' } });
    expect(textFrames(build)).toEqual([
      { start: 0.2, end: 0.6, text: 'Mira: Who' },
      { start: 0.6, end: 1.1, text: 'Mira: Who keeps' },
      { start: 1.1, end: 3, text: 'Mira: Who keeps writing?' },
    ]);
    const pop = caption({ style: { preset: 'caption', animate: 'pop' } });
    expect(textFrames(pop).map((x) => x.text)).toEqual(['Who', 'keeps', 'writing?']);
    expect(textAt(pop, 0.1)).toBeNull();
    expect(textAt(pop, 0.7)).toBe('keeps');
    // a caption without words shows statically whatever its style
    expect(textFrames({ ...build, words: undefined })).toHaveLength(1);
  });

  it('draws the same word in the preview and in the ffmpeg chunk graph', () => {
    const base = applyOps(f.docs().timeline ?? emptyCut(), [
      {
        op: 'insert',
        trackId: primaryTrack(emptyCut()).id,
        item: {
          kind: 'video',
          source: { type: 'media', media: f.media({ durationSec: 20 }) },
          in: 0,
          out: 15,
        },
      },
    ]);
    const t = applyOps(base, [
      { op: 'add_text', item: caption() },
      { op: 'set_caption_style', style: { animate: 'pop' } },
    ]);
    expect((t.tracks.find((x) => x.kind === 'text')!.items[0] as TextItem).style).toMatchObject({
      preset: 'caption',
      animate: 'pop',
    });
    expect(activeAt(t, 10.7).text.map((x) => x.text)).toEqual(['keeps']);
    expect(activeAt(t, 10.1).text).toEqual([]);
    const [chunk] = planChunks(t, { targetSec: 30 });
    const g = chunkGraph(t, chunk!, {
      quality: 'draft',
      inputPath: () => '/in',
      textPath: (i) => `/t/${i}.txt`,
    });
    expect(g.textFiles.map((x) => x.content)).toEqual(['Who', 'keeps', 'writing?']);
    const graph = g.args[g.args.indexOf('-filter_complex') + 1]!;
    expect(graph).toContain("enable='between(t\\,10.2\\,10.6)'");
    expect(graph).toContain("enable='between(t\\,11.1\\,13)'");
    // pop captions are large
    expect(graph).toContain(`fontsize=${Math.round(180 / 12)}`);
    // editing the text drops the words
    const edited = applyOps(t, [{ op: 'update_text', itemId: 'itm_caption0001', text: 'Mira: Hello' }]);
    expect((edited.tracks.find((x) => x.kind === 'text')!.items[0] as TextItem).words).toBeUndefined();
  });
});

function emptyCut(): Timeline {
  return assembleStoryTimeline({ clips: [], fps: 24, width: 320, height: 180 });
}

describe('subtitle files (docs/design/localization.md#subtitle-files)', () => {
  it('writes SubRip and WebVTT with word timestamps', () => {
    const base = emptyCut();
    const t = applyOps(base, [
      { op: 'add_text', item: caption() },
      {
        op: 'add_text',
        item: {
          kind: 'text',
          start: 3725.5,
          duration: 1.25,
          text: 'A <b> & c',
          style: { preset: 'caption' },
        },
      },
      {
        op: 'add_text',
        item: { kind: 'text', start: 0, duration: 2, text: 'The Keeper', style: { preset: 'title' } },
      },
    ]);
    const cues = subtitleCues(t);
    expect(cues.map((c) => c.text)).toEqual(['Mira: Who keeps writing?', 'A <b> & c']);
    expect(toSrt(cues)).toBe(
      '1\n00:00:10,000 --> 00:00:13,000\nMira: Who keeps writing?\n\n2\n01:02:05,500 --> 01:02:06,750\nA <b> & c\n',
    );
    expect(toVtt(cues)).toBe(
      'WEBVTT\n\n00:00:10.000 --> 00:00:13.000\nMira: <00:00:10.200>Who <00:00:10.600>keeps <00:00:11.100>writing?\n\n' +
        '01:02:05.500 --> 01:02:06.750\nA &lt;b&gt; &amp; c\n',
    );
  });
});

/** A cut of two TTS takes (one a close-up) and a silent shot, with Mira's lines. */
function story() {
  const mira = f.character({ name: 'Mira', voice: lockedVoice() });
  const mix = f.media({ mime: 'audio/wav', durationSec: 3 });
  const words = [
    { text: 'Who', start: 0.5, end: 0.9 },
    { text: 'writes?', start: 1, end: 1.6 },
  ];
  const ttsTake = f.take({
    video: f.media({ durationSec: 5 }),
    audio: {
      mode: 'tts',
      dialogue: mix,
      lines: [
        { index: 0, characterId: mira.id, text: 'Who writes?', start: 0.5, end: 1.6, media: null, words },
      ],
      voiceLocks: { [mira.id]: 1 },
      lipSync: 'conditioned',
    },
  });
  const close = f.take({ video: f.media({ durationSec: 5 }) });
  const line = (text: string) => [{ characterId: mira.id, character: 'Mira', line: text }];
  const shots = [
    f.shot({ index: 0, takes: [ttsTake], selectedTakeId: ttsTake.id, dialogue: line('Who writes?') }),
    f.shot({
      index: 1,
      takes: [close],
      selectedTakeId: close.id,
      dialogue: line('Me.'),
      camera: { framing: 'close_up', movement: 'static' },
    }),
    f.readyShot([], { index: 2 }),
  ];
  const clip = f.clip({ status: 'approved', shots });
  const characters = f.byId([mira]);
  const timeline = assembleStoryTimeline({
    clips: [clip],
    fps: 24,
    width: 320,
    height: 180,
    characters,
    captions: true,
  });
  return { mira, clip, shots, characters, timeline, clips: { [clip.id]: clip } };
}

const localization = (s: ReturnType<typeof story>, dubs: Record<string, Dub> = {}): Localization => ({
  id: 'es',
  name: 'Spanish',
  lines: [
    {
      shotId: s.shots[0]!.id,
      index: 0,
      characterId: s.mira.id,
      source: 'Who writes?',
      text: '¿Quién escribe?',
      edited: false,
    },
    { shotId: s.shots[1]!.id, index: 0, characterId: s.mira.id, source: 'Me.', text: 'Yo.', edited: true },
  ],
  dubs,
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
});

const dubOf = (s: ReturnType<typeof story>, k: number, text: string, video = false): Dub => ({
  takeId: s.shots[k]!.selectedTakeId!,
  shotId: s.shots[k]!.id,
  clipId: s.clip.id,
  dialogue: f.media({ mime: 'audio/wav', durationSec: 2.5 }),
  lines: [
    {
      index: 0,
      characterId: s.mira.id,
      text,
      start: 0.4,
      end: 1.9,
      media: null,
      words: text.split(' ').map((w, i) => ({ text: w, start: 0.4 + i * 0.5, end: 0.8 + i * 0.5 })),
    },
  ],
  voiceLocks: { [s.mira.id]: 1 },
  video: video ? f.media({ durationSec: 5, path: 'media/takes/es-dub.mp4' }) : null,
  watermarkId: null,
  contentCredentials: null,
  createdAt: '2026-10-01T00:00:00.000Z',
});

describe('localizations (docs/design/localization.md#translation)', () => {
  it('are versioned documents named by their language', () => {
    expect(docSpecForPath('localizations/pt-BR.json')).toMatchObject({ kind: 'localization', id: 'pt-BR' });
    expect(docSpecForPath('localizations/spanish.json')).toBeNull();
    const s = story();
    expect(() => validateDoc('localizations/fr.json', localization(s))).toThrow(/does not match/);
    expect(validateDoc('localizations/es.json', localization(s))).toMatchObject({ id: 'es' });
    // render timelines carry no id of their own
    expect(validateDoc('renders/exp_0000000000test0.json', s.timeline)).toBeTruthy();
    const docs = applyDocChanges(f.docs(), { 'localizations/es.json': localization(s) });
    expect(Object.keys(docs.localizations)).toEqual(['es']);
  });

  it('lists the lines and takes of the cut, and what is stale', () => {
    const s = story();
    expect(cutTakes(s.timeline, s.clips).map((x) => x.shot.index)).toEqual([0, 1, 2]);
    expect(cutLines(s.timeline, s.clips).map((l) => l.text)).toEqual(['Who writes?', 'Me.']);
    const loc = localization(s);
    let state = localizationState(loc, s.timeline, s.clips, s.characters);
    expect(state.lines).toMatchObject({ total: 2, current: 2, missing: [], stale: [] });
    expect(state.dubs).toMatchObject({
      needed: 2,
      current: 0,
      missing: [s.shots[0]!.selectedTakeId, s.shots[1]!.selectedTakeId],
    });
    expect(needsLipSync(s.shots[1]!, s.characters)).toBe(true);
    expect(needsLipSync(s.shots[0]!, s.characters)).toBe(false);
    // a line changed in the shot: its translation is stale
    s.shots[1]!.dialogue[0]!.line = 'Me, of course.';
    state = localizationState(loc, s.timeline, s.clips, s.characters);
    expect(state.lines.stale).toEqual([`${s.shots[1]!.id}:0`]);
  });

  it('keeps a dub current while its lines and voices are', () => {
    const s = story();
    const dub = dubOf(s, 0, '¿Quién escribe?');
    const loc = localization(s, { [dub.takeId]: dub });
    expect(dubIsCurrent(dub, loc, s.shots[0]!, s.characters)).toBe(true);
    expect(localizationState(loc, s.timeline, s.clips, s.characters).dubs.current).toBe(1);
    // the translation was edited since
    expect(
      dubIsCurrent({ ...dub, lines: [{ ...dub.lines[0]!, text: 'Quién' }] }, loc, s.shots[0]!, s.characters),
    ).toBe(false);
    // the voice was relocked (V6)
    const relocked = { ...s.characters, [s.mira.id]: { ...s.mira, voice: lockedVoice(2) } };
    expect(dubIsCurrent(dub, loc, s.shots[0]!, relocked)).toBe(false);
  });
});

describe('language variants (docs/design/localization.md#language-variants)', () => {
  let n = 0;
  const newId = () => `itm_var${String(++n).padStart(7, '0')}`;
  const captionsOf = (t: Timeline) =>
    (t.tracks.find((x) => x.kind === 'text')!.items as TextItem[]).filter(
      (i) => i.style.preset === 'caption',
    );

  it('subtitles: translated captions on the original timings, the original sound', () => {
    const s = story();
    const t = applyOps(s.timeline, [{ op: 'set_caption_style', style: { animate: 'build' } }]);
    const v = localizeTimeline(t, {
      loc: localization(s),
      clips: s.clips,
      characters: s.characters,
      dubbed: false,
      newId,
    });
    const caps = captionsOf(v);
    expect(caps.map((c) => c.text)).toEqual(['Mira: ¿Quién escribe?', 'Mira: Yo.']);
    // the TTS line's timing (0.5 s into the first take), the cut's caption style
    expect(caps[0]).toMatchObject({ start: 0.5, style: { animate: 'build' } });
    expect(caps[0]!.words!.map((w) => caps[0]!.text.slice(w.from, w.to))).toEqual(['¿Quién', 'escribe?']);
    // the Dialogue track still plays the original mix
    expect(v.tracks.find((x) => x.id === DIALOGUE_TRACK_ID)!.items).toEqual(
      s.timeline.tracks.find((x) => x.id === DIALOGUE_TRACK_ID)!.items,
    );
    expect(captionsOf(withoutCaptions(v))).toEqual([]);
  });

  it('dubbed: the dubs on the Dialogue track, lip-synced close-ups, captions from the dub', () => {
    const s = story();
    const a = dubOf(s, 0, '¿Quién escribe?');
    const b = dubOf(s, 1, 'Yo.', true);
    const loc = localization(s, { [a.takeId]: a, [b.takeId]: b });
    const v = localizeTimeline(s.timeline, {
      loc,
      clips: s.clips,
      characters: s.characters,
      dubbed: true,
      newId,
    });
    const items = primaryTrack(v).items as VideoItem[];
    expect(items[1]!.source.media.path).toBe('media/takes/es-dub.mp4');
    expect(items[1]!.source).toMatchObject({ type: 'take', takeId: b.takeId });
    expect(items.slice(0, 2).map((i) => i.volume)).toEqual([0, 0]);
    expect(items[2]!.volume).toBe(1);
    const dialogue = v.tracks.find((x) => x.id === DIALOGUE_TRACK_ID)!.items;
    expect(
      dialogue.map((d) => [d.start, (d as { source: { media: { path: string } } }).source.media.path]),
    ).toEqual([
      [items[0]!.start, a.dialogue.path],
      [items[1]!.start, b.dialogue.path],
    ]);
    expect(dialogue[0]).toMatchObject({ speech: [[0.4, 1.9]] });
    const caps = captionsOf(v);
    expect(caps.map((c) => [c.text, c.start])).toEqual([
      ['Mira: ¿Quién escribe?', items[0]!.start + 0.4],
      ['Mira: Yo.', items[1]!.start + 0.4],
    ]);
    expect(caps[0]!.words![1]).toMatchObject({ start: 0.5, end: 0.9 });
    // the cut itself is untouched
    expect((primaryTrack(s.timeline).items as VideoItem[])[1]!.source.media.path).not.toBe(
      'media/takes/es-dub.mp4',
    );
  });
});
