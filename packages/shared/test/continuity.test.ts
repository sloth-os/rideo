import { describe, expect, it } from 'vitest';
import {
  absentCast,
  aggregateQuality,
  attemptDone,
  BASE_NEGATIVE,
  BASE_NEGATIVE_V2,
  betterAttempt,
  boardPromptHash,
  compactIdentity,
  compileKeyframeRequest,
  compileMultiShotRequest,
  compileShotPrompt,
  compileVideoRequest,
  countWords,
  DIALOGUE_LEVELS,
  dialogueDirection,
  fitDialogue,
  framedGroupJoins,
  heardShares,
  inFrameLine,
  LINE_HEARD_RATIO,
  NEGATIVE_PROMPT_MAX,
  negativePromptFor,
  ProjectSettingsSchema,
  parseSceneScores,
  plannedShotRange,
  planShotGroups,
  referenceLabels,
  type ShotContext,
  SoundCheckOutputSchema,
  sceneLine,
  selectReferences,
  shotContextOf,
  soundVerdict,
  TEMPORAL_JUMP_SCORE,
  temporalVerdict,
  voicePhrase,
  WORDS_PER_SECOND,
  withSound,
  wordsCapacity,
  wordsOf,
} from '../src';
import * as f from '../src/testing/fixtures';

const v1 = ProjectSettingsSchema.parse({ resolution: { width: 320, height: 180 } });
const v2 = ProjectSettingsSchema.parse({
  resolution: { width: 320, height: 180 },
  generation: { promptVersion: 2, includeAudio: true },
});

function ctxV2(overrides: Partial<ShotContext> = {}): ShotContext {
  const mira = f.character();
  const shot = f.shot({
    characterIds: [mira.id],
    dialogue: [{ characterId: mira.id, line: 'Look at the mountain!' }],
  });
  return {
    shot,
    characters: [mira],
    elements: [],
    screenplay: f.screenplay(),
    settings: v2,
    scene: {
      heading: 'EXT. SLOPE - DAY',
      location: 'Snowy slope',
      timeOfDay: 'late afternoon',
      continuity: 'clear sky, sun low on the left',
    },
    previousEndState: 'Mira stands at the top, poles planted',
    ...overrides,
  };
}

