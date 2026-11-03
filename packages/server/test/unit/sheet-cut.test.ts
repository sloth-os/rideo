import { describe, expect, it } from 'vitest';
import { gutterSpans } from '../../src/media/sheet';

describe('scene sheets cut into panels (docs/design/storyboard.md#scene-sheets)', () => {
  it('finds the panels between the gutters, and equal cells when there are none', () => {
    const profile = [1, 1, 0.2, 0.3, 0.1, 1, 0.95, 0.4, 0.2, 0.3, 1, 1];
    expect(gutterSpans(profile, 2)).toEqual({
      found: true,
      spans: [
        [2, 5],
        [7, 10],
      ],
    });
    // A speck of colour in a gutter is not a panel
    expect(gutterSpans([1, 0.2, 0.2, 0.2, 1, 0.5, 1, 0.2, 0.2, 0.2, 1], 2).found).toBe(true);
    expect(gutterSpans(new Array(12).fill(0.1), 3)).toEqual({
      found: false,
      spans: [
        [0, 4],
        [4, 8],
        [8, 12],
      ],
    });
  });
});
