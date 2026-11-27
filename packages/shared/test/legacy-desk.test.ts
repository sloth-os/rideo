import { describe, expect, it } from 'vitest';
import {
  assembleStageReview,
  boardPromptHash,
  ClipSchema,
  compileShotPrompt,
  docPath,
  docsFromEntries,
  LEGACY_REVIEW_DIMENSIONS,
  ProjectSchema,
  REQUIRED_SCORES,
  REVIEW_DIMENSIONS,
  ReviewDimensionSchema,
  rubricLines,
  type StageReview,
  StageReviewOutputSchema,
  StageReviewSchema,
  shotContextOf,
  UpdateProjectInputSchema,
  validateDoc,
  withSettingsDefaults,
} from '../src';
import * as f from '../src/testing/fixtures';

/**
 * Documents written while rideo had its own 3D desk (docs/design/director-desk.md#what-happened-to-the-blocking): they
 * still read, the desk's fields are dropped, and nothing they held reaches a prompt.
 */

/**
 * A clip's `blocking` as the old desk stored it (SceneBlocking v1): Mira on her mark, and the shot's camera in front of
 * her, which gave its keyframe a blocking line and its frame hash a signature.
 */
function oldBlocking(characterId: string, shotId: string) {
  return {
    version: 1,
    source: 'ai',
    updatedAt: '2026-10-29T10:00:00.000Z',
    set: {
      width: 12,
      depth: 10,
      ground: 'wooden floor',
      interior: true,
      sun: { azimuthDeg: 200, elevationDeg: 35 },
      landmarks: [],
    },
    actors: [
      {
        id: 'act_mira',
        characterId,
        color: '#f28c28',
        heightM: 1.7,
        x: 0,
        z: 0,
        facingDeg: 0,
        pose: 'stand',
      },
    ],
    props: [],
    shots: {
      [shotId]: {
        marks: {},
        camera: { x: 0, y: 1.5, z: 4, targetX: 0, targetY: 1.2, targetZ: 0, lensMm: 35, end: null },
        spec: null,
      },
    },
  };
}
const OLD_SETTINGS = { enabled: true, layoutImage: true };

function legacyStory() {
  const mira = f.character({ name: 'Mira' });
  const shot = f.shot({ characterIds: [mira.id], description: 'Mira lights the lamp' });
  const scene = {
    id: 'scn_0000000000aaaaaa',
    index: 0,
    beatId: null,
    heading: 'INT. LAMP ROOM - NIGHT',
    location: 'Lamp room',
    timeOfDay: 'night',
    summary: '',
    action: '',
    dialogue: [],
    characterIds: [mira.id],
    locationId: null,
    elementIds: [],
    estDurationSec: 10,
    continuity: 'Night; Mira wears her oilskin coat.',
  };
  const project = f.project();
  project.settings = {
    ...project.settings,
    generation: { ...project.settings.generation, promptVersion: 3 },
  };
  const clip = f.clip({ sceneId: scene.id, shots: [shot] });
  return { mira, shot, scene, project, clip, blocking: oldBlocking(mira.id, shot.id) };
}

