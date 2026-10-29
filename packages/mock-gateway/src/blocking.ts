import type {
  CastReviewInput,
  SceneBlockInput,
  SceneBlockOutput,
  StageReviewOutput,
  TakeWatchInput,
  TakeWatchOutput,
} from '@rideo/shared';

/**
 * The director's desk and the reviews of every step in the mock (docs/design/director-desk.md#mock-gateway,
 * docs/design/ai-review.md#mock-gateway): deterministic answers from the input.
 */

/** A shot whose camera the mock puts on the wrong side of the line, so tests see the solver bring it back. */
const CROSS_THE_LINE = /\bcross the line\b/i;
/** A take whose motion breaks, so tests see the whole-take watch retry it. */
const MOTION_GLITCH = /\bmotion glitch\b/i;
/** A character whose references do not match each other, so tests see the cast review draw them again. */
const INCONSISTENT = /\binconsistent\b/i;

/** `scene.block`: the cast in a row across the set facing each other (two) or the front, the place behind them. */
export function sceneBlock(input: SceneBlockInput): SceneBlockOutput {
  const n = input.cast.length;
  const spacing = 1.6;
  const actors = input.cast.map((c, i) => ({
    name: c.name,
    x: (i - (n - 1) / 2) * spacing,
    z: 0,
    facingDeg: n === 2 ? (i === 0 ? 90 : 270) : 0,
    pose: 'stand' as const,
    toX: null,
    toZ: null,
  }));
  const snowy = /snow|ski|winter/i.test(`${input.scene.location} ${input.scene.heading}`);
  const beach = /beach|sea|lagoon|shore/i.test(`${input.scene.location} ${input.scene.heading}`);
  return {
    set: {
      width: Math.max(10, n * 4),
      depth: 10,
      ground: snowy ? 'snow' : beach ? 'sand' : 'ground',
      interior: /^\s*int\b/i.test(input.scene.heading),
      sun: { azimuthDeg: 200, elevationDeg: 40 },
      landmarks: input.place
        ? [
            {
              label: input.place.name,
              shape: beach ? ('water' as const) : ('box' as const),
              x: 0,
              z: -6,
              width: beach ? 30 : 4,
              depth: beach ? 4 : 2,
              height: beach ? 0.05 : 3,
              rotationDeg: 0,
            },
          ]
        : [],
    },
    actors,
    props: input.props.map((p, i) => ({
      name: p.name,
      x: (actors[0]?.x ?? 0) + 0.6 + i * 0.4,
      z: 0.6,
      size: 0.4,
      heldBy: undefined,
    })),
    shots: input.shots.map((s) => ({
      index: s.index,
      marks: [],
      camera: {
        subjects: s.characters,
        angle:
          s.framing === 'over_shoulder' && s.characters.length >= 2
            ? 'over_shoulder'
            : s.characters.length === 1
              ? CROSS_THE_LINE.test(s.description)
                ? 'back'
                : s.index % 2 === 0
                  ? 'three_quarter_left'
                  : 'three_quarter_right'
              : CROSS_THE_LINE.test(s.description)
                ? 'back'
                : 'front',
        height: 'eye',
        move: s.movement === 'dolly_in' ? 'push_in' : s.movement === 'dolly_out' ? 'pull_out' : 'none',
      },
    })),
  };
}

/** `take.watch`: a take passes unless its shot says "motion glitch" (a critical morph). */
export function takeWatch(input: TakeWatchInput, watched: boolean): TakeWatchOutput {
  const glitch = MOTION_GLITCH.test(`${input.shot.description} ${input.shot.action}`);
  return {
    overall: glitch ? 3 : 8,
    motion: glitch ? 0.2 : 0.9,
    physics: 0.85,
    action: watched ? 0.9 : 0.6,
    camera: 0.85,
    identity: 0.9,
    others: [],
    issues: glitch
      ? [
          {
            time: Math.min(input.durationSec, 2),
            severity: 'critical',
            title: 'The figure morphs mid-shot',
            detail: 'Watched whole: the body melts and reforms between the frames.',
          },
        ]
      : [],
  };
}

/** `cast.review`: a cast passes; a character whose identity says "inconsistent" gets its references drawn again. */
export function castReview(input: CastReviewInput, references: number): StageReviewOutput {
  const subject = input.subject;
  const text = subject.kind === 'character' ? `${subject.identity} ${subject.wardrobe}` : subject.description;
  const bad = INCONSISTENT.test(text) && subject.kind === 'character';
  const who = subject.kind === 'character' ? { character: subject.name } : { element: subject.name };
  return {
    scores: {
      likeness: references ? 8 : 3,
      consistency: bad ? 3 : 8,
      distinct: 8,
      clarity: 8,
      style: 8,
    },
    summary: `${subject.name}: ${references} reference(s) reviewed.`,
    strengths: references ? [`${subject.name} reads clearly.`] : [],
    issues: bad
      ? [
          {
            ...who,
            dimension: 'consistency',
            severity: 'critical',
            title: `${subject.name}'s views do not match`,
            detail: 'The face and the outfit change from view to view.',
          },
        ]
      : [],
    recommendations: bad
      ? [
          {
            ...who,
            dimension: 'consistency',
            priority: 1,
            title: `Draw ${subject.name} again`,
            detail: 'One face and one outfit in every view.',
            action: { kind: 'regenerate_refs', instruction: 'the same face and outfit in every view' },
          },
        ]
      : [],
  };
}
