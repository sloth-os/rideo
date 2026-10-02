import { describe, expect, it } from 'vitest';
import {
  bm25,
  cosine,
  frameKey,
  frameTimes,
  planIndex,
  type Resource,
  rankEntries,
  type SearchEntry,
  SearchQuerySchema,
  searchLabel,
  searchNames,
  searchTargets,
  terms,
} from '../src';
import * as f from '../src/testing/fixtures';

const hash = (c: string) => c.repeat(64);
const resource = (over: Partial<Resource> & Pick<Resource, 'id' | 'kind'>): Resource => ({
  role: 'source',
  name: over.id,
  media: f.media(),
  createdAt: '2026-10-02T00:00:00.000Z',
  origin: 'upload',
  status: 'ready',
  ...over,
});
const entry = (over: Partial<SearchEntry> & Pick<SearchEntry, 'caption'>): SearchEntry => {
  const media = over.media ?? f.media({ hash: hash('a') });
  const at = over.at ?? 0;
  return {
    key: frameKey(media, at),
    source: { kind: 'resource', resourceId: 'res_000000000001' },
    media,
    at,
    names: [],
    vector: null,
    ...over,
  };
};

describe('what search indexes (docs/design/search.md#the-index)', () => {
  it('samples three frames of a take, one every 4 s of footage (at most 60), and stills once', () => {
    expect(frameTimes({ mime: 'video/mp4', durationSec: 6 }, 'take')).toEqual([0.9, 3, 5.1]);
    expect(frameTimes({ mime: 'video/mp4', durationSec: 8 }, 'footage')).toEqual([2, 6]);
    expect(frameTimes({ mime: 'video/mp4', durationSec: 3 }, 'footage')).toEqual([1.5]);
    const long = frameTimes({ mime: 'video/mp4', durationSec: 3600 }, 'footage');
    expect(long).toHaveLength(60);
    expect(long[0]).toBe(30);
    expect(frameTimes({ mime: 'image/png' }, 'footage')).toEqual([0]);
    expect(frameTimes({ mime: 'video/mp4' }, 'take')).toEqual([0]);
  });

  it("covers every take, ready footage and stills, and approved references, with who they're known to show", () => {
    const mira = f.character({ id: 'chr_00000000mira', name: 'Mira' });
    mira.identity = { ...mira.identity, age: '30s', gender: 'woman', hair: 'short black hair' };
    mira.references = [
      { ...f.reference(), id: 'ref_000000000001', approved: true },
      { ...f.reference(), id: 'ref_000000000002', approved: false },
    ];
    const lantern = f.element({
      id: 'elm_0000lantern',
      name: 'Lantern',
      aliases: ['the lamp'],
      references: [],
    });
    const take = f.take({ id: 'tak_000000000001', video: f.media({ hash: hash('b'), durationSec: 4 }) });
    const docs = {
      characters: { [mira.id]: mira },
      elements: { [lantern.id]: lantern },
      clips: {
        clp_000000000001: f.clip({
          id: 'clp_000000000001',
          shots: [
            f.shot({
              id: 'sht_000000000001',
              characterIds: [mira.id],
              elementIds: [lantern.id],
              takes: [take, f.take({ id: 'tak_000000000002', video: null })],
            }),
          ],
        }),
      },
      resources: {
        res_000000000001: resource({
          id: 'res_000000000001',
          kind: 'video',
          media: f.media({ hash: hash('c'), durationSec: 8 }),
        }),
        res_000000000002: resource({
          id: 'res_000000000002',
          kind: 'image',
          media: f.media({ hash: hash('d'), mime: 'image/png' }),
        }),
        res_000000000003: resource({ id: 'res_000000000003', kind: 'audio' }),
        res_000000000004: resource({ id: 'res_000000000004', kind: 'video', status: 'processing' }),
      },
    };
    const targets = searchTargets(docs);
    expect(targets.map((t) => [t.source.kind, t.at])).toEqual([
      ['take', 0.6],
      ['take', 2],
      ['take', 3.4],
      ['resource', 2],
      ['resource', 6],
      ['resource', 0],
      ['reference', 0],
    ]);
    expect(targets[0]).toMatchObject({
      kind: 'take',
      names: ['Mira', 'Lantern'],
      known: [{ name: 'Mira', description: expect.stringContaining('30s woman') }, { name: 'Lantern' }],
    });
    expect(targets[5]!.kind).toBe('still');
    expect(targets[6]).toMatchObject({ names: ['Mira'], source: { characterId: mira.id } });
    expect(searchNames(docs)).toEqual(['Mira', 'Lantern', 'the lamp']);
    expect(searchLabel(docs as never, targets[0]!.source)).toMatch(/^Clip 1 · shot 1: /);
    expect(searchLabel(docs as never, targets[6]!.source)).toBe('Mira (reference)');
  });

  it('plans a run: drops entries whose source left, copies captions of frames it knows, captions the rest', () => {
    const media = f.media({ hash: hash('e'), durationSec: 8 });
    const known = entry({ media, at: 2, caption: 'A harbour at dawn', vector: [1, 0] });
    const gone = entry({
      media: f.media({ hash: hash('f') }),
      source: { kind: 'resource', resourceId: 'res_00000000gone' },
      caption: 'Gone',
    });
    const targets = [
      { ...known, kind: 'footage' as const, known: [] },
      // the same file as another resource: its caption is copied, not asked for again
      {
        ...known,
        source: { kind: 'resource' as const, resourceId: 'res_000000000002' },
        kind: 'footage' as const,
        known: [],
      },
      { ...entry({ media, at: 6, caption: 'x' }), kind: 'footage' as const, known: [] },
      { ...entry({ media: f.media({ hash: hash('9') }), caption: 'x' }), kind: 'still' as const, known: [] },
    ];
    const plan = planIndex(
      { entries: [known, gone], failed: [frameKey(f.media({ hash: hash('9') }), 0)] },
      targets,
    );
    expect(plan.keep).toHaveLength(1);
    expect(plan.dropped).toBe(1);
    expect(plan.copied).toEqual([
      expect.objectContaining({ caption: 'A harbour at dawn', vector: [1, 0], source: targets[1]!.source }),
    ]);
    // the failed still is not tried again
    expect(plan.todo.map((t) => t.at)).toEqual([6]);
  });
});

