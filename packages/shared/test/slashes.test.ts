import { describe, expect, it } from 'vitest';
import { parseApiBase, withoutEdgeSlashes, withoutTrailingSlashes } from '../src';

/** Slashes trimmed from URLs and paths in time linear in their length (docs/design/settings.md#where-values-come-from). */
describe('trimming slashes', () => {
  it('drops the trailing slashes, or the leading and trailing ones', () => {
    expect(withoutTrailingSlashes('/a/b//')).toBe('/a/b');
    expect(withoutTrailingSlashes('https://example.com/')).toBe('https://example.com');
    expect(withoutTrailingSlashes('/a//b')).toBe('/a//b');
    expect(withoutTrailingSlashes('///')).toBe('');
    expect(withoutTrailingSlashes('')).toBe('');
    expect(withoutEdgeSlashes('//a/b/')).toBe('a/b');
    expect(withoutEdgeSlashes('a//b')).toBe('a//b');
    expect(withoutEdgeSlashes('///')).toBe('');
    expect(withoutEdgeSlashes('')).toBe('');
  });

  it('takes time linear in a run of slashes', () => {
    // `/\/+$/` and `/^\/+|\/+$/g` take about 17 s on each: quadratic in a run of slashes before another character
    const run = '/'.repeat(200_000);
    const started = performance.now();
    expect(withoutTrailingSlashes(`${run}x`)).toBe(`${run}x`);
    expect(withoutTrailingSlashes(`/a${run}`)).toBe('/a');
    expect(withoutEdgeSlashes(`${run}x${run}y${run}`)).toBe(`x${run}y`);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it('reads an API base URL in time linear in its length (docs/design/settings.md#api-base-url)', () => {
    const run = '/'.repeat(200_000);
    const started = performance.now();
    expect(parseApiBase(`https://api.example.com${run}v1${run}x`)).toEqual({
      domain: 'api.example.com',
      origin: 'https://api.example.com',
      prefix: `v1${run}x`,
    });
    expect(parseApiBase(`https://api.example.com/v1${run}`)?.prefix).toBe('v1');
    expect(performance.now() - started).toBeLessThan(1000);
  });
});
