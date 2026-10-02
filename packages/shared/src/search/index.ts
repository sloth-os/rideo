import type { MediaRef } from '../schemas/common';
import type { ProjectDocs } from '../schemas/documents';
import type {
  FrameCaptionInput,
  SearchEntry,
  SearchIndex,
  SearchKind,
  SearchSource,
} from '../schemas/search';
import { isStillMedia } from '../timeline/query';

/** Which frames are sampled (docs/design/search.md#the-index). */
export const SEARCH_FRAMES = {
  /** Fractions of a take. */
  take: [0.15, 0.5, 0.85],
  /** One frame per this many seconds of footage... */
  everySec: 4,
  /** ...and at most this many per file. */
  maxPerFile: 60,
} as const;

/** Below this similarity a frame does not match a query (semantic search). */
export const SEMANTIC_MIN_SCORE = 0.2;

const round = (t: number) => Math.round(t * 100) / 100;

/** The times sampled from a media file: three of a take, one every 4 s of footage (centred), 0 for a still. */
export function frameTimes(
  media: Pick<MediaRef, 'mime' | 'durationSec'>,
  kind: 'take' | 'footage',
): number[] {
  if (isStillMedia(media)) return [0];
  const d = media.durationSec ?? 0;
  if (d <= 0) return [0];
  if (kind === 'take') return [...new Set(SEARCH_FRAMES.take.map((f) => round(d * f)))];
  const n = Math.max(1, Math.min(SEARCH_FRAMES.maxPerFile, Math.floor(d / SEARCH_FRAMES.everySec)));
  return Array.from({ length: n }, (_, i) => round((d / n) * (i + 0.5)));
}

export const frameKey = (media: Pick<MediaRef, 'hash'>, at: number) => `${media.hash}@${round(at)}`;

/** The id of what a frame is from: the take, resource or reference. */
export function sourceId(s: SearchSource): string {
  return s.kind === 'take' ? s.takeId : s.kind === 'resource' ? s.resourceId : s.referenceId;
}

/** An entry's identity in the index: a frame of a source (two sources can show the same file). */
export const entryId = (e: Pick<SearchEntry, 'source' | 'key'>) => `${sourceId(e.source)}|${e.key}`;

/** A frame to index. */
export interface SearchTarget {
  source: SearchSource;
  media: MediaRef;
  at: number;
  key: string;
  names: string[];
  /** For the caption: what the frame is from. */
  kind: FrameCaptionInput['kind'];
  /** Who and what the source is known to show, with how they look. */
  known: FrameCaptionInput['known'];
}

type IndexedDocs = Pick<ProjectDocs, 'clips' | 'resources' | 'characters' | 'elements'>;

/**
 * Every frame search covers (docs/design/search.md#the-index): all takes of every shot, ready footage, video and
 * image resources, and approved character and element references.
 */
export function searchTargets(docs: IndexedDocs): SearchTarget[] {
  const out: SearchTarget[] = [];
  const character = (id: string) => {
    const c = docs.characters[id];
    if (!c) return null;
    const i = c.identity;
    const looks = [
      [i.age, i.gender].filter(Boolean).join(' '),
      i.build,
      i.face,
      i.hair,
      i.distinguishingMarks,
    ];
    return { name: c.name, description: looks.filter(Boolean).join('; ').slice(0, 400) };
  };
  const element = (id: string) => {
    const e = docs.elements[id];
    return e ? { name: e.name, description: e.description.slice(0, 400) } : null;
  };
  for (const clip of Object.values(docs.clips)) {
    for (const shot of clip.shots) {
      const known = [...shot.characterIds.map(character), ...shot.elementIds.map(element)].filter(
        (k): k is { name: string; description: string } => !!k,
      );
      for (const take of shot.takes) {
        if (!take.video) continue;
        for (const at of frameTimes(take.video, 'take'))
          out.push({
            source: { kind: 'take', clipId: clip.id, shotId: shot.id, takeId: take.id },
            media: take.video,
            at,
            key: frameKey(take.video, at),
            names: known.map((k) => k.name),
            kind: 'take',
            known,
          });
      }
    }
  }
  for (const r of Object.values(docs.resources)) {
    if (r.status !== 'ready' || (r.kind !== 'video' && r.kind !== 'image')) continue;
    const still = r.kind === 'image' || isStillMedia(r.media);
    for (const at of still ? [0] : frameTimes(r.media, 'footage'))
      out.push({
        source: { kind: 'resource', resourceId: r.id },
        media: r.media,
        at,
        key: frameKey(r.media, at),
        names: [],
        kind: still ? 'still' : 'footage',
        known: [],
      });
  }
  for (const c of Object.values(docs.characters)) {
    const known = [character(c.id)!];
    for (const ref of c.references)
      if (ref.approved)
        out.push({
          source: { kind: 'reference', characterId: c.id, referenceId: ref.id },
          media: ref.media,
          at: 0,
          key: frameKey(ref.media, 0),
          names: [c.name],
          kind: 'reference',
          known,
        });
  }
  for (const e of Object.values(docs.elements)) {
    const known = [element(e.id)!];
    for (const ref of e.references)
      if (ref.approved)
        out.push({
          source: { kind: 'reference', elementId: e.id, referenceId: ref.id },
          media: ref.media,
          at: 0,
          key: frameKey(ref.media, 0),
          names: [e.name],
          kind: 'reference',
          known,
        });
  }
  return out;
}

