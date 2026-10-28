import { describe, expect, it } from 'vitest';
import {
  addUsage,
  applyOps,
  assembleFeedback,
  castIdsOf,
  cutPoints,
  dialogueDelivery,
  emptyTimeline,
  emptyUsage,
  FeedbackRecommendationSchema,
  type FeedbackSceneOutput,
  FeedbackSchema,
  type FeedbackSignals,
  FeedbackSignalsSchema,
  feedbackIdFor,
  feedbackMarkdown,
  fixEstimate,
  fixOutcome,
  framingRuns,
  meanAttempts,
  mergeSceneOutputs,
  overallScore,
  parsePrices,
  parseSignalLog,
  rushedLines,
  type SceneReview,
  type Shot,
  shotSpans,
  signalIssues,
  soundScore,
  TelemetryInputSchema,
  type Timeline,
  takePassesChecks,
  takeSignals,
  takeSwapOps,
  unexpectedCuts,
} from '../src';
import * as f from '../src/testing/fixtures';

/** A cut of two clips: C1 has three wide shots and a close-up, C2 one shot; 5 s each. */
function fixture() {
  const shots1 = [0, 1, 2, 3].map((i) =>
    f.readyShot([], {
      index: i,
      camera: { framing: i < 3 ? 'wide' : 'close_up', movement: 'static' },
      dialogue:
        i === 1
          ? [
              {
                characterId: null,
                line: 'one two three four five six seven eight nine ten eleven twelve thirteen',
              },
            ]
          : [],
    }),
  );
  const c1 = f.clip({ index: 0, title: 'The slope', shots: shots1 });
  const c2 = f.clip({ index: 1, title: 'The lodge', shots: [f.readyShot([], { index: 0 })] });
  const items = [...shots1.map((s) => ({ clip: c1, shot: s })), { clip: c2, shot: c2.shots[0]! }].map(
    ({ clip, shot }, k) => ({
      id: `itm_00000000000000${String(k).padStart(2, '0')}`,
      kind: 'video' as const,
      source: {
        type: 'take' as const,
        clipId: clip.id,
        shotId: shot.id,
        takeId: shot.selectedTakeId!,
        media: f.media(),
      },
      start: k * 5,
      in: 0,
      out: 5,
      speed: 1,
      ...(k === 4 ? { transitionIn: { type: 'crossfade' as const, duration: 0.5 } } : {}),
    }),
  );
  const timeline = {
    tracks: [{ id: 'trk_videotrack000001', kind: 'video', items }],
  } as unknown as Timeline;
  return { c1, c2, clips: { [c1.id]: c1, [c2.id]: c2 }, timeline };
}

