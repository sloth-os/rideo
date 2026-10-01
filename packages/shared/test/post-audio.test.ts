import { describe, expect, it } from 'vitest';
import {
  applyOps,
  applySuggestions,
  assembleStoryTimeline,
  audioSegments,
  CUE_OVERLAP_SEC,
  cueLength,
  DEFAULT_TRACK_IDS,
  DIALOGUE_TRACK_ID,
  duckEnvelope,
  duckExpression,
  duckGainAt,
  duckPoints,
  type EditSuggestion,
  EFFECTS_TRACK_ID,
  effectItems,
  effectLength,
  emptyTimeline,
  loudnormFilter,
  mergeSpans,
  parseLoudnorm,
  primaryTrack,
  SFX_AMBIENCE_VOLUME,
  scoreCues,
  scoreItems,
  soundtrackGraph,
  speechIntervals,
  stemOutputArgs,
  type Timeline,
  TimelineSchema,
  trackRole,
  type VideoItem,
} from '../src';
import * as f from '../src/testing/fixtures';

const inputPath = (m: { hash: string }) => `/in/${m.hash}`;
const graphOf = (args: string[]) => args[args.indexOf('-filter_complex') + 1]!;

/** 12 s of picture (two items), a music bed and one TTS mix with lines at 1–2.5 s and 3–4 s. */
function cut(opts: { ducking?: boolean } = {}): Timeline {
  const base = emptyTimeline({ fps: 24, width: 320, height: 180 });
  const t = applyOps(base, [
    {
      op: 'insert',
      trackId: primaryTrack(base).id,
      item: {
        id: 'itm_a000000001',
        kind: 'video',
        source: { type: 'media', media: f.media({ durationSec: 20 }) },
        in: 0,
        out: 6,
      },
    },
    {
      op: 'insert',
      trackId: primaryTrack(base).id,
      item: {
        id: 'itm_a000000002',
        kind: 'video',
        source: { type: 'media', media: f.media({ durationSec: 20 }) },
        in: 2,
        out: 8,
        speech: [[3, 5]],
      },
    },
    {
      op: 'insert',
      trackId: DEFAULT_TRACK_IDS.audio,
      item: {
        kind: 'audio',
        source: { type: 'media', media: f.media({ durationSec: 30 }) },
        start: 0,
        in: 0,
        out: 12,
      },
    },
    { op: 'add_track', track: { id: DIALOGUE_TRACK_ID, kind: 'audio', name: 'Dialogue' } },
    {
      op: 'insert',
      trackId: DIALOGUE_TRACK_ID,
      item: {
        kind: 'audio',
        source: { type: 'media', media: f.media({ durationSec: 5 }) },
        start: 0,
        in: 0,
        out: 5,
        speech: [
          [1, 2.5],
          [3, 4],
        ],
      },
    },
    ...(opts.ducking === false ? [] : [{ op: 'set_mix' as const, ducking: { enabled: true } }]),
  ]);
  return t;
}

