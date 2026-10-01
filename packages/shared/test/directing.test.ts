import { describe, expect, it } from 'vitest';
import {
  boardPromptHash,
  CAMERA_MOVES,
  CameraMoveIdSchema,
  compileKeyframeRequest,
  compileShotPrompt,
  compileVideoRequest,
  lensFragment,
  ProjectSettingsSchema,
  ShotSchema,
  shotContextOf,
  shotSeed,
  VARIATION_SEED_STEP,
} from '../src';
import * as f from '../src/testing/fixtures';

const settings = ProjectSettingsSchema.parse({});
const ctx = (shot = f.shot()) => ({ shot, characters: [], screenplay: null, settings });

describe('camera controls (docs/design/directing.md)', () => {
  it('writes the lens and aperture', () => {
    expect(lensFragment({})).toBe('');
    expect(lensFragment({ lensMm: 85, aperture: 1.8 })).toBe('85mm lens, f/1.8 shallow depth of field');
    expect(lensFragment({ lensMm: 24, aperture: 11 })).toBe('24mm lens, f/11 deep focus');
    expect(lensFragment({ aperture: 4 })).toBe('f/4');
  });

  it('replaces the movement with the move phrase in videos, keeps the lens in keyframes', () => {
    const shot = f.shot({
      camera: { framing: 'close_up', movement: 'pan', move: 'push_in', lensMm: 85, aperture: 2 },
    });
    expect(compileShotPrompt(ctx(shot), 'video')).toContain(
      'Camera: close-up, slow push-in toward the subject; 85mm lens, f/2 shallow depth of field.',
    );
    expect(compileShotPrompt(ctx(shot), 'keyframe')).toContain(
      'Camera: close-up; 85mm lens, f/2 shallow depth of field.',
    );
    // without directing controls the prompt is unchanged
    expect(
      compileShotPrompt(ctx(f.shot({ camera: { framing: 'medium', movement: 'tracking' } })), 'video'),
    ).toContain('Camera: medium shot, tracking shot.');
    const locked = compileVideoRequest(
      ctx(f.shot({ camera: { framing: 'wide', movement: 'pan', move: 'locked_off' } })),
      {
        referenceUris: [],
        attempt: 0,
      },
    );
    expect(locked.parameters?.camera_motion).toBe('fixed');
    expect(CameraMoveIdSchema.safeParse('moonwalk').success).toBe(false);
    expect(new Set(CAMERA_MOVES.map((m) => m.id)).size).toBe(CAMERA_MOVES.length);
  });

  it('adds the last frame and the reference video only when the model takes them', () => {
    const shot = f.shot({ motionReference: { resourceId: 'res_0000000000aaaaaa', mode: 'camera' } });
    const full = compileVideoRequest(ctx(shot), {
      referenceUris: [],
      attempt: 0,
      firstFrameUri: 'data:first',
      lastFrameUri: 'data:last',
      referenceVideoUri: 'data:video',
    });
    expect(full.input.slice(1)).toEqual([
      { type: 'image', uri: 'data:first', role: 'first_frame' },
      { type: 'image', uri: 'data:last', role: 'last_frame' },
      { type: 'video', uri: 'data:video', role: 'reference_video' },
    ]);
    expect((full.input[0] as { text: string }).text).toContain(
      'Reproduce the camera movement of the reference video.',
    );
    const lite = compileVideoRequest(ctx(shot), {
      referenceUris: [],
      attempt: 0,
      lastFrameUri: 'data:last',
      referenceVideoUri: 'data:video',
      limits: { supports_last_frame: false, supports_reference_video: false },
    });
    expect(lite.input).toHaveLength(1);
    expect((lite.input[0] as { text: string }).text).not.toContain('reference video');
  });
});

describe('seeds and variations', () => {
  it('uses the fixed seed, offset by attempts and variations', () => {
    const shot = f.shot();
    const derived = shotSeed(shot, []);
    expect(shotSeed({ ...shot, seed: 4242 }, [])).toBe(4242);
    expect(shotSeed({ ...shot, seed: 4242 }, [], 1)).toBe(4242 + 7919);
    expect(shotSeed(shot, [], 0, 2)).toBe((derived + 2 * VARIATION_SEED_STEP) % 2147483647);
    const kf = compileKeyframeRequest(ctx({ ...shot, seed: 7 }), {
      referenceUris: [],
      attempt: 0,
      variation: 1,
    });
    expect(kf.parameters?.seed).toBe(7 + VARIATION_SEED_STEP);
  });
});

describe('shot documents', () => {
  it('read shots saved before the directing controls', () => {
    const { startFrame: _s, endFrame: _e, motionReference: _m, seed: _seed, ...legacy } = f.shot();
    const shot = ShotSchema.parse(legacy);
    expect(shot).toMatchObject({
      startFrame: { mode: 'auto', resourceId: null },
      endFrame: { mode: 'none', description: '', resourceId: null },
      motionReference: null,
      seed: null,
    });
  });

  it('marks storyboard frames outdated when the lens changes (the keyframe prompt)', () => {
    const docs = f.docs();
    const shot = f.shot();
    const before = boardPromptHash(shotContextOf(shot, docs));
    expect(
      boardPromptHash(shotContextOf({ ...shot, camera: { ...shot.camera, lensMm: 35 } }, docs)),
    ).not.toBe(before);
    // the move only affects the video
    expect(
      boardPromptHash(shotContextOf({ ...shot, camera: { ...shot.camera, move: 'whip_pan' } }, docs)),
    ).toBe(before);
  });
});