describe('feedback signals (docs/design/feedback.md#how-a-film-is-watched)', () => {
  it('places every take of the cut in export time with its label', () => {
    const { clips, timeline } = fixture();
    const spans = shotSpans(timeline, clips);
    expect(spans.map((s) => s.label)).toEqual(['C1·S1', 'C1·S2', 'C1·S3', 'C1·S4', 'C2·S1']);
    expect(spans[4]).toMatchObject({ start: 20, end: 25 });
    expect(cutPoints(timeline)).toEqual([
      { at: 5, window: 0 },
      { at: 10, window: 0 },
      { at: 15, window: 0 },
      { at: 20, window: 0.5 },
    ]);
  });

  it('keeps scene changes away from the cuts as jumps inside shots', () => {
    const { timeline } = fixture();
    const changes = [
      { t: 5.02, score: 0.9 }, // the cut at 5 s
      { t: 7.4, score: 0.62 }, // inside C1·S2: a jump
      { t: 20.6, score: 0.7 }, // inside the crossfade window
      { t: 12, score: 0.3 }, // too weak
      { t: 24.9, score: 0.8 }, // at the very end
    ];
    expect(unexpectedCuts(changes, cutPoints(timeline), { durationSec: 25 })).toEqual([
      { at: 7.4, score: 0.62 },
    ]);
  });

  it('finds runs of the same framing and lines too long for their shot', () => {
    const { clips, timeline } = fixture();
    const spans = shotSpans(timeline, clips);
    expect(framingRuns(spans, clips)).toEqual([]);
    const four = shotSpans(timeline, clips).map((s) => s);
    const c = Object.values(clips)[0]!;
    c.shots[3]!.camera.framing = 'wide';
    expect(framingRuns(four, clips)).toMatchObject([{ framing: 'wide', count: 4, start: 0, end: 20 }]);
    expect(rushedLines(spans, clips)).toMatchObject([{ shot: 'C1·S2', words: 13, durationSec: 5 }]);
  });

  it('counts the takes of the cut by state and quality', () => {
    const { clips, timeline } = fixture();
    const c = Object.values(clips)[0]!;
    c.shots[0]!.takes[0]!.consistency.quality = {
      passed: false,
      temporal: null,
      physics: 0.2,
      continuity: null,
      extras: [],
      others: [],
      duplicates: [],
      sound: null,
      issues: [],
    };
    c.shots[1]!.takes[0]!.consistency.status = 'unverified';
    expect(takeSignals(shotSpans(timeline, clips), clips, {}, {})).toEqual({
      total: 5,
      passed: 4,
      failed: 0,
      unverified: 1,
      overridden: 0,
      stale: 0,
      qualityFailed: 1,
    });
  });

  it('scores sound from loudness, silences and rushed lines', () => {
    const base = FeedbackSignalsSchema.parse({ durationSec: 60 });
    expect(soundScore(base)).toBeNull();
    expect(
      soundScore({ ...base, loudness: { target: 'streaming', integratedLufs: -14.3, truePeakDb: -1.5 } }),
    ).toBe(10);
    expect(
      soundScore({
        ...base,
        loudness: { target: 'streaming', integratedLufs: -20, truePeakDb: -0.2 },
        silences: [{ start: 1, end: 5 }],
      }),
    ).toBe(10 - 4 - 1 - 0.5);
  });

  it('parses the signal pass: black, frozen, silences and scene scores', () => {
    const log = [
      '[blackdetect @ 0x1] black_start:12.5 black_end:14.25 black_duration:1.75',
      '[freezedetect @ 0x2] lavfi.freezedetect.freeze_start: 30.2',
      '[freezedetect @ 0x2] lavfi.freezedetect.freeze_duration: 2.1',
      '[freezedetect @ 0x2] lavfi.freezedetect.freeze_end: 32.3',
      '[Parsed_metadata_4 @ 0x3] frame:5 pts:120 pts_time:41.5',
      '[Parsed_metadata_4 @ 0x3] lavfi.scene_score=0.51',
      '[silencedetect @ 0x4] silence_start: 50',
      '[silencedetect @ 0x4] silence_end: 55.5 | silence_duration: 5.5',
      '[silencedetect @ 0x4] silence_start: 58',
    ].join('\n');
    expect(parseSignalLog(log, 60)).toEqual({
      black: [{ start: 12.5, end: 14.25 }],
      frozen: [{ start: 30.2, end: 32.3 }],
      silences: [
        { start: 50, end: 55.5 },
        { start: 58, end: 60 },
      ],
      changes: [{ t: 41.5, score: 0.51 }],
    });
  });

  it('raises issues from the signals, pinned to their shots', () => {
    const { clips, timeline } = fixture();
    const spans = shotSpans(timeline, clips);
    const signals: FeedbackSignals = {
      ...FeedbackSignalsSchema.parse({ durationSec: 25 }),
      black: [
        { start: 0, end: 0.5 },
        { start: 11, end: 13 },
      ],
      unexpectedCuts: [{ at: 7.4, score: 0.62 }],
    };
    const issues = signalIssues(signals, spans);
    expect(issues.map((i) => [i.dimension, i.severity, i.shot])).toEqual([
      ['editing', 'major', 'C1·S3'],
      ['temporal', 'major', 'C1·S2'],
    ]);
  });
});