describe('stems (docs/design/post-audio.md#stems)', () => {
  it('gives every sound a stem: production sound and the Dialogue track speak, the bed is music', () => {
    const t = cut();
    expect(t.tracks.map((tr) => trackRole(tr))).toEqual(['dialogue', 'music', null, 'dialogue']);
    expect(trackRole({ id: 'trk_other00000001', kind: 'audio' })).toBe('effects');
    expect(trackRole({ id: EFFECTS_TRACK_ID, kind: 'audio' })).toBe('effects');
    expect(trackRole({ id: DEFAULT_TRACK_IDS.audio, kind: 'audio', role: 'effects' })).toBe('effects');
    expect(audioSegments(t).map((s) => [s.role, s.primary])).toEqual([
      ['dialogue', true],
      ['dialogue', true],
      ['music', false],
      ['dialogue', false],
    ]);
    // add_track and set_track carry a role; text tracks have none
    const t2 = applyOps(t, [
      { op: 'add_track', track: { id: 'trk_voiceover0001', kind: 'audio', name: 'VO', role: 'dialogue' } },
      { op: 'set_track', trackId: primaryTrack(t).id, role: 'effects' },
    ]);
    expect(t2.tracks.find((x) => x.id === 'trk_voiceover0001')!.role).toBe('dialogue');
    expect(audioSegments(t2)[0]!.role).toBe('effects');
    expect(() => applyOps(t, [{ op: 'set_track', trackId: DEFAULT_TRACK_IDS.text, role: 'music' }])).toThrow(
      /text tracks/,
    );
  });

  it('mixes each stem on a bus and, with stems, writes each bus to its own output', () => {
    const t = cut({ ducking: false });
    const s = soundtrackGraph(t, { inputPath, stems: true });
    const g = graphOf(s.args);
    expect(g).toContain(
      'amix=inputs=3:normalize=0:dropout_transition=0,apad,atrim=0:12,asplit=2[bus_dialogue][stem_dialogue]',
    );
    expect(g).toContain('[a2]apad,atrim=0:12,asplit=2[bus_music][stem_music]');
    expect(g).toContain('anullsrc=r=48000:cl=stereo,atrim=0:12[stem_effects]');
    expect(g).toContain('[bus_dialogue][bus_music]amix=inputs=2:normalize=0:dropout_transition=0[aout]');
    expect(s.stems).toEqual({ dialogue: 'stem_dialogue', music: 'stem_music', effects: 'stem_effects' });
    expect(stemOutputArgs(s, (r) => `/out/${r}.flac`)).toEqual([
      '-map',
      '[stem_dialogue]',
      '-vn',
      '-c:a',
      'flac',
      '-sample_fmt',
      's16',
      '-ar',
      '48000',
      '/out/dialogue.flac',
      '-map',
      '[stem_music]',
      '-vn',
      '-c:a',
      'flac',
      '-sample_fmt',
      's16',
      '-ar',
      '48000',
      '/out/music.flac',
      '-map',
      '[stem_effects]',
      '-vn',
      '-c:a',
      'flac',
      '-sample_fmt',
      's16',
      '-ar',
      '48000',
      '/out/effects.flac',
    ]);
    // a single stem is passed through
    const solo = emptyTimeline({ fps: 24, width: 320, height: 180 });
    const one = applyOps(solo, [
      {
        op: 'insert',
        trackId: DEFAULT_TRACK_IDS.audio,
        item: {
          kind: 'audio',
          source: { type: 'media', media: f.media({ durationSec: 20 }) },
          start: 0,
          in: 0,
          out: 4,
        },
      },
    ]);
    expect(graphOf(soundtrackGraph(one, { inputPath }).args)).toContain('[bus_music]anull[aout]');
  });
});