describe('searching (docs/design/search.md#searching)', () => {
  it('keeps names as single terms and stems the rest', () => {
    expect(terms("Old Tom's lanterns glowing at night", ['Old Tom', 'Tom'])).toEqual([
      'name:old tom',
      'lantern',
      'glow',
      'night',
    ]);
  });

  it('ranks by words with BM25, and by meaning with cosine similarity', () => {
    const scores = bm25(
      [['harbour', 'dawn'], ['harbour', 'night', 'harbour'], ['field']],
      ['harbour', 'night'],
    );
    expect(scores[1]).toBeGreaterThan(scores[0]!);
    expect(scores[2]).toBe(0);
    expect(cosine([1, 0], [1, 0])).toBe(1);
    expect(cosine([1, 0], [0, 1])).toBe(0);
    expect(cosine([1, 0], [0, 0])).toBe(0);
  });

  const a = f.media({ hash: hash('a'), durationSec: 12 });
  const b = f.media({ hash: hash('b'), durationSec: 4 });
  const entries = [
    entry({ media: a, at: 2, caption: 'The harbour at dawn, wide shot', vector: [1, 0, 0] }),
    entry({ media: a, at: 6, caption: 'Boats in the harbour at night, wide shot', vector: [0.6, 0.8, 0] }),
    entry({ media: a, at: 10, caption: 'A field of wheat', vector: [0, 0, 1] }),
    entry({
      media: b,
      at: 2,
      caption: 'A woman on the lighthouse stairs at night, close-up',
      names: ['Mira'],
      source: {
        kind: 'take',
        clipId: 'clp_000000000001',
        shotId: 'sht_000000000001',
        takeId: 'tak_000000000001',
      },
      vector: [0, 1, 0],
    }),
  ];

  it('returns the best frame of each file, filtered by kind', () => {
    const r = rankEntries(entries, 'harbour at night', { names: ['Mira'], limit: 10 });
    expect(r.map((x) => [x.entry.media.hash[0], x.entry.at])).toEqual([
      ['a', 6],
      ['b', 2],
    ]);
    expect(r[0]!.score).toBe(1);
    expect(rankEntries(entries, 'night', { names: [], kinds: ['take'], limit: 10 })).toHaveLength(1);
    expect(rankEntries(entries, 'submarine', { names: [], limit: 10 })).toEqual([]);
  });

  it('puts frames naming who the query names first', () => {
    // Mira is not in the caption, but the take's shot has her
    const r = rankEntries(entries, 'Mira at night', { names: ['Mira'], limit: 10 });
    expect(r[0]!.entry.source.kind).toBe('take');
    expect(r[0]!.named).toBe(1);
    expect(r[1]!.named).toBe(0);
  });

  it('ranks by meaning with a query vector, above a minimum similarity', () => {
    const r = rankEntries(entries, 'anything', { names: [], vector: [0.8, 0.6, 0], limit: 10 });
    expect(r.map((x) => [x.entry.media.hash[0], x.entry.at, x.score])).toEqual([
      ['a', 6, 0.96],
      ['b', 2, 0.6],
    ]);
  });

  it('parses queries from REST', () => {
    expect(SearchQuerySchema.parse({ q: ' boats ', kinds: 'take,reference', limit: '5' })).toEqual({
      q: 'boats',
      kinds: ['take', 'reference'],
      limit: 5,
    });
    expect(SearchQuerySchema.parse({ q: 'boats' }).limit).toBe(24);
    expect(SearchQuerySchema.safeParse({ q: 'x', kinds: 'clips' }).success).toBe(false);
  });
});