describe('feedback assembly (docs/design/feedback.md#how-a-film-is-watched, step 5)', () => {
  const sceneOutput = (over: Partial<FeedbackSceneOutput> = {}): FeedbackSceneOutput => ({
    scores: {
      storytelling: 6,
      continuity: 7,
      character: 8,
      temporal: 6,
      physics: 5,
      realism: 7,
      cinematography: 7,
      editing: 6,
    },
    summary: 'A run down the slope.',
    strengths: ['bright light'],
    issues: [
      {
        shot: 1,
        dimension: 'physics',
        severity: 'major',
        title: 'Skis through the leg',
        detail: '',
        at: 0.5,
      },
      { dimension: 'storytelling', severity: 'minor', title: 'No turn', detail: '' },
    ],
    recommendations: [
      {
        shot: 1,
        dimension: 'physics',
        priority: 1,
        title: 'Regenerate C1·S2',
        detail: 'keep the skis apart',
        action: { kind: 'regenerate_shot', action: 'She carves left, skis apart' },
      },
      { dimension: 'editing', priority: 3, title: 'Trim', detail: '', action: { kind: 'note' } },
    ],
    transcript: [],
    ...over,
  });

  it('pins scene issues to export times, orders recommendations and falls back to the scenes’ scores', () => {
    const { c1, c2, clips, timeline } = fixture();
    const spans = shotSpans(timeline, clips);
    const scenes: SceneReview[] = [
      {
        clipId: c1.id,
        index: 0,
        title: c1.title,
        start: 0,
        end: 20,
        spans: spans.slice(0, 4),
        output: sceneOutput(),
      },
      {
        clipId: c2.id,
        index: 1,
        title: c2.title,
        start: 20,
        end: 25,
        spans: spans.slice(4),
        output: null,
        error: 'provider down',
      },
    ];
    const signals = FeedbackSignalsSchema.parse({ durationSec: 25 });
    const out = assembleFeedback({ scenes, film: null, signals, retrospective: [] });
    const skis = out.issues.find((i) => i.title === 'Skis through the leg')!;
    expect(skis).toMatchObject({
      start: 7.5,
      end: 8.5,
      shot: 'C1·S2',
      shotId: spans[1]!.shotId,
      source: 'vision',
    });
    const turn = out.issues.find((i) => i.title === 'No turn')!;
    expect(turn).toMatchObject({ start: 0, end: 20, shot: null });
    expect(out.issues.map((i) => i.id)).toEqual(out.issues.map((_, k) => `i${k + 1}`));
    expect(out.recommendations[0]).toMatchObject({
      id: 'r1',
      priority: 1,
      issueIds: [skis.id],
      action: {
        kind: 'regenerate_shot',
        clipId: c1.id,
        shotId: spans[1]!.shotId,
        action: 'She carves left, skis apart',
      },
      status: 'open',
    });
    expect(out.recommendations[1]!.action).toEqual({ kind: 'note' });
    // Only the first scene scored: its scores are the film's; sound is not measured.
    expect(out.scores.physics).toBe(5);
    expect(out.scores.sound).toBeNull();
    expect(out.overall).toBe(overallScore(out.scores));
    expect(out.scenes[1]!.error).toBe('provider down');
    expect(out.summary).toContain('The slope: A run down the slope.');
  });

  it('prefers the film call’s scores, summary and recommendations, and maps scenes to clips', () => {
    const { c1, clips, timeline } = fixture();
    const spans = shotSpans(timeline, clips);
    const out = assembleFeedback({
      scenes: [
        {
          clipId: c1.id,
          index: 0,
          title: c1.title,
          start: 0,
          end: 20,
          spans: spans.slice(0, 4),
          output: sceneOutput(),
        },
      ],
      film: {
        scores: { storytelling: 4 },
        summary: 'The film needs a stronger arc.',
        strengths: ['charming cast'],
        recommendations: [
          {
            dimension: 'storytelling',
            priority: 1,
            title: 'Re-plan scene 1',
            detail: '',
            scenes: [1],
            action: { kind: 'replan_scene', scene: 1, direction: 'end on a fall' },
          },
          {
            dimension: 'physics',
            priority: 2,
            title: 'Quality checks',
            detail: '',
            scenes: [],
            action: { kind: 'settings', settings: { qualityChecks: true } },
          },
        ],
        lessons: [{ area: 'cost', title: 'Fewer retries', detail: '' }],
      },
      signals: FeedbackSignalsSchema.parse({ durationSec: 25 }),
      retrospective: [
        {
          area: 'performance',
          title: 'Raise the video lane',
          detail: '',
          source: 'rule',
          rule: 'queue_wait',
        },
      ],
    });
    expect(out.scores.storytelling).toBe(4);
    expect(out.scores.physics).toBe(5);
    expect(out.summary).toBe('The film needs a stronger arc.');
    expect(out.strengths).toEqual(['charming cast']);
    expect(out.recommendations[0]).toMatchObject({
      title: 'Re-plan scene 1',
      action: { kind: 'replan_scene', clipId: c1.id, direction: 'end on a fall' },
    });
    expect(out.recommendations.find((r) => r.title === 'Quality checks')!.action).toEqual({
      kind: 'settings',
      patch: { qualityChecks: true },
    });
    expect(out.retrospective.map((r) => [r.source, r.title])).toEqual([
      ['rule', 'Raise the video lane'],
      ['vision', 'Fewer retries'],
    ]);
  });

  it('writes the report and validates the document', () => {
    const fb = FeedbackSchema.parse({
      id: feedbackIdFor('exp_01m5qvveq6y41x74'),
      exportId: 'exp_01m5qvveq6y41x74',
      status: 'succeeded',
      createdAt: '2026-10-25T00:00:00.000Z',
      updatedAt: '2026-10-25T00:00:00.000Z',
      model: 'gemini-3.7-flash',
      overall: 6.5,
      summary: 'Two pandas ski.',
      recommendations: [
        { id: 'r1', priority: 1, dimension: 'physics', title: 'Regenerate C1·S2', action: { kind: 'note' } },
      ],
      issues: [
        {
          id: 'i1',
          dimension: 'temporal',
          severity: 'major',
          title: 'Jump',
          start: 7.4,
          end: 7.9,
          clipId: null,
          shot: 'C1·S2',
          source: 'signal',
        },
      ],
    });
    expect(fb.id).toBe('fbk_01m5qvveq6y41x74');
    const md = feedbackMarkdown(fb, {
      title: 'Sammy and Rosie',
      run: { costUsd: 12.5, videoSeconds: 600, hours: 4 },
    });
    expect(md).toContain('# Feedback: Sammy and Rosie');
    expect(md).toContain('**Overall: 6.5/10**');
    expect(md).toContain('P1 · Physics: Regenerate C1·S2');
    expect(md).toContain('about $12.50');
  });
});

