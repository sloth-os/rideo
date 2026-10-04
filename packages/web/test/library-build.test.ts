// @vitest-environment node
import { describe, expect, it } from 'vitest';
// @ts-expect-error a plain ESM script of this package (no types)
import { scopeCss, scopeSelector } from '../scripts/scope-css.mjs';
import { sameOriginScript } from '../src/engine/ffmpeg';

describe('the library stylesheet, scoped to the container (docs/design/embedding.md#styles-scoped-to-the-container)', () => {
  it('scopes every selector to the studio root', () => {
    expect(scopeSelector('.flex')).toEqual(['.rideo-root .flex']);
    expect(scopeSelector('*')).toEqual(['.rideo-root *']);
    expect(scopeSelector(':root')).toEqual(['.rideo-root']);
    expect(scopeSelector(':host')).toEqual(['.rideo-root']);
    expect(scopeSelector('html')).toEqual(['.rideo-root']);
    expect(scopeSelector('body')).toEqual(['.rideo-root']);
    expect(scopeSelector('html:where(.dark)')).toEqual(['.rideo-root:where(.dark)']);
    expect(scopeSelector('htmlish')).toEqual(['.rideo-root htmlish']);
    expect(scopeSelector('[data-theme="light"]')).toEqual([
      '.rideo-root[data-theme="light"]',
      '.rideo-root [data-theme="light"]',
    ]);
    expect(scopeSelector('.rideo-root')).toEqual(['.rideo-root']);
    expect(scopeSelector('.rideo-root[data-theme=dark]')).toEqual(['.rideo-root[data-theme=dark]']);
    expect(scopeSelector('&:hover')).toEqual(['&:hover']);
    expect(scopeSelector('.hover\\:bg-accent:hover')).toEqual(['.rideo-root .hover\\:bg-accent:hover']);
  });

  it('flattens cascade layers in order and leaves keyframes and @property global', () => {
    const css = [
      '@layer theme, base, utilities;',
      '@layer theme { :root, :host { --x: 1 } }',
      '@layer base { *, ::before { margin: 0 } a { color: inherit } }',
      '@layer utilities { .p-2 { padding: 8px } @media (min-width: 40rem) { .sm\\:flex { display: flex } } }',
      '@keyframes spin { from { transform: rotate(0) } to { transform: rotate(1turn) } }',
      '@property --tw-x { syntax: "*"; inherits: false }',
      'body { margin: 0 }',
    ].join('\n');
    const out = scopeCss(css).replace(/\s+/g, ' ');
    expect(out).not.toContain('@layer');
    expect(out.indexOf('--x: 1')).toBeLessThan(out.indexOf('margin: 0'));
    expect(out.indexOf('margin: 0')).toBeLessThan(out.indexOf('padding: 8px'));
    expect(out).toContain('.rideo-root { --x: 1 }');
    expect(out).toContain('.rideo-root *, .rideo-root ::before { margin: 0 }');
    expect(out).toContain('.rideo-root a { color: inherit }');
    expect(out).toContain('@media (min-width: 40rem) { .rideo-root .sm\\:flex { display: flex } }');
    expect(out).toContain(
      '@keyframes spin { from { transform: rotate(0) } to { transform: rotate(1turn) } }',
    );
    expect(out).toContain('@property --tw-x');
    expect(out).toContain('.rideo-root { margin: 0 }');
  });
});

describe('ffmpeg workers from a host bundler (docs/design/embedding.md#package)', () => {
  it('turns an inlined data: script into a blob: URL of this origin, once, and keeps real URLs', async () => {
    const data = `data:text/javascript;base64,${Buffer.from('self.onmessage = () => {};').toString('base64')}`;
    const url = await sameOriginScript(data);
    expect(url).toMatch(/^blob:/);
    expect(await sameOriginScript(data)).toBe(url);
    expect(await (await fetch(url)).text()).toBe('self.onmessage = () => {};');
    expect(await sameOriginScript('/assets/worker-abc.js')).toBe('/assets/worker-abc.js');
  });
});