describe('ducking (docs/design/post-audio.md#ducking)', () => {
  it('keys on speech spans in timeline time, merging close spans', () => {
    const t = cut();
    // the dialogue mix's lines, and the second clip's speech (source 3–5 s, the item starts at 6 s from source 2 s)
    expect(speechIntervals(t)).toEqual([
      [1, 2.5],
      [3, 4],
      [7, 9],
    ]);
    expect(speechIntervals(t, 0.85)).toEqual([
      [1, 4],
      [7, 9],
    ]);
    expect(
      mergeSpans([
        [5, 6],
        [1, 2],
        [1.5, 3],
        [7, 7],
      ]),
    ).toEqual([
      [1, 3],
      [5, 6],
    ]);
    // a dialogue-track item without spans speaks throughout; a primary item without spans does not
    const vo = applyOps(cut(), [
      {
        op: 'insert',
        trackId: DIALOGUE_TRACK_ID,
        item: {
          kind: 'audio',
          source: { type: 'media', media: f.media({ durationSec: 20 }) },
          start: 10,
          in: 0,
          out: 1.5,
        },
      },
    ]);
    expect(speechIntervals(vo).at(-1)).toEqual([10, 11.5]);
  });

  it('ramps the music down under speech and back up, identically for the preview and the render', () => {
    const t = cut();
    const env = duckEnvelope(t)!;
    expect(env.spans).toEqual([
      [1, 4],
      [7, 9],
    ]);
    expect(env.floor).toBeCloseTo(10 ** (-12 / 20), 6);
    expect(duckGainAt(env, 0)).toBe(1);
    expect(duckGainAt(env, 0.875)).toBeCloseTo(1 - (1 - env.floor) * 0.5, 6); // half-way through the attack
    expect(duckGainAt(env, 2)).toBeCloseTo(env.floor, 6);
    expect(duckGainAt(env, 4.3)).toBeCloseTo(1 - (1 - env.floor) * 0.5, 6); // half-way through the release
    expect(duckGainAt(env, 5.5)).toBe(1);
    // breakpoints from 2 s: hold the floor, release, attack, floor, release
    expect(duckPoints(env, 2).map((p) => p.time)).toEqual([2, 4, 4.6, 6.75, 7, 9, 9.6]);
    for (const p of duckPoints(env, 0)) expect(p.gain).toBeCloseTo(duckGainAt(env, p.time), 9);
    // the ffmpeg expression evaluates to the same gain
    const expr = duckExpression(env);
    const evalAt = (time: number) =>
      new Function('t', 'clip', 'min', `return ${expr};`)(
        time,
        (v: number, a: number, b: number) => Math.min(b, Math.max(a, v)),
        Math.min,
      ) as number;
    for (const time of [0, 0.8, 1, 2.5, 4.2, 5, 6.9, 8, 9.3, 11])
      expect(evalAt(time)).toBeCloseTo(duckGainAt(env, time), 2);
    expect(graphOf(soundtrackGraph(t, { inputPath }).args)).toContain(
      `[a2]apad,atrim=0:12,asetnsamples=n=480:p=0,volume='${expr}':eval=frame[bus_music]`,
    );
  });

  it('does not duck without the mix setting, music or speech', () => {
    expect(duckEnvelope(cut({ ducking: false }))).toBeNull();
    const t = applyOps(cut(), [{ op: 'set_mix', ducking: { enabled: false } }]);
    expect(duckEnvelope(t)).toBeNull();
    expect(applyOps(cut(), [{ op: 'set_mix', ducking: { depthDb: -18 } }]).mix!.ducking).toEqual({
      enabled: true,
      depthDb: -18,
      attackSec: 0.25,
      releaseSec: 0.6,
    });
    const noMusic = applyOps(cut(), [{ op: 'remove_track', trackId: DEFAULT_TRACK_IDS.audio }]);
    expect(duckEnvelope(noMusic)).toBeNull();
    expect(() => applyOps(cut(), [{ op: 'set_mix', ducking: { depthDb: 3 } }])).toThrow();
    // older cuts parse without a mix
    expect(TimelineSchema.parse({ ...cut(), mix: undefined }).mix).toBeUndefined();
  });

  it('writes speech spans and the default mix when the cut is built', () => {
    const mira = f.character({ name: 'Mira' });
    const mix = f.media({ mime: 'audio/mpeg', durationSec: 3.2 });
    const line = { index: 0, characterId: mira.id, text: 'Who?', start: 0.5, end: 2.7, media: null };
    const tts = f.take({
      audio: { mode: 'tts', dialogue: mix, lines: [line], voiceLocks: {}, lipSync: 'none' },
    });
    const native = f.take({
      audio: { mode: 'native', dialogue: null, lines: [], voiceLocks: {}, lipSync: 'none' },
    });
    const speaking = [{ characterId: mira.id, line: 'Who?', parenthetical: '' }];
    const clip = f.clip({
      status: 'approved',
      shots: [
        f.shot({ index: 0, takes: [tts], selectedTakeId: tts.id, dialogue: speaking }),
        f.shot({ index: 1, takes: [native], selectedTakeId: native.id, dialogue: speaking }),
        f.readyShot([], { index: 2 }),
      ],
    });
    const t = assembleStoryTimeline({ clips: [clip], fps: 24, width: 320, height: 180 });
    expect(t.mix).toEqual({ ducking: { enabled: true, depthDb: -12, attackSec: 0.25, releaseSec: 0.6 } });
    const items = primaryTrack(t).items as VideoItem[];
    expect(items.map((i) => i.speech)).toEqual([undefined, [[0, 5]], undefined]);
    const dialogue = t.tracks.find((x) => x.id === DIALOGUE_TRACK_ID)!;
    expect(dialogue.items[0]).toMatchObject({ speech: [[0.5, 2.7]] });

    // the auto edit takes speech from the transcript
    const footage = f.media({ durationSec: 20 });
    const cutSuggestion = {
      id: 'sug_0000000001',
      kind: 'cut',
      params: { kind: 'cut', start: 5, end: 10 },
      status: 'accepted',
    } as unknown as EditSuggestion;
    const auto = applySuggestions({
      source: { media: footage },
      durationSec: 20,
      suggestions: [cutSuggestion],
      fps: 24,
      width: 320,
      height: 180,
      speech: [
        { start: 1, end: 3 },
        { start: 4, end: 12 },
      ],
    });
    expect(auto.mix?.ducking.enabled).toBe(true);
    expect((primaryTrack(auto).items as VideoItem[]).map((i) => [i.in, i.out, i.speech])).toEqual([
      [
        0,
        5,
        [
          [1, 3],
          [4, 5],
        ],
      ],
      [10, 20, [[10, 12]]],
    ]);
  });
});