describe('usage and telemetry schemas (docs/design/observability.md)', () => {
  it('adds usage by model and parses prices', () => {
    const a = emptyUsage();
    const b = {
      ...emptyUsage(),
      videoSeconds: 5,
      costUsd: 0.5,
      byModel: {
        wan: { modality: 'video' as const, calls: 1, seconds: 60, units: 5, costUsd: 0.5, unpriced: 0 },
      },
    };
    addUsage(a, b);
    addUsage(a, b);
    expect(a.videoSeconds).toBe(10);
    expect(a.byModel.wan).toMatchObject({ calls: 2, units: 10, costUsd: 1 });
    expect(parsePrices('')).toEqual({});
    expect(parsePrices('{"wan":{"videoSecond":0.1}}')).toEqual({ wan: { videoSecond: 0.1 } });
    expect(() => parsePrices('{wan')).toThrow(/not JSON/);
    expect(() => parsePrices('{"wan":{"videoSecond":-1}}')).toThrow(/RIDEO_PRICES/);
  });

  it('accepts only known telemetry names, at most 50 events', () => {
    expect(
      TelemetryInputSchema.safeParse({ events: [{ kind: 'vital', name: 'lcp', value: 1.2 }] }).success,
    ).toBe(true);
    expect(
      TelemetryInputSchema.safeParse({ events: [{ kind: 'vital', name: 'secret', value: 1 }] }).success,
    ).toBe(false);
    expect(
      TelemetryInputSchema.safeParse({
        events: Array.from({ length: 51 }, () => ({ kind: 'error', name: 'api', value: 1 })),
      }).success,
    ).toBe(false);
  });
});

