import { describe, expect, it } from 'vitest';
import {
  briefAdaptation,
  briefHash,
  CHARACTER_VIEWS,
  CLOSE_FRAMINGS,
  ClipReviewSchema,
  clipReviewVerdict,
  compileElementReferenceRequest,
  compileReferenceRequest,
  compileShotPrompt,
  DEFAULT_REVIEW_SETTINGS,
  ELEMENT_VIEWS,
  FIRST_PASS_BAR,
  headCropped,
  MAX_ANCHOR_IMAGES,
  makerRubric,
  ProjectSettingsSchema,
  REFERENCE_VIEW_PRIORITY,
  REVIEW_DIMENSIONS,
  REVIEW_RUBRICS,
  ReviewSettingsSchema,
  referenceLabels,
  rubricLines,
  type ShotContext,
  StageReviewSchema,
  selectReferences,
  stageVerdict,
  VIDEO_MODEL_FACTS,
  videoFacts,
  workingBrief,
} from '../src';
import * as f from '../src/testing/fixtures';

/** Right the first time (docs/design/first-pass.md). */

const screenplay = (v: number) =>
  Object.fromEntries(REVIEW_DIMENSIONS.screenplay.map((d) => [d, v])) as Record<string, number>;

describe('the gate at 8 (docs/design/first-pass.md#the-gate-at-8)', () => {
  it('keeps the old bars in the schema, so a project made before keeps its gates', () => {
    expect(DEFAULT_REVIEW_SETTINGS).toMatchObject({ threshold: 7, sceneThreshold: 6, minDimension: 4 });
    expect(
      StageReviewSchema.parse({
        stage: 'cast',
        status: 'running',
        createdAt: '2026-10-30T00:00:00.000Z',
        updatedAt: '2026-10-30T00:00:00.000Z',
      }),
    ).toMatchObject({ threshold: 7, minDimension: 4 });
    expect(() => ReviewSettingsSchema.parse({ minDimension: 11 })).toThrow();
    expect(FIRST_PASS_BAR).toBe(8);
  });

  it('fails a stage review when any one dimension is under the floor, whatever the mean', () => {
    // 8.6 overall, continuity at 7: passes the old gate, not the new one
    const scores = { ...screenplay(8.8), continuity: 7 };
    expect(stageVerdict('screenplay', scores, [], 7).passed).toBe(true);
    expect(stageVerdict('screenplay', scores, [], 8, 8)).toEqual({
      passed: false,
      score: 8.6,
      blocking: ['continuity 7/10, below 8'],
    });
    expect(stageVerdict('screenplay', screenplay(8), [], 8, 8)).toEqual({
      passed: true,
      score: 8,
      blocking: [],
    });
    // The default floor keeps its words
    expect(stageVerdict('screenplay', { ...screenplay(9), pacing: 3 }, [], 7).blocking).toEqual([
      'pacing 3/10',
    ]);
  });

  it('fails a scene review when any one dimension is under the floor', () => {
    const scores = {
      storytelling: 9,
      continuity: 7.5,
      character: 9,
      temporal: 9,
      physics: 9,
      realism: 9,
      cinematography: 9,
      editing: 9,
    };
    const issues = ClipReviewSchema.shape.issues.parse([]);
    expect(clipReviewVerdict({ overall: 8.8, scores, issues }, 6).passed).toBe(true);
    expect(clipReviewVerdict({ overall: 8.8, scores, issues }, 8, 8)).toEqual({
      passed: false,
      score: 8.8,
      blocking: ['continuity 7.5/10, below 8'],
    });
    expect(
      clipReviewVerdict({ overall: 7.9, scores: { ...scores, continuity: 9 }, issues }, 8, 8).blocking,
    ).toEqual(['score 7.9 of 8']);
  });
});

describe('one rubric for the maker and the reviewer (docs/design/first-pass.md#one-rubric-for-the-maker-and-the-reviewer)', () => {
  it('scores exactly the dimensions each stage records', () => {
    for (const stage of ['screenplay', 'storyboard', 'cast'] as const)
      expect(REVIEW_RUBRICS[stage].dimensions.map((d) => d.id)).toEqual([...REVIEW_DIMENSIONS[stage]]);
  });

  it('lists a dimension per line, as the reviewer reads it', () => {
    const lines = rubricLines('screenplay').split('\n');
    expect(lines).toHaveLength(8);
    expect(lines[6]).toMatch(/^- feasibility: the video model can film it: two or three characters/);
    expect(rubricLines('storyboard', ['pacing'])).toBe(
      `- pacing: each shot's length fits its action and its lines (about two words a second, plus a beat).`,
    );
  });

  it("tells the maker who reviews it, the scale, the bar and the reviewer's own criteria", () => {
    const text = makerRubric('storyboard', {
      reviewer: 'a script supervisor',
      only: ['continuity', 'pacing'],
      names: '"video" is your input "video".',
    });
    expect(text).toContain('a script supervisor reviews it');
    expect(text).toContain(REVIEW_RUBRICS.storyboard.scale);
    expect(text).toContain('every dimension scores 8 or more on that first review');
    expect(text).toContain('"video" is your input "video".');
    expect(text).toContain(rubricLines('storyboard', ['continuity', 'pacing']));
    expect(text).not.toContain('- blocking:');
  });

  it("tells the makers what the video model renders well and badly, with the shots' range", () => {
    const facts = videoFacts(null, ProjectSettingsSchema.parse({}));
    expect(facts.weaknesses).toEqual(VIDEO_MODEL_FACTS.weaknesses);
    expect(facts.shotSeconds.max).toBeGreaterThan(facts.shotSeconds.min);
  });
});

