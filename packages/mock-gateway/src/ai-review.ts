import type {
  CastReviewInput,
  ScreenplayReviewInput,
  ScreenplayReviseInput,
  ScreenplayReviseOutput,
  StageReviewOutput,
  StoryboardSceneReviewInput,
  TakeWatchInput,
  TakeWatchOutput,
} from '@rideo/shared';
import { plural } from '@rideo/shared';

/**
 * AI review tasks of the mock (docs/design/ai-review.md#mock-gateway): deterministic answers from the input, so tests
 * follow generate → review → revise → review → gate, a take watched whole and the cast reviewed.
 */

/** Words that put a crowd in a scene, which an AI video model cannot keep. */
export const CROWD = /\b(crowds?|tourists|onlookers|spectators|bystanders)\b/gi;
/** A frame the reviewer cannot read. */
const BLURRY = /\bblurry\b/i;
/** A take whose motion breaks, so tests see the whole-take watch retry it. */
const MOTION_GLITCH = /\bmotion glitch\b/i;
/** A character whose references do not match each other, so tests see the cast review draw them again. */
const INCONSISTENT = /\binconsistent\b/i;

const SCREENPLAY_DIMENSIONS = [
  'story',
  'character',
  'dialogue',
  'pacing',
  'visual',
  'continuity',
  'feasibility',
  'brief',
];
const STORYBOARD_DIMENSIONS = [
  'composition',
  'continuity',
  'character',
  'coverage',
  'storytelling',
  'feasibility',
  'pacing',
];

const scoresOf = (dims: string[], value: number) => Object.fromEntries(dims.map((d) => [d, value]));

/** `screenplay.review`: a scene with a crowd or more than three characters cannot be filmed (critical). */
export function screenplayReview(input: ScreenplayReviewInput): StageReviewOutput {
  const scores = scoresOf(SCREENPLAY_DIMENSIONS, 8);
  const issues: StageReviewOutput['issues'] = [];
  const recommendations: StageReviewOutput['recommendations'] = [];
  for (const s of input.screenplay.scenes) {
    const crowd = `${s.action} ${s.summary}`.match(CROWD);
    if (!crowd && s.characters.length <= 3) continue;
    scores.feasibility = 3;
    const title = crowd
      ? `Scene ${s.number} needs a crowd`
      : `Scene ${s.number} has ${s.characters.length} characters`;
    issues.push({
      scene: s.number,
      dimension: 'feasibility',
      severity: 'critical',
      title,
      detail: 'An AI video model cannot keep many people in a shot.',
    });
    recommendations.push({
      scene: s.number,
      dimension: 'feasibility',
      priority: 1,
      title: `Keep scene ${s.number} to its cast`,
      detail: 'Tell the scene with the named characters only.',
      action: {
        kind: 'revise_scene',
        instruction: `Remove the ${crowd ? crowd[0].toLowerCase() : 'extra characters'}: the scene plays with the cast only.`,
      },
    });
  }
  return {
    scores,
    summary: `${input.screenplay.title}: ${plural(input.screenplay.scenes.length, 'scene')} reviewed, ${plural(issues.length, 'problem')}.`,
    strengths: ['A clear premise.'],
    issues,
    recommendations: [
      ...recommendations,
      {
        dimension: 'story',
        priority: 3,
        title: 'Plant the ending earlier',
        detail: 'Show the object that resolves the story in the first scene.',
        action: { kind: 'note' },
      },
    ],
  };
}

/** `screenplay.revise`: the named scenes without their crowd, three characters at most. */
export function screenplayRevise(input: ScreenplayReviseInput): ScreenplayReviseOutput {
  const scenes: ScreenplayReviseOutput['scenes'] = [];
  for (const i of input.instructions) {
    if (!i.scene) continue;
    const s = input.screenplay.scenes[i.scene - 1];
    if (!s) continue;
    scenes.push({
      number: i.scene,
      beatIndex: undefined,
      heading: s.heading,
      location: s.location,
      timeOfDay: s.timeOfDay,
      continuity: s.continuity || 'Morning, clear sky; everyone wears their usual clothes.',
      summary: s.summary.replace(CROWD, 'the quiet').trim(),
      action: s.action.replace(CROWD, 'the quiet').trim(),
      dialogue: s.dialogue.map((d) => ({ ...d, parenthetical: undefined })),
      characters: s.characters.slice(0, 3),
      props: s.props,
      estDurationSec: s.estDurationSec,
    });
  }
  return { scenes, outline: [], locations: [], props: [] };
}

/** `storyboard.review`: a missing or blurry frame is redrawn; the rest scores 8. */
export function storyboardReview(input: StoryboardSceneReviewInput, frames: number): StageReviewOutput {
  const scores = scoresOf(STORYBOARD_DIMENSIONS, 8);
  const issues: StageReviewOutput['issues'] = [];
  const recommendations: StageReviewOutput['recommendations'] = [];
  for (const s of input.shots) {
    const blurry = BLURRY.test(s.description);
    if (s.frame === 'attached' && !blurry) continue;
    scores.composition = 3;
    issues.push({
      shot: s.index,
      dimension: 'composition',
      severity: 'major',
      title: blurry ? `${s.label} is blurry` : `${s.label} has no frame`,
      detail: 'The frame does not show the shot.',
    });
    recommendations.push({
      shot: s.index,
      dimension: 'composition',
      priority: 1,
      title: `Draw ${s.label} again`,
      detail: 'A sharp frame of the shot as described.',
      action: {
        kind: 'redraw_board',
        description: s.description.replace(BLURRY, 'sharp').trim(),
      },
    });
  }
  return {
    scores,
    summary: `Scene ${input.scene.number}: ${plural(input.shots.length, 'shot')}, ${plural(frames, 'frame')}.`,
    strengths: ['Readable staging.'],
    issues,
    recommendations,
  };
}

/** `take.watch`: a take passes unless its shot says "motion glitch" (a critical morph). */
export function takeWatch(input: TakeWatchInput, watched: boolean): TakeWatchOutput {
  const glitch = MOTION_GLITCH.test(`${input.shot.description} ${input.shot.action}`);
  return {
    fix: glitch ? 'every figure keeps its shape and size from the first frame to the last' : '',
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
    summary: `${subject.name}: ${plural(references, 'reference')} reviewed.`,
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