/** The names searches know as single terms: the cast, and the elements with their aliases. */
export function searchNames(docs: Pick<ProjectDocs, 'characters' | 'elements'>): string[] {
  return [
    ...Object.values(docs.characters).map((c) => c.name),
    ...Object.values(docs.elements).flatMap((e) => [e.name, ...e.aliases]),
  ];
}

/**
 * The work an index run does (docs/design/search.md#indexing): entries whose source or media left the project are
 * dropped, frames already captioned for another source are copied, and the rest are to caption.
 */
export function planIndex(
  index: Pick<SearchIndex, 'entries' | 'failed'>,
  targets: SearchTarget[],
): { keep: SearchEntry[]; copied: SearchEntry[]; todo: SearchTarget[]; dropped: number } {
  const wanted = new Map(targets.map((t) => [entryId(t), t]));
  const keep = index.entries
    .filter((e) => wanted.has(entryId(e)))
    // a source's names change with its shot's cast
    .map((e) => ({ ...e, names: wanted.get(entryId(e))!.names }));
  const have = new Set(keep.map(entryId));
  const captions = new Map(index.entries.map((e) => [e.key, e]));
  const failed = new Set(index.failed);
  const copied: SearchEntry[] = [];
  const todo: SearchTarget[] = [];
  for (const t of targets) {
    if (have.has(entryId(t))) continue;
    const known = captions.get(t.key);
    if (known)
      copied.push({
        key: t.key,
        source: t.source,
        media: t.media,
        at: t.at,
        caption: known.caption,
        names: t.names,
        vector: known.vector,
      });
    else if (!failed.has(t.key)) todo.push(t);
  }
  return { keep, copied, todo, dropped: index.entries.length - keep.length };
}

const STOP = new Set(
  'a an the of in on at to and or with by for from is are was were be been it its this that these those as into onto over under near who what where which some any anyone someone something show shows find me my our their his her them they he she there here'.split(
    ' ',
  ),
);

