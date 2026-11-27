import { describe, expect, it } from 'vitest';
import { CameraPatchSchema, CameraSchema, ShotUpdateInputSchema } from '../src';

/**
 * A shot's PATCH (docs/api/rest.md, `shot_update`): a partial camera changes only the fields it names. The shot keeps
 * the others, its planned framing and movement too (docs/design/director-desk.md#the-result).
 */
describe('the shot update schema', () => {
  it('keeps a partial camera to the fields it names: no framing or movement filled in with defaults', () => {
    expect(ShotUpdateInputSchema.parse({ camera: { lensMm: 35, move: 'push_in' } }).camera).toStrictEqual({
      lensMm: 35,
      move: 'push_in',
    });
    expect(ShotUpdateInputSchema.parse({ camera: { lensMm: 50 } }).camera).toStrictEqual({ lensMm: 50 });
    expect(ShotUpdateInputSchema.parse({ camera: {} }).camera).toStrictEqual({});
    expect(ShotUpdateInputSchema.parse({ camera: { framing: 'close_up' } }).camera).toStrictEqual({
      framing: 'close_up',
    });
    expect(ShotUpdateInputSchema.parse({ description: 'x' })).toStrictEqual({ description: 'x' });
    // the shot's own camera schema still has its defaults
    expect(CameraSchema.parse({})).toMatchObject({ framing: 'medium', movement: 'static' });
  });

  it('refuses what the camera schema refuses', () => {
    expect(CameraPatchSchema.safeParse({ framing: 'very_wide' }).success).toBe(false);
    expect(CameraPatchSchema.safeParse({ movement: 'teleport' }).success).toBe(false);
    expect(ShotUpdateInputSchema.safeParse({ camera: { lensMm: 'long' } }).success).toBe(false);
    expect(CameraPatchSchema.safeParse({ framing: 'wide', movement: 'pan' }).data).toStrictEqual({
      framing: 'wide',
      movement: 'pan',
    });
  });
});
