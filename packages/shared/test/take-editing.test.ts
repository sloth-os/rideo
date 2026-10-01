import { describe, expect, it } from 'vitest';
import {
  compileEditRequest,
  compileExtendRequest,
  EditKindSchema,
  ProjectSettingsSchema,
  TakeSchema,
} from '../src';
import * as f from '../src/testing/fixtures';

const settings = ProjectSettingsSchema.parse({});
const ctx = { shot: f.shot(), characters: [], screenplay: null, settings };

describe('take edits (docs/design/take-editing.md)', () => {
  it('sends the take as the reference video with the instruction and the cast references', () => {
    const req = compileEditRequest(ctx, {
      kind: 'remove',
      instruction: 'the lamp post on the left.',
      takeUri: 'data:take',
      referenceUris: ['data:mira'],
      durationSec: 6,
      attempt: 0,
      model: 'edit-model',
    });
    expect(req.model).toBe('edit-model');
    expect(req.input).toEqual([
      {
        type: 'text',
        text: 'Remove the lamp post on the left from the video and fill the background naturally. Keep everything else unchanged.',
      },
      { type: 'video', uri: 'data:take', role: 'reference_video' },
      { type: 'image', uri: 'data:mira', role: 'reference_image' },
    ]);
    expect(req.parameters).toMatchObject({ duration_seconds: 6, include_audio: false });
    // without reference images for models that do not take them
    const bare = compileEditRequest(ctx, {
      kind: 'restyle',
      instruction: 'film noir',
      takeUri: 'data:take',
      referenceUris: ['data:mira'],
      durationSec: 6,
      attempt: 1,
      limits: { supports_reference_image: false },
    });
    expect(bare.input).toHaveLength(2);
    expect(bare.parameters?.seed).not.toBe(req.parameters?.seed);
    expect(EditKindSchema.options).toEqual(['restyle', 'relight', 'replace', 'angle', 'remove']);
  });
});

describe('extensions', () => {
  it('continues from the first frame, or leads into the last frame, for the requested seconds', () => {
    const after = compileExtendRequest(ctx, {
      seconds: 3,
      prompt: 'she turns to the window',
      firstFrameUri: 'data:last-of-take',
      referenceUris: [],
      attempt: 0,
    });
    expect((after.input[0] as { text: string }).text).toMatch(
      /Continue the action seamlessly from the first frame: she turns to the window\.$/,
    );
    expect(after.input[1]).toEqual({ type: 'image', uri: 'data:last-of-take', role: 'first_frame' });
    expect(after.parameters).toMatchObject({ duration_seconds: 4, include_audio: false });
    const before = compileExtendRequest(ctx, {
      seconds: 5,
      lastFrameUri: 'data:first',
      referenceUris: [],
      attempt: 0,
    });
    expect((before.input[0] as { text: string }).text).toMatch(/Lead into the last frame seamlessly\.$/);
    expect(before.input[1]).toMatchObject({ role: 'last_frame' });
    expect(before.parameters?.duration_seconds).toBe(5);
  });

  it('reads takes saved before lineage', () => {
    const { derivedFrom: _d, ...legacy } = f.take();
    expect(TakeSchema.parse(legacy).derivedFrom).toBeNull();
  });
});
