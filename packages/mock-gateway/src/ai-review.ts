import type {
  ScreenplayReviewInput,
  ScreenplayReviseInput,
  ScreenplayReviseOutput,
  StageReviewOutput,
  StoryboardSceneReviewInput,
} from '@rideo/shared';

/**
 * AI review tasks of the mock (docs/design/ai-review.md#mock-gateway): deterministic answers from the input, so tests
 * follow generate → review → revise → review → gate.
 */

/** Words that put a crowd in a scene, which an AI video model cannot keep. */
export const CROWD = /\b(crowds?|tourists|onlookers|spectators|bystanders)\b/gi;
/** A frame the reviewer cannot read. */
const BLURRY = /\bblurry\b/i;

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
    summary: `${input.screenplay.title}: ${input.screenplay.scenes.length} scene(s) reviewed, ${issues.length} problem(s).`,
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
  // A blocked scene's frames are also scored against their camera views (docs/design/director-desk.md)
  const scores = scoresOf(
    input.shots.some((s) => s.blocking) ? [...STORYBOARD_DIMENSIONS, 'blocking'] : STORYBOARD_DIMENSIONS,
    8,
  );
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
    summary: `Scene ${input.scene.number}: ${input.shots.length} shot(s), ${frames} frame(s).`,
    strengths: ['Readable staging.'],
    issues,
    recommendations,
  };
}