describe('prompt version 2 (docs/design/continuity.md#prompts-version-2)', () => {
  it('leaves version 1 prompts exactly as they were', () => {
    const ctx = { ...ctxV2(), settings: v1 };
    const p = compileShotPrompt(ctx, 'video');
    expect(p).not.toContain('Scene:');
    expect(p).not.toContain('One continuous shot');
    expect(p).not.toContain('Physics:');
    expect(p).toContain('camera style: slow, deliberate');
    expect(compileVideoRequest(ctx, { referenceUris: [], attempt: 0 }).parameters?.negative_prompt).toBe(
      BASE_NEGATIVE,
    );
  });

  it('writes the video prompt as blocks: scene, shot, camera, cast, dialogue with voices, sound, physics, exclusions', () => {
    const ctx = ctxV2();
    ctx.shot.camera = { framing: 'wide', movement: 'tracking', lensMm: 24 };
    const p = compileShotPrompt(ctx, 'video');
    const order = [
      'One continuous shot, no cuts. Cinematic shot',
      'Scene: Snowy slope, late afternoon; clear sky, sun low on the left.',
      'Mira climbs the lighthouse stairs.',
      'Action: She climbs, breathing hard.',
      'Camera: wide shot, tracking shot; 24mm lens.',
      'Characters (keep identities exactly as in the first frame and the reference images): Mira:',
      'Dialogue: Mira says, in a',
      ': "Look at the mountain!" Lip sync.',
      "Sound: the characters' voices and the ambient and action sounds of the place. No BGM, no music, no song, no humming.",
      'Physics:',
      'Avoid:',
    ];
    let at = -1;
    for (const part of order) {
      const i = p.indexOf(part);
      expect(i, part).toBeGreaterThan(at);
      at = i;
    }
    // Nothing the model could play as another shot (docs/design/continuity.md#what-the-video-model-reads): no list
    // of camera styles, no previous shot's end state
    expect(p).not.toContain('camera style');
    expect(p).not.toContain('Continues from the previous shot');
    expect(p).not.toContain('Mira stands at the top');
    // The compact identity says who is who without the face (the first frame shows it).
    expect(p).not.toContain('face: oval face');
    expect(compileShotPrompt(ctx, 'keyframe')).toContain('face: oval face');
    // Deterministic (rule R3).
    expect(compileShotPrompt(structuredClone(ctx), 'video')).toBe(p);
  });

  it('says No dialogue when a voiced shot has no lines, and nothing about sound when none is rendered', () => {
    const silent = ctxV2();
    silent.shot.dialogue = [];
    expect(compileShotPrompt(silent, 'video')).toContain('No dialogue.');
    const mute = { ...silent, settings: ProjectSettingsSchema.parse({ generation: { promptVersion: 2 } }) };
    const p = compileShotPrompt(mute, 'video');
    expect(p).not.toContain('No dialogue.');
    expect(p).not.toContain('Sound:');
    const music = {
      ...silent,
      settings: ProjectSettingsSchema.parse({
        generation: { promptVersion: 2, includeAudio: true, modelMusic: true },
      }),
    };
    expect(compileShotPrompt(music, 'video')).toContain(
      'Sound: natural ambient sound of the place and the action.',
    );
  });

  it('names each voice in the same words every time', () => {
    const mira = f.character();
    expect(voicePhrase(mira)).toBe('an early 30s woman voice');
    mira.voice = { ...mira.voice!, description: 'warm, bright young voice' } as typeof mira.voice;
    expect(voicePhrase(mira as never)).toBe('a warm, bright young voice');
    expect(compactIdentity(f.character())).toBe(
      'Mira: early 30s woman, East Asian, slender athletic build; wearing charcoal field jacket over a white t-shirt.',
    );
  });

  it('keyframes carry the scene line, the continuation, the scene reference phrase and exclusions', () => {
    const ctx = ctxV2({ sceneReference: true });
    const p = compileShotPrompt(ctx, 'keyframe');
    expect(p).toContain('Scene: Snowy slope, late afternoon');
    expect(p).toContain('Continues from the previous shot:');
    expect(p).toContain('The last image is the scene reference');
    expect(p).toContain('Avoid: extra or missing limbs');
    expect(p).not.toContain('Dialogue:');
    // A continuous shot starts from the last frame: no continuation sentence.
    const cont = ctxV2();
    cont.shot.continuity = 'continuous';
    expect(compileShotPrompt(cont, 'video')).not.toContain('Continues from the previous shot');
  });

  it('adds motion artefacts to the negative prompt within 500 characters', () => {
    const ctx = ctxV2();
    expect(negativePromptFor(ctx)).toBe(BASE_NEGATIVE_V2);
    ctx.shot.negativePrompt = 'x'.repeat(800);
    const long = negativePromptFor(ctx);
    expect(long.length).toBeLessThanOrEqual(NEGATIVE_PROMPT_MAX);
    expect(long.startsWith(BASE_NEGATIVE)).toBe(true);
    const req = compileKeyframeRequest(ctxV2(), { referenceUris: [], attempt: 0 });
    expect(req.parameters?.negative_prompt).toBe(BASE_NEGATIVE_V2);
  });

  it('turns the provider’s prompt rewriting off for version 2 unless the project asks for it', () => {
    const ctx = ctxV2();
    expect(compileVideoRequest(ctx, { referenceUris: [], attempt: 0 }).parameters?.enhance_prompt).toBe(
      false,
    );
    const on = {
      ...ctx,
      settings: { ...ctx.settings, generation: { ...ctx.settings.generation, enhancePrompt: true } },
    };
    expect(compileVideoRequest(on, { referenceUris: [], attempt: 0 }).parameters?.enhance_prompt).toBe(true);
    // Version 1 keeps the provider's default
    expect(
      compileVideoRequest({ ...ctx, settings: v1 }, { referenceUris: [], attempt: 0 }).parameters,
    ).not.toHaveProperty('enhance_prompt');
  });

  it('shapes the request by the model’s limits: a frame without references, no negative prompt field', () => {
    const ctx = ctxV2();
    const wan3 = { exclusive_frames_and_references: true, supports_negative_prompt: false };
    const framed = compileVideoRequest(ctx, {
      firstFrameUri: 'data:image/png;base64,AA',
      referenceUris: ['data:image/png;base64,BB'],
      attempt: 0,
      limits: wan3,
    });
    expect(framed.input.map((p) => (p.type === 'text' ? 'text' : p.role))).toEqual(['text', 'first_frame']);
    expect(framed.parameters).not.toHaveProperty('negative_prompt');
    // Without a frame the references go; other models keep both and the negative prompt
    const referenced = compileVideoRequest(ctx, {
      referenceUris: ['data:image/png;base64,BB'],
      attempt: 0,
      limits: wan3,
    });
    expect(referenced.input.map((p) => (p.type === 'text' ? 'text' : p.role))).toEqual([
      'text',
      'reference_image',
    ]);
    const other = compileVideoRequest(ctx, {
      firstFrameUri: 'data:image/png;base64,AA',
      referenceUris: ['data:image/png;base64,BB'],
      attempt: 0,
      limits: {},
    });
    expect(other.input).toHaveLength(3);
    expect(other.parameters?.negative_prompt).toBeTruthy();
  });

  it('plans shots within the model’s range, capped at 10 s, and holds a static camera in Wan’s words', () => {
    expect(plannedShotRange({ min_duration_seconds: 2, max_duration_seconds: 30 })).toEqual({
      min: 2,
      max: 10,
    });
    expect(plannedShotRange({ min_duration_seconds: 5, max_duration_seconds: 5 })).toEqual({
      min: 5,
      max: 5,
    });
    expect(plannedShotRange(null)).toEqual({ min: 4, max: 10 });
    const ctx = ctxV2();
    ctx.shot.camera = { framing: 'insert', movement: 'static' };
    expect(compileShotPrompt(ctx, 'video')).toContain(
      'Camera: insert shot, fixed shot, camera static, position unchanged.',
    );
  });

  it('builds the scene line from the scene, falling back to the location element and the heading', () => {
    expect(sceneLine(null, undefined)).toBeNull();
    expect(
      sceneLine(
        { heading: 'EXT. PEAK - DAWN', location: '', timeOfDay: '', continuity: '' },
        { name: 'Summit' },
      ),
    ).toBe('Scene: Summit.');
    expect(
      sceneLine({ heading: 'EXT. PEAK - DAWN', location: '', timeOfDay: 'dawn', continuity: '' }, undefined),
    ).toBe('Scene: EXT. PEAK - DAWN, dawn.');
  });

  it('gives storyboard frames and the server the same context, without the scene reference in the hash', () => {
    const mira = f.character();
    const a = f.shot({ index: 0, endState: 'Mira waves from the lift' });
    const b = f.shot({ index: 1, characterIds: [mira.id] });
    const scene = { ...f.screenplay().scenes[0], id: 'scn_0000000000aaaaaa' } as never;
    const sp = f.screenplay({
      scenes: [
        {
          id: 'scn_0000000000aaaaaa',
          index: 0,
          beatId: null,
          heading: 'EXT. SLOPE - DAY',
          location: 'Slope',
          timeOfDay: 'noon',
          summary: '',
          action: '',
          dialogue: [],
          characterIds: [],
          locationId: null,
          elementIds: [],
          estDurationSec: 10,
          continuity: 'bright sun',
        },
      ],
    });
    void scene;
    const clip = f.clip({ sceneId: 'scn_0000000000aaaaaa', shots: [a, b] });
    const docs = f.docs({
      project: f.project({ settings: v2 }),
      screenplay: sp,
      characters: { [mira.id]: mira },
      clips: { [clip.id]: clip },
    });
    const ctx = shotContextOf(b, docs);
    expect(ctx.scene?.continuity).toBe('bright sun');
    expect(ctx.previousEndState).toBe('Mira waves from the lift');
    expect(boardPromptHash({ ...ctx, sceneReference: true })).toBe(boardPromptHash(ctx));
    // Moving frames changes the previous shot: the board stays current.
    expect(boardPromptHash({ ...ctx, previousEndState: 'someone else' })).toBe(boardPromptHash(ctx));
    // Version 1 projects keep their contexts (and their board hashes).
    const old = shotContextOf(b, { ...docs, project: f.project({ settings: v1 }) });
    expect(old.scene).toBeUndefined();
  });

  it('says who is in frame when a shot shows only part of its clip’s cast, without it in the board hash', () => {
    const rosie = f.character({ name: 'Rosie' });
    const sammy = f.character({ name: 'Sammy' });
    const both = f.shot({ index: 0, characterIds: [sammy.id, rosie.id] });
    const single = f.shot({ index: 1, characterIds: [rosie.id], description: 'Rosie points at the chart' });
    const insert = f.shot({ index: 2, characterIds: [], description: 'The size chart' });
    const clip = f.clip({ shots: [both, single, insert] });
    const docs = f.docs({
      project: f.project({ settings: v2 }),
      characters: { [rosie.id]: rosie, [sammy.id]: sammy },
      clips: { [clip.id]: clip },
    });
    const ctx = shotContextOf(single, docs);
    expect(ctx.offscreen).toEqual(['Sammy']);
    expect(inFrameLine(ctx)).toBe('In frame: only Rosie; Sammy is out of frame.');
    expect(compileShotPrompt(ctx, 'keyframe')).toContain('In frame: only Rosie; Sammy is out of frame.');
    // The video prompt names nobody who is not in the shot
    const video = compileShotPrompt(ctx, 'video');
    expect(video).toContain('In frame: only Rosie; nobody else.');
    expect(video).not.toContain('Sammy');
    expect(inFrameLine(shotContextOf(insert, docs))).toBe('No characters in frame.');
    expect(inFrameLine(shotContextOf(both, docs))).toBeNull();
    expect(compileShotPrompt(shotContextOf(both, docs), 'keyframe')).not.toContain('In frame');
    expect(inFrameLine({ characters: [rosie], offscreen: ['Sammy', 'Mei', 'Bao'] })).toBe(
      'In frame: only Rosie; Sammy, Mei and Bao are out of frame.',
    );
    // A neighbour that changes its cast does not make this board outdated
    expect(boardPromptHash({ ...ctx, offscreen: [] })).toBe(boardPromptHash(ctx));
    // Multi-shot segments say it too
    const req = compileMultiShotRequest([shotContextOf(both, docs), ctx], {
      referenceUris: [],
      attempt: 0,
    });
    // Wan 3.0's labels: each shot's time in the sequence, a hard cut between shots
    const text = (req.input[0] as { text: string }).text;
    expect(text).toContain('Shot 1 [0-5s]: Mira climbs');
    expect(text).toContain('No dialogue. Hard cut. Shot 2 [5-10s]: Rosie points at the chart. Action:');
    expect(text).not.toMatch(/Hard cut\.\s*Characters/);
    expect((req.input[0] as { text: string }).text).toContain('In frame: only Rosie; nobody else.');
  });

  it('keeps the scene’s continuity out of the video prompt of a shot without the whole cast', () => {
    const ctx = ctxV2({ offscreen: ['Sammy'] });
    ctx.scene = { ...ctx.scene!, continuity: 'Sammy wears his blue jacket; Mira wears her red one' };
    const video = compileShotPrompt(ctx, 'video');
    expect(video).toContain('Scene: Snowy slope, late afternoon.');
    expect(video).not.toContain('Sammy');
    const keyframe = compileShotPrompt(ctx, 'keyframe');
    expect(keyframe).toContain('Scene: Snowy slope, late afternoon; Sammy wears his blue jacket');
    expect(keyframe).toContain('Continues from the previous shot: Mira stands at the top, poles planted.');
  });

  it('keeps multi-shot segments free of the no-cut line', () => {
    const ctx = ctxV2();
    const req = compileMultiShotRequest(
      [ctx, { ...ctx, shot: { ...ctx.shot, id: 'sht_0000000000bbbbbb', index: 1 } }],
      {
        referenceUris: [],
        attempt: 0,
      },
    );
    const text = (req.input[0] as { text: string }).text;
    expect(text).toContain('A multi-shot sequence of 2 shots');
    expect(text).not.toContain('One continuous shot');
    expect(text).toContain('Physics:');
    expect(req.parameters?.negative_prompt).not.toContain('jump cut');
  });
});