describe('listening feedback (docs/design/feedback.md#how-a-film-is-watched)', () => {
  const output = (over: Partial<FeedbackSceneOutput>): FeedbackSceneOutput => ({
    scores: { storytelling: 7, physics: 7, dialogue: 5, sound: 8 },
    summary: 'Watched and heard.',
    strengths: [],
    issues: [],
    recommendations: [],
    transcript: [],
    ...over,
  });

  it('compares what was heard with each shot’s lines, places issues by time, and scores dialogue and sound', () => {
    const { c1, clips, timeline } = fixture();
    const rosie = f.character({ name: 'Rosie' });
    const sammy = f.character({ name: 'Sammy' });
    c1.shots[1]!.dialogue = [{ characterId: rosie.id, line: 'Look at the mountain, Sammy!' }];
    c1.shots[2]!.dialogue = [{ characterId: sammy.id, line: 'It is so big and white.' }];
    const characters = { [rosie.id]: rosie, [sammy.id]: sammy };
    const spans = shotSpans(timeline, clips);
    const scenes: SceneReview[] = [
      {
        clipId: c1.id,
        index: 0,
        title: c1.title,
        start: 0,
        end: 20,
        spans: spans.slice(0, 4),
        listened: true,
        output: output({
          transcript: [
            { time: 5.4, speaker: 'Rosie', text: 'Look at the mountain, Sammy!' },
            { time: 11, speaker: '', text: 'mm hmm' },
          ],
          issues: [
            { time: 12.5, dimension: 'dialogue', severity: 'major', title: 'Mumbled line', detail: '' },
          ],
        }),
      },
    ];
    const dialogue = dialogueDelivery(scenes, clips, characters);
    expect(dialogue).toMatchObject({
      lines: 2,
      heard: 1,
      missing: [{ shot: 'C1·S3', character: 'Sammy', heard: 0, start: 10, end: 15 }],
    });
    expect(dialogueDelivery([{ ...scenes[0]!, listened: false }], clips, characters)).toBeNull();

    const signals = FeedbackSignalsSchema.parse({
      durationSec: 25,
      dialogue,
      silences: [{ start: 21, end: 24.5 }],
    });
    const out = assembleFeedback({ scenes, film: null, signals, retrospective: [] });
    expect(out.issues.find((i) => i.title === 'Mumbled line')).toMatchObject({
      start: 12.5,
      end: 13.5,
      shot: 'C1·S3',
      source: 'vision',
    });
    const notHeard = out.issues.find((i) => i.source === 'signal' && i.dimension === 'dialogue')!;
    expect(notHeard).toMatchObject({ shot: 'C1·S3', severity: 'major', title: 'Sammy’s line is not heard' });
    expect(out.recommendations[0]).toMatchObject({
      priority: 1,
      dimension: 'dialogue',
      issueIds: [notHeard.id],
      action: { kind: 'regenerate_shot', clipId: c1.id, shotId: spans[2]!.shotId },
    });
    expect(out.scores.dialogue).toBe(5);
    // The mean of the measured sound (one silence: 9.5) and the heard (8)
    expect(out.scores.sound).toBe(8.8);
    const fb = FeedbackSchema.parse({
      id: feedbackIdFor('exp_01m5qvveq6y41x74'),
      exportId: 'exp_01m5qvveq6y41x74',
      status: 'succeeded',
      createdAt: '2026-10-25T00:00:00.000Z',
      updatedAt: '2026-10-25T00:00:00.000Z',
      model: 'vision-x',
      listener: 'omni-x',
      listened: true,
      ...out,
      signals,
    });
    const md = feedbackMarkdown(fb, { title: 'T' });
    expect(md).toContain('watched by vision-x, heard by omni-x');
    expect(md).toContain('Lines heard: 1 of 2.');
  });

  it('keeps a recommendation that already regenerates the shot, and ignores heard scores of strips', () => {
    const { c1, clips, timeline } = fixture();
    const sammy = f.character({ name: 'Sammy' });
    c1.shots[2]!.dialogue = [{ characterId: sammy.id, line: 'It is so big and white.' }];
    const spans = shotSpans(timeline, clips);
    const scene = (listened: boolean): SceneReview => ({
      clipId: c1.id,
      index: 0,
      title: c1.title,
      start: 0,
      end: 20,
      spans: spans.slice(0, 4),
      listened,
      output: output({
        recommendations: [
          {
            shot: 2,
            dimension: 'dialogue',
            priority: 1,
            title: 'Sammy needs his line',
            detail: '',
            action: { kind: 'regenerate_shot', action: 'Sammy speaks clearly', characters: ['Sammy'] },
          },
        ],
      }),
    });
    const dialogue = dialogueDelivery([scene(true)], clips, { [sammy.id]: sammy });
    const listenedOut = assembleFeedback({
      scenes: [scene(true)],
      film: null,
      signals: FeedbackSignalsSchema.parse({ durationSec: 25, dialogue }),
      retrospective: [],
    });
    const kept = listenedOut.recommendations.filter(
      (r) => r.action?.kind === 'regenerate_shot' && r.action.shotId === spans[2]!.shotId,
    );
    expect(kept).toHaveLength(1);
    // Who is in frame after the fix travels with it (docs/design/feedback.md#actions)
    expect(kept[0]!.action).toMatchObject({ characters: ['Sammy'] });
    const seen = assembleFeedback({
      scenes: [scene(false)],
      film: null,
      signals: FeedbackSignalsSchema.parse({ durationSec: 25 }),
      retrospective: [],
    });
    expect(seen.scores.dialogue).toBeNull();
    expect(seen.scores.sound).toBeNull();
    expect(seen.scenes[0]!.scores).not.toHaveProperty('dialogue');
  });

  it('makes one scene review of the picture from strips and the sound heard in the video', () => {
    const picture = output({
      scores: { storytelling: 7, continuity: 4, dialogue: 9, sound: 9 },
      summary: 'Clear blocking; the skis change decals.',
      issues: [
        { shot: 1, dimension: 'continuity', severity: 'major', title: 'Decals change', detail: '', at: 0.85 },
        { shot: 1, dimension: 'sound', severity: 'minor', title: 'Guessed from stills', detail: '', at: 0.5 },
      ],
    });
    const heard = output({
      scores: { dialogue: 6, sound: 8, continuity: 1 },
      summary: 'Every line but one.',
      transcript: [{ time: 1.2, speaker: 'Sammy', text: 'Wow!' }],
      issues: [
        { shot: 0, dimension: 'dialogue', severity: 'major', title: 'Mumbled', detail: '', at: 0.5, time: 3 },
        { shot: 0, dimension: 'continuity', severity: 'critical', title: 'Teleports', detail: '', at: 0.5 },
      ],
    });
    const merged = mergeSceneOutputs(picture, heard)!;
    // The picture's scores but dialogue and sound; the sound's dialogue and sound only
    expect(merged.scores).toEqual({ storytelling: 7, continuity: 4, dialogue: 6, sound: 8 });
    expect(merged.issues.map((i) => i.title)).toEqual(['Decals change', 'Mumbled']);
    expect(merged.transcript).toEqual([{ time: 1.2, speaker: 'Sammy', text: 'Wow!' }]);
    expect(merged.summary).toBe('Clear blocking; the skis change decals. Heard: Every line but one.');
    // Strips alone: no heard scores; nothing at all: no review
    expect(mergeSceneOutputs(picture, null)!.scores).toEqual({ storytelling: 7, continuity: 4 });
    expect(mergeSceneOutputs(null, heard)!.scores).toEqual({ dialogue: 6, sound: 8 });
    expect(mergeSceneOutputs(null, null)).toBeNull();
  });

  it('finds the characters a fix names as in frame, ignoring case and unknown names', () => {
    const rosie = f.character({ name: 'Rosie' });
    const sammy = f.character({ name: 'Sammy' });
    const cast = { [rosie.id]: rosie, [sammy.id]: sammy };
    expect(castIdsOf([' rosie ', 'SAMMY', 'Rosie', 'Bao'], cast)).toEqual([rosie.id, sammy.id]);
    expect(castIdsOf(['Bao'], cast)).toEqual([]);
  });
});

