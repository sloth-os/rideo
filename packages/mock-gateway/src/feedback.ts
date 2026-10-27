import type {
  FeedbackFilmInput,
  FeedbackFilmOutput,
  FeedbackSceneInput,
  FeedbackSceneOutput,
  SoundCheckInput,
  SoundCheckOutput,
} from '@rideo/shared';

/**
 * Feedback tasks of the mock (docs/design/feedback.md#mock-gateway): deterministic answers derived from the input, so
 * tests can follow a whole export → feedback → apply → regenerate loop.
 */
const DIMENSIONS = [
  'storytelling',
  'continuity',
  'character',
  'temporal',
  'physics',
  'realism',
  'cinematography',
  'editing',
] as const;

type Scores = Record<(typeof DIMENSIONS)[number], number>;

/** A shot whose speaker mumbles: the mock never hears its lines (docs/design/feedback.md#mock-gateway). */
const MUMBLES = /\bmumbl/i;

/**
 * `sound.check`: hears the shot's lines in their speakers' voices (none when the description says the speaker mumbles,
 * or when the gateway muffles this check), music when the description asks for it.
 */
export function soundCheck(
  input: SoundCheckInput,
  opts: { watched: boolean; muffled: boolean },
): SoundCheckOutput {
  const silent = !opts.watched || opts.muffled || MUMBLES.test(input.shot.description);
  return {
    speech: silent
      ? []
      : input.lines.map((l) => ({ text: l.line, speaker: l.character, voice: l.voice, lipSync: 0.9 })),
    music: /\bmusic\b/i.test(input.shot.description),
    sounds: ['wind', 'skis on snow'],
    score: silent && input.lines.length ? 0.4 : 0.85,
    issues: silent && input.lines.length ? ['no voices are heard'] : [],
  };
}

export function feedbackScene(input: FeedbackSceneInput, strips: number): FeedbackSceneOutput {
  const scores: Scores = {
    storytelling: 7,
    continuity: 7.5,
    character: 8,
    temporal: 8,
    physics: 8,
    realism: 7,
    cinematography: 7,
    editing: 7,
  };
  const issues: FeedbackSceneOutput['issues'] = [];
  const shotScore = new Map<number, number>();
  for (const shot of input.shots) {
    let score = 8;
    if (shot.take?.quality && !shot.take.quality.passed) {
      score -= 3;
      scores.physics = Math.min(scores.physics, 5);
      issues.push({
        shot: shot.index,
        dimension: 'physics',
        severity: 'major',
        title: 'Movement does not follow physics',
        detail: `${shot.label}: the take failed the quality checks.`,
        at: 0.5,
      });
    }
    if (shot.take && shot.take.consistency !== 'passed') {
      score -= 2;
      scores.character = Math.min(scores.character, 6);
    }
    shotScore.set(shot.index, score);
  }
  for (const at of input.signals.unexpectedCuts) {
    const shot = input.shots.find((s) => at >= s.start && at < s.end);
    if (!shot) continue;
    shotScore.set(shot.index, (shotScore.get(shot.index) ?? 8) - 4);
    scores.temporal = Math.min(scores.temporal, 4);
    issues.push({
      shot: shot.index,
      dimension: 'temporal',
      severity: 'major',
      title: 'The picture jumps inside the shot',
      detail: `${shot.label} changes abruptly at ${at.toFixed(1)} s.`,
      at: Math.min(1, Math.max(0, (at - shot.start) / Math.max(0.1, shot.end - shot.start))),
    });
  }
  const worst = [...shotScore.entries()].sort((a, b) => a[1] - b[1] || a[0] - b[0])[0];
  const worstShot = worst ? input.shots.find((s) => s.index === worst[0]) : undefined;
  return {
    scores,
    transcript: [],
    summary: `Scene ${input.scene.number} (${input.scene.heading}) seen in ${strips} strip(s): ${input.shots.length} shot(s).`,
    strengths: ['The cast stays recognisable from shot to shot.'],
    issues,
    recommendations: [
      ...(worstShot
        ? [
            {
              shot: worstShot.index,
              dimension: issues.find((i) => i.shot === worstShot.index)?.dimension ?? 'cinematography',
              priority: 1,
              title: `Generate ${worstShot.label} again`,
              detail: 'A steadier camera and feet planted on the ground.',
              action: {
                kind: 'regenerate_shot' as const,
                description: `${worstShot.description} Steady camera, feet planted on the ground.`,
                negativePrompt: 'floating, jump cut',
              },
            },
          ]
        : []),
      {
        dimension: 'storytelling',
        priority: 2,
        title: 'Give the scene a clear turn',
        detail: 'End on a reaction that changes what the characters want.',
        action: { kind: 'note' as const },
      },
    ],
  };
}

/**
 * `feedback.listen`: hears every line of the scene's video except a mumbling speaker's, scores dialogue and sound, and
 * recommends generating a mumbled shot again (docs/design/feedback.md#mock-gateway).
 */
export function feedbackListen(input: FeedbackSceneInput, watched: boolean): FeedbackSceneOutput {
  const transcript: FeedbackSceneOutput['transcript'] = [];
  const mumbled = input.shots.filter((s) => s.dialogue.length && MUMBLES.test(s.description));
  if (watched)
    for (const shot of input.shots) {
      if (MUMBLES.test(shot.description)) continue;
      for (const [k, d] of shot.dialogue.entries())
        transcript.push({ time: (shot.video?.from ?? 0) + 0.3 + k, speaker: d.character, text: d.line });
    }
  return {
    scores: { dialogue: mumbled.length ? 4 : 8, sound: 7 },
    transcript,
    summary: `Scene ${input.scene.number} heard: ${transcript.length} line(s).`,
    strengths: ['Clear voices.'],
    issues: mumbled.map((s) => ({
      shot: s.index,
      dimension: 'dialogue' as const,
      severity: 'major' as const,
      title: 'A line is mumbled',
      detail: `${s.label}: the line cannot be understood.`,
      time: (s.video?.from ?? 0) + 0.5,
    })),
    recommendations: mumbled.map((s) => ({
      shot: s.index,
      dimension: 'dialogue' as const,
      priority: 1,
      title: `Generate ${s.label} again with a clear line`,
      detail: 'The speaker should say the line clearly, facing the camera.',
      action: { kind: 'regenerate_shot' as const },
    })),
  };
}

export function feedbackFilm(input: FeedbackFilmInput): FeedbackFilmOutput {
  const scores = {} as Scores;
  for (const d of DIMENSIONS) {
    const values = input.scenes.map((s) => s.scores[d]).filter((v): v is number => typeof v === 'number');
    scores[d] = values.length ? Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 10) / 10 : 6;
  }
  return {
    scores,
    summary: `${input.film.title}: ${input.scenes.length} scene(s) reviewed.`,
    strengths: ['A clear premise.'],
    recommendations: [
      {
        dimension: 'physics',
        priority: 1,
        title: 'Check physics on every take',
        detail: 'Turn the quality checks on so jumps and floating figures are generated again.',
        scenes: [],
        action: { kind: 'settings', settings: { qualityChecks: true } },
      },
    ],
    lessons: [
      {
        area: 'cost',
        title: 'Fewer discarded generations',
        detail: `${Math.round(input.run.discardedVideoSeconds)} s of video were thrown away.`,
      },
    ],
  };
}