describe('dialogue that fits its shot (docs/design/continuity.md#shot-planning)', () => {
  it('counts words and capacity', () => {
    expect(countWords("Let's go — slow down, Rosie!")).toBe(5);
    expect(countWords('...')).toBe(0);
    expect(wordsCapacity(5)).toBe(Math.floor(5 * WORDS_PER_SECOND));
  });

  it('lengthens a shot within the model, then moves lines to continuous shots, never cutting a line', () => {
    const shot = (lines: string[], durationSec = 4) => ({
      durationSec,
      continuity: 'cut' as const,
      dialogue: lines.map((line) => ({ character: 'Mira', line })),
      description: 'd',
    });
    // 10 words need 4.5 s: lengthened from 4 to 4.6 within a 10 s maximum.
    const [one] = fitDialogue([shot(['one two three four five six seven eight nine ten'])], {
      minSec: 2,
      maxSec: 10,
    });
    expect(one!.durationSec).toBeCloseTo(4.6, 5);
    // Fixed 5 s shots: two 8-word lines go to two shots, the second continuous.
    const out = fitDialogue([shot(['a b c d e f g h', 'i j k l m n o p'], 5)], { minSec: 5, maxSec: 5 });
    expect(out).toHaveLength(2);
    expect(out[1]!.continuity).toBe('continuous');
    expect(out.map((s) => s.dialogue[0]!.line)).toEqual(['a b c d e f g h', 'i j k l m n o p']);
    expect(out.every((s) => s.durationSec === 5)).toBe(true);
    // A single line longer than any shot keeps a shot of its own at the maximum.
    const long = fitDialogue([shot(['w '.repeat(20).trim()], 5)], { minSec: 5, maxSec: 5 });
    expect(long).toHaveLength(1);
    expect(long[0]!.dialogue[0]!.line.split(' ')).toHaveLength(20);
  });

  it('turns a CEFR level into guidance and the longest line', () => {
    expect(dialogueDirection('any', 5)).toEqual({ maxWordsPerLine: 11 });
    const b1 = dialogueDirection('B1', 5);
    expect(b1.dialogueLevel).toBe('B1');
    expect(b1.dialogueGuidance).toBe(DIALOGUE_LEVELS.B1.guidance);
    expect(b1.maxWordsPerLine).toBe(11);
    expect(dialogueDirection('A1', 10).maxWordsPerLine).toBe(6);
  });
});