describe('the outcome of a shot fix (docs/design/feedback.md#when-a-fix-does-not-pass)', () => {
  it('is pending until its job made a take, fixed when the take passes every check, not fixed otherwise', () => {
    const mira = f.character({ name: 'Mira' });
    const old = f.readyShot([mira]);
    const clip = f.clip({ shots: [old] });
    const oldTake = old.takes[0]!;
    const base = emptyTimeline({ fps: 24, width: 320, height: 180 });
    const source = (takeId: string) => ({
      type: 'take' as const,
      clipId: clip.id,
      shotId: old.id,
      takeId,
      media: oldTake.video!,
    });
    const timeline = applyOps(base, [
      {
        op: 'insert',
        trackId: base.tracks[0]!.id,
        item: { kind: 'video', source: source(oldTake.id), in: 0, out: 5 },
      },
    ]);
    const rec = FeedbackRecommendationSchema.parse({
      id: 'r1',
      priority: 1,
      dimension: 'temporal',
      title: 'Generate C1·S1 again',
      status: 'applied',
      jobId: 'job_0000000000aaaaaa',
      action: { kind: 'regenerate_shot', clipId: clip.id, shotId: old.id },
    });
    const docs = (shot: Shot, tl: Timeline = timeline) => ({
      clips: { [clip.id]: { ...clip, shots: [shot] } },
      characters: { [mira.id]: mira },
      elements: {},
      timeline: tl,
    });
    expect(fixOutcome(rec, docs(old))).toEqual({ state: 'pending' });
    expect(fixOutcome({ ...rec, status: 'open' }, docs(old))).toBeNull();
    expect(fixOutcome({ ...rec, action: { kind: 'note' } }, docs(old))).toBeNull();

    // The fix's take passed: fixed, and in the cut once swapped in; swapping again changes nothing
    const good = f.take({ jobId: rec.jobId, characterLocks: oldTake.characterLocks });
    const withGood = { ...old, takes: [oldTake, good] };
    expect(fixOutcome(rec, docs(withGood))).toMatchObject({
      state: 'fixed',
      takeId: good.id,
      inCut: false,
      issues: [],
    });
    const swap = { clipId: clip.id, shotId: old.id, takeId: good.id, media: good.video! };
    const swapped = applyOps(timeline, takeSwapOps(timeline, swap));
    expect(swapped.tracks[0]!.items[0]).toMatchObject({ source: { takeId: good.id } });
    expect(fixOutcome(rec, docs(withGood, swapped))).toMatchObject({ state: 'fixed', inCut: true });
    expect(takeSwapOps(swapped, swap)).toEqual([]);

    // A quality check failed: not fixed, with why
    const quality = {
      passed: false,
      temporal: null,
      physics: 0.9,
      continuity: null,
      extras: [],
      others: ['a human girl in pink'],
      duplicates: [],
      sound: null,
      issues: ['a human girl in pink is in the frame'],
    };
    const bad = f.take({
      jobId: rec.jobId,
      characterLocks: oldTake.characterLocks,
      consistency: f.report({ quality }),
    });
    expect(takePassesChecks(bad, old, { [mira.id]: mira })).toBe(false);
    expect(fixOutcome(rec, docs({ ...old, takes: [oldTake, bad] }))).toMatchObject({
      state: 'not_fixed',
      takeId: bad.id,
      inCut: false,
      issues: ['a human girl in pink is in the frame'],
    });
    // So did the identity check
    const lost = f.take({
      jobId: rec.jobId,
      characterLocks: oldTake.characterLocks,
      consistency: f.report({
        status: 'failed',
        characters: [{ characterId: mira.id, present: true, score: 0.3, issues: ['her scarf is red'] }],
      }),
    });
    expect(fixOutcome(rec, docs({ ...old, takes: [oldTake, lost] }))).toMatchObject({
      state: 'not_fixed',
      issues: ['her scarf is red'],
    });
    // An override is a person's pass
    const overridden = {
      ...lost,
      override: {
        actor: { kind: 'user' as const, id: 'local' },
        reason: 'the scarf reads as pink',
        at: '2026-10-28T00:00:00.000Z',
      },
    };
    expect(takePassesChecks(overridden, old, { [mira.id]: mira })).toBe(true);
  });
});