describe('references drawn from a whole figure (docs/design/first-pass.md#references-drawn-from-a-whole-figure)', () => {
  const settings = ProjectSettingsSchema.parse({});
  const rosie = f.character({ name: 'Rosie' });

  it('draws the whole figure first and every view whole', () => {
    expect(CHARACTER_VIEWS).toEqual(['full_body', 'three_quarter', 'profile']);
    for (const view of CHARACTER_VIEWS) {
      const req = compileReferenceRequest(rosie, view, { screenplay: null, settings });
      const text = (req.input[0] as { text: string }).text;
      expect(text).toContain('the whole figure from head to toe in frame');
      expect(req.input).toHaveLength(1);
    }
  });

  it('keeps the anchor part by part in every view drawn from it', () => {
    const req = compileReferenceRequest(rosie, 'profile', {
      screenplay: null,
      settings,
      baseImageUri: 'data:image/png;base64,AAAA',
    });
    expect((req.input[0] as { text: string }).text).toContain(
      'every part of the outfit in the same colour, shape and place',
    );
    expect(req.input[1]).toEqual({ type: 'image', uri: 'data:image/png;base64,AAAA' });
  });

  it('sends the views drawn before a view with it, the anchor first, three at most', () => {
    const req = compileReferenceRequest(rosie, 'profile', {
      screenplay: null,
      settings,
      baseImageUri: 'data:anchor',
      baseImageUris: ['data:anchor', 'data:three-quarter', 'data:extra-1', 'data:extra-2'],
    });
    expect(req.input.slice(1)).toEqual([
      { type: 'image', uri: 'data:anchor' },
      { type: 'image', uri: 'data:three-quarter' },
      { type: 'image', uri: 'data:extra-1' },
    ]);
    expect(MAX_ANCHOR_IMAGES).toBe(3);
    expect((req.input[0] as { text: string }).text).toContain(
      'The reference images show this same character',
    );
  });

  it('draws a view again with another seed', () => {
    const seed = (attempt?: number) =>
      compileReferenceRequest(rosie, 'profile', { screenplay: null, settings, attempt }).parameters?.seed;
    expect(seed(0)).toBe(seed());
    expect(seed(1)).not.toBe(seed(0));
    const lamp = f.element({ kind: 'location', name: 'Lamp room' });
    const elementSeed = (attempt?: number) =>
      compileElementReferenceRequest(lamp, 'establishing', { screenplay: null, settings, attempt }).parameters
        ?.seed;
    expect(elementSeed(2)).not.toBe(elementSeed(0));
  });

  it("keeps a place's or a prop's materials under the film's look", () => {
    const jump = f.element({ kind: 'prop', name: 'Pole jump', description: 'two white wooden supports' });
    const req = compileElementReferenceRequest(jump, 'detail', {
      screenplay: { style: { visual: 'plush 3D', palette: '', camera: '', lighting: '' } },
      settings,
    });
    expect((req.input[0] as { text: string }).text).toContain(
      'Visual style: plush 3D; the style is the light and the rendering, and every material stays as described',
    );
  });

  it('gives keyframes the whole outfit first', () => {
    expect(REFERENCE_VIEW_PRIORITY.slice(0, 2)).toEqual(['full_body', 'three_quarter']);
    const at = (view: (typeof CHARACTER_VIEWS)[number] | 'front', createdAt: string) => ({
      ...f.reference({ view }),
      approved: true,
      createdAt,
    });
    const c = {
      ...rosie,
      references: [
        at('front', '2026-01-01'),
        at('three_quarter', '2026-01-02'),
        at('full_body', '2026-01-03'),
      ],
    };
    const sel = selectReferences([c], { wardrobe: {} }, 8);
    expect(sel.perCharacter[0]!.refs.map((r) => r.view)).toEqual(['full_body', 'three_quarter']);
  });

  it('draws a place or a prop once', () => {
    expect(ELEMENT_VIEWS).toEqual({ location: ['establishing'], prop: ['detail'], style: ['custom'] });
    const barn = f.element({ kind: 'location', name: 'Red barn' });
    const req = compileElementReferenceRequest(barn, 'establishing', { screenplay: null, settings });
    expect((req.input[0] as { text: string }).text).toContain('establishing wide shot of the place, empty');
  });
});