describe('quality checks (docs/design/continuity.md#quality-checks-in-the-gate)', () => {
  it('parses scene scores and finds jumps', () => {
    const log = [
      '[Parsed_metadata_2 @ 0x1] frame:0    pts:5120    pts_time:0.333333',
      '[Parsed_metadata_2 @ 0x1] lavfi.scene_score=0.572561',
      '[Parsed_metadata_2 @ 0x1] frame:1    pts:9000    pts_time:2.1',
      '[Parsed_metadata_2 @ 0x1] lavfi.scene_score=0.3',
    ].join('\n');
    const scores = parseSceneScores(log);
    expect(scores).toEqual([
      { t: 0.333333, score: 0.572561 },
      { t: 2.1, score: 0.3 },
    ]);
    expect(temporalVerdict(scores)).toEqual({ jumps: [0.33], maxScore: 0.573 });
    expect(temporalVerdict([{ t: 1, score: TEMPORAL_JUMP_SCORE - 0.01 }]).jumps).toEqual([]);
    expect(temporalVerdict([])).toEqual({ jumps: [], maxScore: 0 });
  });

  it('aggregates physics (lowest), continuity (mean) and temporal into a verdict', () => {
    const q = aggregateQuality({
      frames: [
        { physics: { score: 0.9 }, continuity: { score: 0.8 } },
        {
          physics: { score: 0.3, issues: ['the ski passes through the leg'] },
          continuity: { score: 0.4, issues: ['night instead of day'] },
        },
      ],
      temporal: { jumps: [], maxScore: 0.1 },
      threshold: 0.5,
    });
    expect(q.physics).toBe(0.3);
    expect(q.continuity).toBe(0.6);
    expect(q.passed).toBe(false);
    expect(q.issues).toEqual(['the ski passes through the leg', 'continuity: night instead of day']);
    const jump = aggregateQuality({ frames: [], temporal: { jumps: [1.2], maxScore: 0.6 }, threshold: 0.5 });
    expect(jump.passed).toBe(false);
    expect(jump.physics).toBeNull();
    expect(jump.issues[0]).toBe('the shot jumps at 1.2 s');
    expect(aggregateQuality({ frames: [], temporal: null, threshold: 0.5 }).passed).toBe(true);
  });

  it('ranks attempts: identity, then quality, then score', () => {
    const passedOk = { status: 'passed' as const, score: 0.8, quality: { passed: true } as never };
    const passedBad = { status: 'passed' as const, score: 0.95, quality: { passed: false } as never };
    const failed = { status: 'failed' as const, score: 0.99, quality: null };
    expect(betterAttempt(passedBad, null)).toBe(true);
    expect(betterAttempt(passedOk, passedBad)).toBe(true);
    expect(betterAttempt(failed, passedBad)).toBe(false);
    expect(betterAttempt({ ...passedOk, score: 0.9 }, passedOk)).toBe(true);
    expect(attemptDone(passedOk)).toBe(true);
    expect(attemptDone(passedBad)).toBe(false);
    expect(attemptDone({ status: 'unverified', quality: null })).toBe(true);
    expect(attemptDone(failed)).toBe(false);
  });
});