describe('what a fix costs (docs/design/feedback.md#what-a-fix-costs)', () => {
  it('prices a shot’s seconds times the attempts with the pinned models, a keyframe without an approved frame', () => {
    const take = (attempts: number) =>
      f.take({
        request: { ...f.take().request, videoModel: 'wan3.0-video-prime', imageModel: 'seedream' },
        consistency: f.report({ attempts }),
      });
    const a = take(1);
    const b = take(2);
    const one = f.shot({ durationSec: 4, takes: [a], selectedTakeId: a.id });
    const two = f.shot({ index: 1, durationSec: 6, takes: [b], selectedTakeId: b.id });
    const clip = f.clip({ shots: [one, two] });
    const docs = {
      clips: { [clip.id]: clip },
      project: { settings: { models: { image: 'auto', video: 'auto' } } },
    };
    const prices = { 'wan3.0-video-prime': { videoSecond: 0.28 }, seedream: { image: 0.045 } };
    expect(meanAttempts(docs.clips)).toBe(1.5);
    const regenerate = { kind: 'regenerate_shot' as const, clipId: clip.id, shotId: one.id };
    // 4 s x 1.5 attempts = 6 s of video at $0.28, and 1.5 keyframes at $0.045
    expect(fixEstimate(regenerate, docs, prices, 1.5)).toEqual({ usd: 1.75, videoSeconds: 6, attempts: 1.5 });
    // An approved storyboard frame is the first frame: no keyframe to pay for
    const boarded = { ...one, board: { ...(one.board ?? {}), approved: true } as never };
    const withBoard = { ...docs, clips: { [clip.id]: { ...clip, shots: [boarded, two] } } };
    expect(fixEstimate(regenerate, withBoard, prices, 1.5)?.usd).toBe(1.68);
    // A re-planned scene: all its shots
    expect(fixEstimate({ kind: 'replan_scene', clipId: clip.id }, docs, prices, 1)).toEqual({
      usd: 2.89,
      videoSeconds: 10,
      attempts: 1,
    });
    // A pinned model wins over the take's; an unpriced one has no dollars
    const pinned = { ...docs, project: { settings: { models: { image: 'auto', video: 'kling' } } } };
    expect(fixEstimate(regenerate, pinned, prices, 1)).toEqual({ usd: null, videoSeconds: 4, attempts: 1 });
    // Nothing generated, nothing estimated
    expect(fixEstimate({ kind: 'note' }, docs, prices, 1)).toBeNull();
    expect(fixEstimate(null, docs, prices, 1)).toBeNull();
    expect(fixEstimate({ ...regenerate, shotId: 'sht_0000000000zzzzzz' }, docs, prices, 1)).toBeNull();
    expect(meanAttempts({})).toBe(1);
  });
});
