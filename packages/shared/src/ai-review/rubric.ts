/**
 * What each reviewer scores (docs/design/first-pass.md#one-rubric-for-the-maker-and-the-reviewer): one table that the
 * reviewer's prompt and the prompt of the task that makes the step are both written from, so the maker aims at what
 * the reviewer judges. The words are the reviewers' own: changing one changes what a review measures.
 */

/** The floor a dimension must reach when a project sets none (docs/design/ai-review.md#the-verdict). */
export const DEFAULT_MIN_DIMENSION = 4;

/** The score the first pass aims at, and the bar new projects gate every score at (docs/design/first-pass.md). */
export const FIRST_PASS_BAR = 8;

/** Why a dimension fails a verdict: its score, and the floor when it is not the default one. */
export function belowFloor(dimension: string, score: number, floor: number): string {
  return floor === DEFAULT_MIN_DIMENSION
    ? `${dimension} ${score}/10`
    : `${dimension} ${score}/10, below ${floor}`;
}

export interface RubricDimension {
  id: string;
  /** What the reviewer asks of this dimension. */
  ask: string;
}

export interface Rubric {
  /** What the scores mean, from 10 down. */
  scale: string;
  dimensions: readonly RubricDimension[];
}

export const REVIEW_RUBRICS = {
  screenplay: {
    scale: '10 = ready to shoot, 7 = good with small fixes, 5 = clear problems, below 4 = must be rewritten',
    dimensions: [
      {
        id: 'story',
        ask: 'an arc (setup, inciting incident, complications, crisis, climax, resolution); every scene has a goal, an obstacle and a turn; what is set up pays off.',
      },
      { id: 'character', ask: 'the characters want something, change, and differ from each other.' },
      {
        id: 'dialogue',
        ask: `natural, short enough to be spoken within one shot, at the film's level ("brief.dialogueLevel", a CEFR level, when given) and in each character's voice.`,
      },
      {
        id: 'pacing',
        ask: 'the beats fit "brief.targetDurationSec"; no scene overstays or rushes its turn.',
      },
      { id: 'visual', ask: 'the story is told in actions a camera can see, not in thoughts or narration.' },
      {
        id: 'continuity',
        ask: 'every written scene states its time of day, weather, light and what each character wears and carries; props keep their state from scene to scene, and the outline sets up what later scenes need.',
      },
      {
        id: 'feasibility',
        ask: 'the video model can film it: two or three characters in a scene at most, simple clear actions, no crowds or background people (none at all when "brief.castOnly"), no on-screen text, no fine hand work or mechanical handling (boarding a lift, putting on equipment, tying, buckling, operating machines), no quick repeated motion, nothing in "video.weaknesses".',
      },
      {
        id: 'brief',
        ask: 'it follows the brief: the named characters, the place, the tone, every constraint it states.',
      },
    ],
  },
  storyboard: {
    scale: '10 = ready to shoot, 7 = good with small fixes, 5 = clear problems, below 4 = must be redone',
    dimensions: [
      {
        id: 'composition',
        ask: 'each frame reads at once: framing, staging, the subject where the eye goes.',
      },
      {
        id: 'continuity',
        ask: 'across the frames: screen direction (the 180-degree rule), positions, wardrobe, props and their state, light and time of day.',
      },
      {
        id: 'character',
        ask: 'the cast looks like its description in every frame, and nobody else is in frame when "film.castOnly".',
      },
      {
        id: 'coverage',
        ask: 'an establishing shot, shot and reverse shot with matching eyelines, reactions, inserts; varied framing.',
      },
      { id: 'storytelling', ask: `the frames tell the scene's beats in order.` },
      {
        id: 'feasibility',
        ask: 'each frame can be animated for its shot: clear poses, one simple action, nothing in "video.weaknesses".',
      },
      {
        id: 'pacing',
        ask: `each shot's length fits its action and its lines (about two words a second, plus a beat).`,
      },
      {
        id: 'blocking',
        ask: `only when shots have "blocking": the scene is blocked in 3D and each such frame is followed by its camera view ("Blocking <label>:", coloured mannequins for the cast, as its "blocking" line says). Does each frame keep its camera view's angle and framing, who stands where and faces which way, and the light's side? Leave it out when no shot has one. "blockingIssues" lists what the blocking itself breaks.`,
      },
    ],
  },
  cast: {
    scale: '10 = ready to lock, 7 = good, 5 = clear problems, below 4 = must be redrawn',
    dimensions: [
      {
        id: 'likeness',
        ask: 'the references show what the identity and the outfit say (age, build, face, hair, eyes, the clothes), or the place or prop as described.',
      },
      {
        id: 'consistency',
        ask: 'every view shows the same face, hair, build and outfit (a place: the same layout and materials).',
      },
      {
        id: 'distinct',
        ask: 'the character can be told apart from the others at a glance (silhouette, colours, face); a place or prop: 10 unless it is easily confused.',
      },
      {
        id: 'clarity',
        ask: 'one whole figure, unobstructed, on a plain background; a place without people in it; a prop on its own.',
      },
      { id: 'style', ask: `the references share the film's look.` },
    ],
  },
} as const satisfies Record<'screenplay' | 'storyboard' | 'cast', Rubric>;

export type RubricStage = keyof typeof REVIEW_RUBRICS;

/** The rubric as a reviewer's or a maker's prompt lists it: one "- dimension: what is asked." line per dimension. */
export function rubricLines(stage: RubricStage, only?: readonly string[]): string {
  return REVIEW_RUBRICS[stage].dimensions
    .filter((d) => !only || only.includes(d.id))
    .map((d) => `- ${d.id}: ${d.ask}`)
    .join('\n');
}

/**
 * What a maker is told about its reviewer (docs/design/first-pass.md#one-rubric-for-the-maker-and-the-reviewer): who
 * reviews its result, on which dimensions, and the bar every dimension must reach on the first review.
 */
export function makerRubric(
  stage: RubricStage,
  opts: { reviewer: string; only?: readonly string[]; names?: string },
): string {
  const r = REVIEW_RUBRICS[stage];
  return [
    `Before anything else is made from your answer, ${opts.reviewer} reviews it on these dimensions, each scored 0–10 (${r.scale}). Make it so that every dimension scores ${FIRST_PASS_BAR} or more on that first review, with nothing left to revise; check your draft against each dimension before you answer.${opts.names ? ` ${opts.names}` : ''}`,
    rubricLines(stage, opts.only),
  ].join('\n');
}
