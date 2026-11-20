import { describe, expect, it } from 'vitest';
import { LibraryKindSchema, ResourceKindSchema, TrackSchema, withArticle } from '../src';

/** Messages name a kind with its article ("an audio resource", "a video track"). */
describe('withArticle', () => {
  it('gives every kind a message names after an article the article it is read with', () => {
    const said: Record<string, string> = {
      image: 'an image',
      video: 'a video',
      audio: 'an audio',
      lut: 'a lut',
      character: 'a character',
      element: 'an element',
      resource: 'a resource',
      'desk-set': 'a desk-set',
      'desk-prop': 'a desk-prop',
      'desk-figure': 'a desk-figure',
      text: 'a text',
    };
    const kinds = [
      ...ResourceKindSchema.options,
      ...LibraryKindSchema.options,
      ...TrackSchema.shape.kind.options,
    ];
    // a kind added later is named here too, with the article it is read with
    for (const kind of kinds) expect(`${kind}: ${withArticle(kind)}`).toBe(`${kind}: ${said[kind]}`);
    expect(withArticle('Audio')).toBe('an Audio');
  });
});
