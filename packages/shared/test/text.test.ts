import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
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

/**
 * The words of every package (`packages/*\/src`): no count hedges its plural ("shot(s)") and no count is followed by a
 * fixed plural noun and verb ("{n} lines are"). Comments are not words a person reads, so only string literals,
 * template texts and JSX texts are read.
 */
describe('count phrases in the sources', () => {
  const root = join(import.meta.dirname, '../..');
  const files = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory()
        ? files(join(dir, e.name))
        : /\.tsx?$/.test(e.name) && !e.name.endsWith('.d.ts')
          ? [join(dir, e.name)]
          : [],
    );
  const sources = readdirSync(root).flatMap((pkg) => {
    try {
      return files(join(root, pkg, 'src'));
    } catch {
      return [];
    }
  });
  /** "shot(s)", "frame(s)": a hedge, not a count (a URL scheme's "http(s)" is not one). */
  const HEDGE = /[a-z](?<!http)\(s\)/i;
  /** A count followed by a plural noun and a plural verb: " lines are", " frames wait". */
  const FIXED = /^ [a-z]+s (are|were|have|need|pass|wait|jump|fail|use)\b/;
  /** A file holds FIXED's shape only after the end of a substitution or a JSX expression: only those files are parsed. */
  const RAW_FIXED = /\} [a-z]+s (are|were|have|need|pass|wait|jump|fail|use)\b/;

  const found = (file: string) => {
    const text = readFileSync(file, 'utf8');
    if (!HEDGE.test(text) && !RAW_FIXED.test(text)) return [];
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const where = (node: ts.Node, what: string) =>
      `${relative(root, file)}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}: ${what}`;
    const out: string[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isJsxText(node)) {
        if (HEDGE.test(node.text)) out.push(where(node, node.text));
      }
      if (ts.isTemplateExpression(node)) {
        if (HEDGE.test(node.head.text)) out.push(where(node, node.head.text));
        for (const span of node.templateSpans) {
          const after = span.literal.text;
          if (HEDGE.test(after) || FIXED.test(after)) out.push(where(span, `{…}${after}`));
        }
      }
      if (ts.isJsxElement(node) || ts.isJsxFragment(node)) {
        const children = node.children;
        children.forEach((child, i) => {
          const next = children[i + 1];
          if (ts.isJsxExpression(child) && next && ts.isJsxText(next) && FIXED.test(next.text))
            out.push(where(next, `{…}${next.text}`));
        });
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    return out;
  };

  it('reads the sources of every package', () => {
    expect(sources.some((f) => f.includes('/server/src/'))).toBe(true);
    expect(sources.some((f) => f.includes('/web/src/'))).toBe(true);
    expect(sources.length).toBeGreaterThan(300);
  });

  it('finds no count that hedges its plural or keeps a plural noun and verb whatever the count', () => {
    expect(sources.flatMap(found)).toEqual([]);
  });

  it('would find both shapes', () => {
    const probe = join(import.meta.dirname, 'fixtures/count-phrases.tsx.txt');
    expect(found(probe).map((f) => f.replace(/^.*?: /, ''))).toEqual([
      '{…} scene(s) reviewed',
      '{…} lines are too long for their shots',
      '{…} frames are not indexed yet',
    ]);
  });
});