describe('the video reads its first frame (docs/design/first-pass.md#the-video-reads-its-first-frame)', () => {
  const settings = ProjectSettingsSchema.parse({ generation: { promptVersion: 2 } });
  const shot = f.shot({
    description: 'Rosie at the closed gate, frame left',
    action: 'Rosie opens the gate',
  });
  const ctx: ShotContext = { shot, characters: [], screenplay: null, settings };
  const seen = { description: 'Rosie at the open gate, frame right', action: 'Rosie walks through the gate' };

  it("describes the frame as drawn in the video prompt, never in the keyframe's", () => {
    const video = compileShotPrompt({ ...ctx, frameSeen: seen }, 'video');
    expect(video).toContain('Rosie at the open gate, frame right.');
    expect(video).toContain('Action: Rosie walks through the gate.');
    expect(video).not.toContain('closed gate');
    const keyframe = compileShotPrompt({ ...ctx, frameSeen: seen }, 'keyframe');
    expect(keyframe).toContain('Rosie at the closed gate, frame left.');
  });

  it("keeps the plan's words without a reading, and a person's prompt over both", () => {
    expect(compileShotPrompt(ctx, 'video')).toContain('Rosie at the closed gate, frame left.');
    const own = compileShotPrompt(
      { ...ctx, shot: { ...shot, promptOverride: 'A gate' }, frameSeen: seen },
      'video',
    );
    expect(own).toContain('A gate.');
    expect(own).not.toContain('open gate');
  });
});

describe('framings spelled out (docs/design/first-pass.md#framings-spelled-out)', () => {
  const shot = f.shot({ camera: { framing: 'close_up', movement: 'static' } });
  const at = (promptVersion: 2 | 3) => ({
    shot,
    characters: [],
    screenplay: null,
    settings: ProjectSettingsSchema.parse({ generation: { promptVersion } }),
  });

  it('says what a version 3 keyframe keeps in the picture, and leaves version 2 and videos as they were', () => {
    expect(compileShotPrompt(at(3), 'keyframe')).toContain(
      'Camera: close-up: the face and the top of the shoulders fill the frame',
    );
    expect(compileShotPrompt(at(2), 'keyframe')).toContain('Camera: close-up');
    expect(compileShotPrompt(at(2), 'keyframe')).not.toContain('fill the frame');
    expect(compileShotPrompt(at(3), 'video')).toContain('Camera: close-up,');
  });
});

describe('close framings drawn from the head and shoulders (docs/design/first-pass.md#framings-spelled-out)', () => {
  const close = f.shot({ camera: { framing: 'close_up', movement: 'static' } });
  const wide = f.shot({ camera: { framing: 'wide', movement: 'static' } });
  const v = (promptVersion: 2 | 3) => ProjectSettingsSchema.parse({ generation: { promptVersion } });

  it('crops whole figures for close framings of version 3 only', () => {
    expect(CLOSE_FRAMINGS).toEqual(['close_up', 'extreme_close_up', 'medium_close']);
    expect(headCropped({ shot: close, settings: v(3) })).toBe(true);
    expect(headCropped({ shot: close, settings: v(2) })).toBe(false);
    expect(headCropped({ shot: wide, settings: v(3) })).toBe(false);
  });

  it('labels a cropped whole figure as the head and shoulders', () => {
    const rosie = f.character({ name: 'Rosie' });
    const selection = {
      perCharacter: [{ characterId: rosie.id, refs: [{ ...f.reference({ view: 'full_body' }) }] }],
      needsSheet: false,
      perElement: [],
      elementSheet: false,
    };
    expect(referenceLabels(selection, [rosie], [], { headCrop: true })).toEqual([
      'Rosie (head and shoulders)',
    ]);
    expect(referenceLabels(selection, [rosie], [])).toEqual(['Rosie (full body view)']);
  });
});

describe('the brief adapted for the video model (docs/design/first-pass.md#the-brief-adapted-for-the-video-model)', () => {
  const project = (prompt: string, adaptedOf: string | null) =>
    f.project({
      brief: {
        prompt,
        attachmentResourceIds: [],
        adapted: adaptedOf
          ? {
              of: adaptedOf,
              prompt: 'They ride along the far fence.',
              moments: [],
              model: null,
              at: '2026-10-30T00:00:00.000Z',
            }
          : null,
      },
    });

  it('works from the adaptation while it adapts the brief as it is, else from the brief', () => {
    const brief = 'Two riders side by side over a pole.';
    expect(workingBrief(project(brief, briefHash(brief)))).toBe('They ride along the far fence.');
    expect(briefAdaptation(project(`${brief} At sunset.`, briefHash(brief)))).toBeNull();
    expect(workingBrief(project(`${brief} At sunset.`, briefHash(brief)))).toBe(`${brief} At sunset.`);
    expect(workingBrief(project(brief, null))).toBe(brief);
    expect(briefHash(` ${brief} `)).toBe(briefHash(brief));
  });
});
