import { describe, expect, it } from 'vitest';
import { byCount, LibraryKindSchema, plural, ResourceKindSchema, TrackSchema, withArticle } from '../src';

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

/** A count agrees with its noun and its verb (docs/brand.md#voice). */
describe('plural and byCount', () => {
  it('writes 1 with the singular and every other count with the plural', () => {
    expect([0, 1, 2, 12].map((n) => plural(n, 'shot'))).toEqual(['0 shots', '1 shot', '2 shots', '12 shots']);
    expect([1, 2].map((n) => plural(n, 'person', 'people'))).toEqual(['1 person', '2 people']);
    expect([1, 2].map((n) => plural(n, 'location or prop', 'locations or props'))).toEqual([
      '1 location or prop',
      '2 locations or props',
    ]);
  });

  it('chooses the word after a count by the same rule', () => {
    const line = (n: number) => `${plural(n, 'line')} ${byCount(n, 'is', 'are')} too long`;
    expect([0, 1, 2].map(line)).toEqual([
      '0 lines are too long',
      '1 line is too long',
      '2 lines are too long',
    ]);
  });
});
