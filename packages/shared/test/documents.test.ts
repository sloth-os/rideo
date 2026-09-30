import { describe, expect, it } from 'vitest';
import {
  applyDocChanges,
  canonicalJson,
  DocValidationError,
  docPath,
  docSpecForPath,
  docsFromEntries,
  isId,
  jsonDiff,
  newId,
  renderScreenplayMarkdown,
  slugify,
  validateDoc,
} from '../src';
import * as f from '../src/testing/fixtures';

describe('ids', () => {
  it('generates prefixed, time-sortable ids', () => {
    const a = newId('clip', 1_000);
    const b = newId('clip', 2_000);
    expect(a).toMatch(/^clp_[0-9a-z]{16}$/);
    expect(a < b).toBe(true);
    expect(isId(a, 'clip')).toBe(true);
    expect(isId(a, 'shot')).toBe(false);
    expect(isId('../etc/passwd')).toBe(false);
  });
});

describe('document registry', () => {
  it('maps paths to schemas and checks embedded ids', () => {
    const c = f.character();
    expect(docSpecForPath(docPath.character(c.id))).toMatchObject({ kind: 'character', id: c.id });
    expect(docSpecForPath('characters/../x.json')).toBeNull();
    expect(validateDoc(docPath.character(c.id), c)).toMatchObject({ id: c.id });
    expect(() => validateDoc(docPath.character(newId('character')), c)).toThrow(DocValidationError);
    expect(() => validateDoc('project.json', { ...f.project(), title: '' })).toThrow(/title/);
    expect(() => validateDoc('nope.json', {})).toThrow(/unknown document path/);
  });

  it('applies changes immutably', () => {
    const d = f.docs();
    const c = f.character();
    const next = applyDocChanges(d, { [docPath.character(c.id)]: c, 'screenplay.json': f.screenplay() });
    expect(next.characters[c.id]).toBe(c);
    expect(d.characters[c.id]).toBeUndefined();
    const removed = applyDocChanges(next, { [docPath.character(c.id)]: null, 'screenplay.json': null });
    expect(removed.characters).toEqual({});
    expect(removed.screenplay).toBeNull();
    const rebuilt = docsFromEntries([
      ['project.json', d.project],
      [docPath.character(c.id), c],
    ]);
    expect(rebuilt.characters[c.id]).toEqual(c);
  });
});

describe('canonical json and diff', () => {
  it('sorts keys and drops undefined', () => {
    expect(canonicalJson({ b: 1, a: { d: undefined, c: [3, { z: 1, y: 2 }] } })).toBe(
      '{"a":{"c":[3,{"y":2,"z":1}]},"b":1}',
    );
  });

  it('diffs objects and id-keyed arrays', () => {
    const before = {
      title: 'A',
      scenes: [
        { id: 's1', text: 'x' },
        { id: 's2', text: 'y' },
      ],
      tags: ['a'],
    };
    const after = {
      title: 'B',
      scenes: [
        { id: 's2', text: 'y2' },
        { id: 's3', text: 'z' },
      ],
      tags: ['a', 'b'],
    };
    expect(jsonDiff(before, after)).toEqual([
      { op: 'remove', pointer: '/scenes/[id=s1]', before: { id: 's1', text: 'x' } },
      { op: 'replace', pointer: '/scenes/[id=s2]/text', before: 'y', after: 'y2' },
      { op: 'add', pointer: '/scenes/[id=s3]', after: { id: 's3', text: 'z' } },
      { op: 'add', pointer: '/tags/1', after: 'b' },
      { op: 'replace', pointer: '/title', before: 'A', after: 'B' },
    ]);
    expect(jsonDiff({ a: 1 }, { a: 1 })).toEqual([]);
  });
});

describe('screenplay markdown', () => {
  it('renders scenes, dialogue with cast names and the outline', () => {
    const mira = f.character();
    const sp = f.screenplay({
      outline: [
        {
          id: newId('beat'),
          index: 0,
          title: 'Arrival',
          summary: 'Mira arrives.',
          estDurationSec: 90,
          sceneId: null,
        },
      ],
      scenes: [
        {
          id: newId('scene'),
          index: 0,
          beatId: null,
          heading: 'Int. lighthouse - night',
          location: 'lighthouse',
          timeOfDay: 'night',
          summary: 'The letter.',
          action: 'Wind howls.',
          dialogue: [{ characterId: mira.id, character: 'M', line: 'Who is there?' }],
          characterIds: [mira.id],
          estDurationSec: 60,
        },
      ],
    });
    const md = renderScreenplayMarkdown(sp, { [mira.id]: mira });
    expect(md).toContain('# The Keeper');
    expect(md).toContain('### 1. INT. LIGHTHOUSE - NIGHT');
    expect(md).toContain('**MIRA**');
    expect(md).toContain('1. **Arrival** — Mira arrives. _(1:30)_');
    expect(slugify('Élan — Vital!')).toBe('elan-vital');
  });
});