/** A light stemmer: plurals and -ing forms meet their word. */
export function stem(w: string): string {
  if (w.length > 5 && w.endsWith('ing')) return w.slice(0, -3);
  if (w.length > 4 && w.endsWith('ies')) return `${w.slice(0, -3)}y`;
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') && !w.endsWith('us')) return w.slice(0, -1);
  return w;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The terms of a text: the names given become single terms (`name:<name>`), the rest stemmed words. */
export function terms(text: string, names: readonly string[] = []): string[] {
  let s = ` ${text.toLowerCase()} `;
  const found: string[] = [];
  for (const n of [...new Set(names.map((x) => x.toLowerCase().trim()))].sort(
    (a, b) => b.length - a.length,
  )) {
    if (!n) continue;
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(n)}(?![\\p{L}\\p{N}])`, 'gu');
    s = s.replace(re, () => {
      found.push(`name:${n}`);
      return ' ';
    });
  }
  const words = (s.match(/[\p{L}\p{N}]+/gu) ?? [])
    .filter((w) => (w.length > 1 || /\d/.test(w)) && !STOP.has(w))
    .map(stem);
  return [...found, ...words];
}

/** Okapi BM25 of each document for a query. */
export function bm25(docs: string[][], query: string[], k1 = 1.2, b = 0.75): number[] {
  const n = docs.length;
  if (!n || !query.length) return docs.map(() => 0);
  const avg = docs.reduce((s, d) => s + d.length, 0) / n || 1;
  const df = new Map<string, number>();
  for (const d of docs) for (const t of new Set(d)) df.set(t, (df.get(t) ?? 0) + 1);
  const q = [...new Set(query)];
  return docs.map((d) => {
    const tf = new Map<string, number>();
    for (const t of d) tf.set(t, (tf.get(t) ?? 0) + 1);
    let score = 0;
    for (const t of q) {
      const f = tf.get(t);
      if (!f) continue;
      const m = df.get(t) ?? 0;
      const idf = Math.log(1 + (n - m + 0.5) / (m + 0.5));
      score += (idf * f * (k1 + 1)) / (f + k1 * (1 - b + (b * d.length) / avg));
    }
    return score;
  });
}

export function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! ** 2;
    nb += b[i]! ** 2;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

export interface RankedEntry {
  entry: SearchEntry;
  score: number;
  /** How many of the names in the query the frame names. */
  named: number;
}

/**
 * Ranks frames for a query (docs/design/search.md#searching): by meaning (cosine similarity) with a query vector,
 * otherwise by words (BM25 over the captions and the sources' names, names as single terms). Frames naming people or
 * things the query names come first; one result per source and media file, its best frame.
 */
export function rankEntries(
  entries: readonly SearchEntry[],
  query: string,
  opts: {
    names: readonly string[];
    vector?: readonly number[] | null;
    kinds?: readonly SearchKind[];
    limit: number;
  },
): RankedEntry[] {
  const pool = opts.kinds?.length ? entries.filter((e) => opts.kinds!.includes(e.source.kind)) : [...entries];
  const q = terms(query, opts.names);
  const qNames = new Set(q.filter((t) => t.startsWith('name:')));
  const docs = pool.map((e) => terms(`${e.caption} . ${e.names.join(' . ')}`, opts.names));
  let scores: number[];
  if (opts.vector) scores = pool.map((e) => (e.vector ? cosine(opts.vector!, e.vector) : 0));
  else {
    const raw = bm25(docs, q);
    const max = Math.max(0, ...raw);
    scores = raw.map((s) => (max > 0 ? s / max : 0));
  }
  const min = opts.vector ? SEMANTIC_MIN_SCORE : Number.MIN_VALUE;
  const ranked = pool
    .map((entry, i) => ({
      entry,
      score: Math.round(scores[i]! * 1000) / 1000,
      named: qNames.size ? new Set(docs[i]!.filter((t) => qNames.has(t))).size : 0,
    }))
    .filter((r) => r.score >= min || r.named > 0)
    .sort((a, b) => b.named - a.named || b.score - a.score || a.entry.key.localeCompare(b.entry.key));
  const seen = new Set<string>();
  const out: RankedEntry[] = [];
  for (const r of ranked) {
    const id = `${sourceId(r.entry.source)}|${r.entry.media.hash}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(r);
    if (out.length >= opts.limit) break;
  }
  return out;
}

/** What a result is called: the clip and shot of a take, the resource's name, the reference's owner. */
export function searchLabel(
  docs: Pick<ProjectDocs, 'clips' | 'resources' | 'characters' | 'elements'>,
  s: SearchSource,
): string {
  if (s.kind === 'take') {
    const clip = docs.clips[s.clipId];
    const shot = clip?.shots.find((x) => x.id === s.shotId);
    if (!clip || !shot) return 'A take';
    return `Clip ${clip.index + 1} · shot ${shot.index + 1}: ${shot.description.slice(0, 60)}`;
  }
  if (s.kind === 'resource') return docs.resources[s.resourceId]?.name ?? 'A resource';
  const owner = s.characterId
    ? docs.characters[s.characterId]?.name
    : s.elementId
      ? docs.elements[s.elementId]?.name
      : null;
  return owner ? `${owner} (reference)` : 'A reference';
}