describe('loudness (docs/design/post-audio.md#loudness)', () => {
  const log = `[Parsed_loudnorm_0 @ 0x55]
{
	"input_i" : "-27.61",
	"input_tp" : "-4.47",
	"input_lra" : "18.06",
	"input_thresh" : "-39.20",
	"output_i" : "-14.02",
	"output_tp" : "-1.10",
	"output_lra" : "17.80",
	"output_thresh" : "-25.60",
	"normalization_type" : "linear",
	"target_offset" : "0.02"
}`;
  it('reads loudnorm statistics and builds the measuring and the linear pass', () => {
    const m = parseLoudnorm(log)!;
    expect(m).toMatchObject({
      inputI: -27.61,
      inputTp: -4.47,
      outputI: -14.02,
      type: 'linear',
      targetOffset: 0.02,
    });
    expect(parseLoudnorm('no stats here')).toBeNull();
    expect(parseLoudnorm(log.replace('"-27.61"', '"-inf"'))!.inputI).toBe(Number.NEGATIVE_INFINITY);
    expect(loudnormFilter('streaming')).toBe('loudnorm=I=-14:TP=-1:LRA=20:print_format=json');
    expect(loudnormFilter('broadcast', m)).toBe(
      'loudnorm=I=-23:TP=-1:LRA=20:measured_I=-27.61:measured_TP=-4.47:measured_LRA=18.06:measured_thresh=-39.2:offset=0.02:linear=true:print_format=json',
    );
  });
});