describe('documents from before the 3D-Editor desk (docs/design/director-desk.md#what-happened-to-the-blocking)', () => {
  it("drops a clip's blocking and a project's blocking settings, and keeps the rest", () => {
    const { project, clip, blocking } = legacyStory();
    const storedClip = { ...clip, blocking };
    const storedProject = { ...project, settings: { ...project.settings, blocking: OLD_SETTINGS } };

    const parsedClip = ClipSchema.parse(storedClip);
    expect(parsedClip).not.toHaveProperty('blocking');
    expect(parsedClip).toEqual(ClipSchema.parse(clip));
    // Every write validates its document: the field is gone from what is stored next
    const written = validateDoc(docPath.clip(clip.id), storedClip) as Record<string, unknown>;
    expect(written).not.toHaveProperty('blocking');
    expect(written.shots).toEqual(parsedClip.shots);

    const parsedProject = ProjectSchema.parse(storedProject);
    expect(parsedProject.settings).not.toHaveProperty('blocking');
    expect(withSettingsDefaults(storedProject.settings as never)).not.toHaveProperty('blocking');
    // A client that still sends the old settings changes nothing
    const patch = UpdateProjectInputSchema.parse({ settings: { blocking: OLD_SETTINGS, autopilot: true } });
    expect(patch.settings).toEqual({ autopilot: true });
  });

  it('reads a project the old desk blocked into the same prompts and frame hashes as one never blocked', () => {
    const { mira, scene, project, clip, blocking } = legacyStory();
    const sp = f.screenplay({ scenes: [scene] });
    const entries = (withDesk: boolean): [string, unknown][] => [
      [
        docPath.project(),
        withDesk ? { ...project, settings: { ...project.settings, blocking: OLD_SETTINGS } } : project,
      ],
      [docPath.screenplay(), sp],
      [docPath.character(mira.id), mira],
      [docPath.clip(clip.id), withDesk ? { ...clip, blocking } : clip],
    ];
    const old = docsFromEntries(entries(true));
    const plain = docsFromEntries(entries(false));
    expect(old.project.settings).not.toHaveProperty('blocking');
    const shot = clip.shots[0]!;
    for (const mode of ['keyframe', 'video'] as const) {
      const prompt = compileShotPrompt(shotContextOf(shot, old), mode);
      expect(prompt).toBe(compileShotPrompt(shotContextOf(shot, plain), mode));
      expect(prompt).not.toMatch(/blocking|mannequin/i);
    }
    expect(boardPromptHash(shotContextOf(shot, old))).toBe(boardPromptHash(shotContextOf(shot, plain)));
  });

  it("still reads stored reviews that name the storyboard's blocking dimension", () => {
    const now = '2026-10-29T10:00:00.000Z';
    const review: StageReview = StageReviewSchema.parse({
      stage: 'storyboard',
      status: 'succeeded',
      scores: { composition: 8, blocking: 4 },
      issues: [
        {
          id: 'i1',
          dimension: 'blocking',
          severity: 'major',
          title: 'Crosses the 180-degree line',
          shot: 'C1·S2',
        },
      ],
      recommendations: [
        { id: 'r1', priority: 2, dimension: 'blocking', title: 'Keep the line', issueIds: ['i1'] },
      ],
      createdAt: now,
      updatedAt: now,
    });
    expect(review.issues[0]!.dimension).toBe('blocking');
    expect(review.recommendations[0]!.dimension).toBe('blocking');
    // As the stage's document and inside a production scene's clip
    expect(() => validateDoc(docPath.aiReview('storyboard'), review)).not.toThrow();
    const { clip } = legacyStory();
    expect(() => validateDoc(docPath.clip(clip.id), { ...clip, boardReview: review })).not.toThrow();
    expect(ReviewDimensionSchema.safeParse('blocking').success).toBe(true);
    expect(ReviewDimensionSchema.safeParse('staging').success).toBe(false);
  });

  it('never asks a reviewer for the blocking dimension, and never produces it', () => {
    expect(LEGACY_REVIEW_DIMENSIONS).toEqual(['blocking']);
    for (const dims of Object.values(REVIEW_DIMENSIONS)) expect(dims).not.toContain('blocking');
    expect(REQUIRED_SCORES['storyboard.review']).toEqual(REVIEW_DIMENSIONS.storyboard);
    expect(rubricLines('storyboard')).not.toContain('blocking');
    // A reviewer that still answers with it: the score is not kept, the issue goes to a dimension of the stage
    const out = StageReviewOutputSchema.parse({
      scores: { ...Object.fromEntries(REVIEW_DIMENSIONS.storyboard.map((d) => [d, 8])), blocking: 3 },
      summary: 'Fine.',
      issues: [{ shot: 0, dimension: 'blocking', severity: 'major', title: 'The line is crossed' }],
      recommendations: [{ shot: 0, dimension: 'blocking', priority: 2, title: 'Keep the line' }],
    });
    const assembled = assembleStageReview(
      'storyboard',
      out,
      {
        scenes: new Map([[1, 'scn_0000000000aaaaaa']]),
        clips: new Map([
          [
            1,
            { clipId: 'clp_0000000000aaaaaa', shots: [{ shotId: 'sht_0000000000aaaaaa', label: 'C1·S1' }] },
          ],
        ]),
      },
      7,
    );
    expect(assembled.scores).not.toHaveProperty('blocking');
    expect(Object.keys(assembled.scores).sort()).toEqual([...REVIEW_DIMENSIONS.storyboard].sort());
    expect(assembled.issues.map((i) => i.dimension)).toEqual(['composition']);
    expect(assembled.recommendations.map((r) => r.dimension)).toEqual(['composition']);
  });
});