describe('the sound check (docs/design/continuity.md#quality-checks-in-the-gate)', () => {
  const heard = (over: object) => SoundCheckOutputSchema.parse({ speech: [], ...over });
  const lines = [
    { character: 'Rosie', line: 'Look at the mountain, Sammy!' },
    { character: 'Sammy', line: 'It’s so big and white.' },
  ];

  it('compares words, not spelling, and counts a heard word for one line only', () => {
    expect(wordsOf('It’s so BIG, and white!')).toEqual(["it's", 'so', 'big', 'and', 'white']);
    expect(heardShares(['so big', 'so big'], 'so big')).toEqual([1, 0]);
    expect(heardShares(['so big', 'so big'], 'so big so big')).toEqual([1, 1]);
    expect(heardShares(['Look at the mountain, Sammy!'], 'look at the mountains sammy')).toEqual([0.8]);
    expect(heardShares(['...'], '')).toEqual([1]);
  });

  it('reads an answer given as a list: the whole answer as its only item, or just the utterances', () => {
    expect(SoundCheckOutputSchema.parse([{ speech: [{ text: 'Hi' }], music: true }])).toMatchObject({
      speech: [{ text: 'Hi' }],
      music: true,
    });
    expect(
      SoundCheckOutputSchema.parse([
        { text: 'Look at the mountain', speaker: 'Rosie' },
        { text: 'So big', speaker: 'Sammy' },
      ]),
    ).toMatchObject({ speech: [{ speaker: 'Rosie' }, { speaker: 'Sammy' }], music: false, issues: [] });
    expect(SoundCheckOutputSchema.parse([])).toMatchObject({ speech: [] });
  });

  it('passes when every line is heard and says who spoke it', () => {
    const v = soundVerdict({
      lines,
      heard: heard({
        speech: [
          { text: 'Look at the mountain, Sammy!', speaker: 'Rosie', lipSync: 0.9 },
          { text: "It's so big and white", speaker: 'sammy', lipSync: 0.8 },
        ],
        score: 0.85,
      }),
      musicAllowed: false,
      cast: ['Rosie', 'Sammy'],
    });
    expect(v.passed).toBe(true);
    expect(v.issues).toEqual([]);
    expect(v.sound).toMatchObject({
      lines: [
        { character: 'Rosie', heard: 1, speaker: 'Rosie' },
        { character: 'Sammy', heard: 1, speaker: 'Sammy' },
      ],
      transcript: "Rosie: Look at the mountain, Sammy! sammy: It's so big and white",
      music: false,
      unexpectedSpeech: false,
      score: 0.85,
    });
  });

  it('fails on a line that is not heard and reports what else is wrong', () => {
    const v = soundVerdict({
      lines,
      heard: heard({
        speech: [{ text: 'Look at the mountain, Sammy!', speaker: 'Sammy', lipSync: 0.2 }],
        music: 'true',
        score: 0.3,
        issues: ['an echo'],
      }),
      musicAllowed: false,
      cast: ['Rosie', 'Sammy'],
    });
    expect(v.passed).toBe(false);
    expect(v.sound.lines.map((l) => l.heard)).toEqual([1, 0]);
    expect(v.issues).toEqual([
      'Rosie’s line is spoken in Sammy’s voice',
      'Sammy’s line is not heard (0% of its words): “It’s so big and white.”',
      'music plays in the take (the film’s score is added later)',
      'the lips are out of sync with the voices',
      'poor sound (0.30)',
      'sound: an echo',
    ]);
    expect(LINE_HEARD_RATIO).toBe(0.6);
  });

  it('reports speech in a shot without lines and allows music when the film wants it', () => {
    const v = soundVerdict({
      lines: [],
      heard: heard({ speech: [{ text: 'hello there friend' }], music: true }),
      musicAllowed: true,
      cast: [],
    });
    expect(v.passed).toBe(true);
    expect(v.sound.unexpectedSpeech).toBe(true);
    expect(v.issues).toEqual(['speech in a shot without lines: “hello there friend”']);
  });

  it('fails a frame with a cast member who is not in the shot, and reports other figures', () => {
    const q = aggregateQuality({
      frames: [
        { physics: { score: 0.9 }, extras: ['Sammy'] },
        { physics: { score: 0.8 }, extras: ['Sammy'], others: ['a fox in the background'] },
      ],
      temporal: null,
      threshold: 0.5,
    });
    expect(q).toMatchObject({ passed: false, physics: 0.8, extras: ['Sammy'] });
    expect(q.issues).toEqual([
      'Sammy is in the frame, though the shot is not theirs',
      'another figure in the frame: a fox in the background',
    ]);
    const others = aggregateQuality({
      frames: [{ physics: { score: 0.9 }, others: ['a bird'] }],
      temporal: null,
      threshold: 0.5,
    });
    expect(others).toMatchObject({ passed: true, extras: [], others: ['a bird'] });
    // A film with only its cast: the bird fails the take (docs/design/continuity.md#quality-checks-in-the-gate)
    const castOnly = aggregateQuality({
      frames: [{ physics: { score: 0.9 }, others: ['a bird'] }],
      temporal: null,
      threshold: 0.5,
      castOnly: true,
    });
    expect(castOnly).toMatchObject({ passed: false, others: ['a bird'] });
    expect(castOnly.issues).toEqual(['another figure in the frame (the film has only its cast): a bird']);
    const sammy = f.character({ name: 'Sammy' });
    expect(absentCast(['Sammy', 'Nobody'], { [sammy.id]: sammy })).toEqual([
      { name: 'Sammy', look: compactIdentity(sammy) },
    ]);
    expect(absentCast(undefined, {})).toEqual([]);
  });

  it('merges into the quality verdict: the take passes only when the sound check passes', () => {
    const quality = aggregateQuality({
      frames: [{ physics: { score: 0.9 } }],
      temporal: null,
      threshold: 0.5,
    });
    const failed = soundVerdict({ lines, heard: heard({}), musicAllowed: false, cast: [] });
    const merged = withSound(quality, failed);
    expect(merged).toMatchObject({
      passed: false,
      physics: 0.9,
      sound: { lines: [{ heard: 0 }, { heard: 0 }] },
    });
    expect(merged.issues).toHaveLength(2);
    expect(
      withSound(null, soundVerdict({ lines: [], heard: heard({}), musicAllowed: false, cast: [] })),
    ).toMatchObject({
      passed: true,
      temporal: null,
      physics: null,
      sound: { lines: [], unexpectedSpeech: false },
    });
  });

  it('groups a framed sequence only with the first frame’s cast and shots of at most 5 s', () => {
    const rosie = 'chr_0000000000rosie0';
    const sammy = 'chr_0000000000sammy0';
    const shot = (index: number, characterIds: string[], durationSec = 4) => ({
      id: `s${index}`,
      index,
      durationSec,
      continuity: 'cut' as const,
      characterIds,
    });
    const shots = [
      shot(0, [rosie, sammy]),
      shot(1, [rosie]),
      shot(2, [sammy]),
      shot(3, [rosie], 8), // too long for a segment
      shot(4, [rosie]),
      shot(5, [sammy]), // not in shot 4's frame
    ];
    const groups = planShotGroups(shots, {
      maxShots: 8,
      maxDurationSec: 30,
      eligible: () => true,
      joins: framedGroupJoins,
    });
    expect(groups).toEqual([['s0', 's1', 's2'], ['s3'], ['s4'], ['s5']]);
    // Without the rule the cast does not matter
    expect(planShotGroups(shots, { maxShots: 8, maxDurationSec: 40, eligible: () => true })).toEqual([
      ['s0', 's1', 's2', 's3', 's4', 's5'],
    ]);
  });

  it('names each reference image of a keyframe, without it in the board hash', () => {
    const rosie = f.character({ name: 'Rosie' });
    const sammy = f.character({ name: 'Sammy' });
    const slope = f.element({ name: 'Beginner Slope', kind: 'location' });
    const shot = f.shot({ characterIds: [rosie.id, sammy.id] });
    const selection = selectReferences([rosie, sammy], shot, 10, 2, [slope]);
    const labels = referenceLabels(selection, [rosie, sammy], [slope]);
    expect(labels[0]).toMatch(/^Rosie \(.+ view\)$/);
    expect(labels).toContain('Beginner Slope, the place');
    // A cast sheet when the cast outnumbers the slots
    const tight = selectReferences([rosie, sammy], shot, 1, 2, []);
    expect(referenceLabels(tight, [rosie, sammy], [])).toEqual(['a cast sheet of Rosie, Sammy']);
    const ctx = ctxV2({
      referenceLabels: ['Rosie (front view)', 'Beginner Slope, the place'],
      sceneReference: true,
    });
    const p = compileShotPrompt(ctx, 'keyframe');
    expect(p).toContain('Reference images, in order: 1 Rosie (front view); 2 Beginner Slope, the place.');
    expect(p.indexOf('Reference images, in order')).toBeLessThan(
      p.indexOf('The last image is the scene reference'),
    );
    expect(compileShotPrompt(ctx, 'video')).not.toContain('Reference images, in order');
    expect(boardPromptHash(ctx)).toBe(boardPromptHash({ ...ctx, referenceLabels: [] }));
  });
});