describe('score (docs/design/post-audio.md#score-one-cue-per-scene)', () => {
  function sceneCut() {
    const base = emptyTimeline({ fps: 24, width: 320, height: 180 });
    const clips = {
      clp_scene1aaaaa: { sceneId: 'scn_one0000001' },
      clp_scene1bbbbb: { sceneId: 'scn_one0000001' },
      clp_scene2aaaaa: { sceneId: 'scn_two0000001' },
      clp_scene3aaaaa: { sceneId: 'scn_three000001' },
    };
    const take = (clipId: string, out: number) => ({
      op: 'insert' as const,
      trackId: primaryTrack(base).id,
      item: {
        kind: 'video' as const,
        source: {
          type: 'take' as const,
          clipId,
          shotId: 'sht_0000000001',
          takeId: 'tak_0000000001',
          media: f.media({ durationSec: 20 }),
        },
        in: 0,
        out,
      },
    });
    const t = applyOps(base, [
      take('clp_scene1aaaaa', 8),
      take('clp_scene1bbbbb', 6),
      {
        op: 'insert',
        trackId: primaryTrack(base).id,
        item: {
          kind: 'video',
          source: { type: 'media', media: f.media({ durationSec: 20 }) },
          in: 0,
          out: 3,
        },
      },
      take('clp_scene2aaaaa', 10),
      take('clp_scene3aaaaa', 2),
    ]);
    return { t, clips };
  }

  it('groups the cut by scene, joins inserts to the cue before them and short cues to a neighbour', () => {
    const { t, clips } = sceneCut();
    expect(scoreCues(t, clips, { minSec: 1 }).map((c) => [c.sceneId, c.start, c.end])).toEqual([
      ['scn_one0000001', 0, 17],
      ['scn_two0000001', 17, 27],
      ['scn_three000001', 27, 29],
    ]);
    // a 2 s scene is shorter than the model's minimum: it joins the scene before
    const cues = scoreCues(t, clips, { minSec: 5 });
    expect(cues.map((c) => [c.index, c.sceneId, c.start, c.end])).toEqual([
      [0, 'scn_one0000001', 0, 17],
      [1, 'scn_two0000001', 17, 29],
    ]);
    expect(cueLength(cues, 0)).toBe(17 + CUE_OVERLAP_SEC);
    expect(cueLength(cues, 1)).toBe(12);
    // a footage cut is one cue
    const footage = applyOps(emptyTimeline({ fps: 24, width: 320, height: 180 }), [
      {
        op: 'insert',
        trackId: 'trk_primaryvideo01',
        item: {
          kind: 'video',
          source: { type: 'media', media: f.media({ durationSec: 20 }) },
          in: 0,
          out: 9,
        },
      },
    ]);
    expect(scoreCues(footage, {}, { minSec: 5 })).toEqual([{ index: 0, sceneId: null, start: 0, end: 9 }]);
  });

  it('lays cues from their scenes with crossfades, repeating a short cue like a bed', () => {
    const { t, clips } = sceneCut();
    const cues = scoreCues(t, clips, { minSec: 5 });
    let n = 0;
    const items = scoreItems(
      cues,
      [
        { media: f.media({ durationSec: 19 }), resourceId: 'res_cue1000001' },
        { media: f.media({ durationSec: 8 }), resourceId: 'res_cue2000001' },
      ],
      () => `itm_cue${String(++n).padStart(7, '0')}`,
    );
    expect(items.map((i) => [i.label, i.start, i.out, i.fadeIn, i.fadeOut])).toEqual([
      ['Cue 1', 0, 19, 2, 2],
      ['Cue 2', 17, 8, 2, undefined],
      ['Cue 2', 25, 4, undefined, 1.333],
    ]);
    expect(items.every((i) => i.volume === 0.5)).toBe(true);
  });
});

describe('effects (docs/design/post-audio.md#effects-from-action-lines)', () => {
  const item: VideoItem = {
    id: 'itm_shot000001',
    kind: 'video',
    source: { type: 'media', media: f.media({ durationSec: 20 }) },
    start: 10,
    in: 1,
    out: 7,
    speed: 1,
    volume: 1,
  };
  let n = 0;
  const id = () => `itm_fx${String(++n).padStart(8, '0')}`;

  it('places a spot at its moment in the take, inside the item', () => {
    const spot = { at: 3, durationSec: 2, kind: 'spot' as const, description: 'a door slams' };
    expect(effectLength(item, spot)).toBe(2);
    const [fx] = effectItems(
      item,
      spot,
      { media: f.media({ durationSec: 2 }), resourceId: 'res_fx00000001' },
      id,
    );
    expect(fx).toMatchObject({ start: 12, in: 0, out: 2, volume: 0.8, label: 'SFX: a door slams' });
    // too late for the item: moved earlier so it ends with it
    const late = effectItems(
      item,
      { ...spot, at: 6.5 },
      { media: f.media({ durationSec: 2 }), resourceId: 'r' },
      id,
    );
    expect(late[0]!.start).toBe(14);
    // before the item's in point: at its start
    expect(
      effectItems(item, { ...spot, at: 0 }, { media: f.media({ durationSec: 2 }), resourceId: 'r' }, id)[0]!
        .start,
    ).toBe(10);
  });

  it('lays an ambience under the whole item, repeated when shorter', () => {
    const amb = { at: 0, durationSec: 6, kind: 'ambience' as const, description: 'wind' };
    expect(effectLength(item, amb)).toBe(6);
    const pieces = effectItems(item, amb, { media: f.media({ durationSec: 4 }), resourceId: 'r' }, id);
    expect(pieces.map((p) => [p.start, p.out, p.volume])).toEqual([
      [10, 4, SFX_AMBIENCE_VOLUME],
      [14, 2, SFX_AMBIENCE_VOLUME],
    ]);
  });
});
