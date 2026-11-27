import type { Resource } from '@rideo/shared';
import * as f from '@rideo/shared/testing';
import { describe, expect, it } from 'vitest';
import { assertDirectingResources } from '../../src/domain/clips';

/** A shot's frames are image resources and its motion reference a video one (docs/design/directing.md). */
describe('the resources a shot is directed with', () => {
  it('names the kind it needs with its article', () => {
    const take: Resource = {
      id: 'res_take00000001',
      kind: 'video',
      role: 'reference',
      name: 'take.mp4',
      media: f.media(),
      createdAt: '2026-11-20T10:00:00.000Z',
      origin: 'upload',
      status: 'ready',
    };
    const resource = (id: string | null | undefined) => (id === take.id ? take : null);
    const refusal = (shot: Parameters<typeof assertDirectingResources>[0]) => {
      try {
        assertDirectingResources(shot, resource);
        return 'ok';
      } catch (err) {
        return (err as Error).message;
      }
    };
    expect(refusal({ startFrame: { mode: 'resource', resourceId: null } })).toBe(
      'the start frame: choose an image resource',
    );
    expect(refusal({ endFrame: { mode: 'resource', resourceId: take.id } } as never)).toBe(
      'the end frame must be an image resource, not video',
    );
    expect(refusal({ motionReference: { resourceId: null } } as never)).toBe(
      'the motion reference: choose a video resource',
    );
    expect(refusal({ motionReference: { resourceId: take.id } } as never)).toBe('ok');
  });
});
