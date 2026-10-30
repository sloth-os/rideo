import { shotRangeFor } from '../prompt/multishot';
import type { ModelLimits } from '../schemas/gateway';
import type { VideoModelFacts } from '../schemas/llm';
import type { ProjectSettings } from '../schemas/project';

/**
 * What the video model does well and badly (docs/design/ai-review.md#how-a-review-runs): told to the reviewers, and to
 * the writer and the shot planner whose work they review (docs/design/first-pass.md#one-rubric-for-the-maker-and-the-reviewer).
 */
export const VIDEO_MODEL_FACTS = {
  strengths: [
    'one or two characters in a shot, three at most',
    'clear, simple actions with visible cause and effect',
    'natural light, weather and landscapes',
    'medium shots and close-ups that hold one framing',
    "lines spoken in the shot, in each character's voice",
  ],
  weaknesses: [
    'crowds and background people',
    'on-screen text, signs and labels',
    'fine hand work: holding small objects, tying, buckling, operating machines',
    'mechanical handling: boarding a lift, putting on equipment',
    'quick repeated motion',
    'a character who appears in a shot from nowhere',
    'one take longer than ten seconds: it drifts and cuts itself (scenes are split into shorter shots)',
    'inserts that must hold a tight framing: the camera widens',
  ],
};

/** What the video model is told to be: the shots the planner will make for it, and what it renders well and badly. */
export function videoFacts(
  limits: ModelLimits | null,
  settings: Pick<ProjectSettings, 'generation' | 'dialogue'>,
): VideoModelFacts {
  const { min, max } = shotRangeFor(settings, limits);
  return { shotSeconds: { min, max }, ...VIDEO_MODEL_FACTS };
}
