import type { MediaRef } from '../schemas/common';
import type { AudioItem, TextItem, Timeline, Track, VideoItem } from '../schemas/timeline';
import { itemEnd, primaryTrack } from '../timeline/ops';
import { slugify } from '../util/hash';

/** NLE interchange (docs/design/interchange.md): formats, media locations, frames and timecode, XML. */

export const INTERCHANGE_FORMATS = {
  otio: { ext: 'otio', mime: 'application/json', label: 'OpenTimelineIO' },
  fcpxml: { ext: 'fcpxml', mime: 'application/xml', label: 'FCPXML 1.10' },
  xml: { ext: 'xml', mime: 'application/xml', label: 'Final Cut Pro 7 XML' },
  edl: { ext: 'edl', mime: 'text/plain', label: 'CMX 3600 EDL' },
} as const;
export type InterchangeFormat = keyof typeof INTERCHANGE_FORMATS;
export const INTERCHANGE_FORMAT_IDS = Object.keys(INTERCHANGE_FORMATS) as InterchangeFormat[];

/** An open review note on what an item shows, in source seconds ([review](review.md)). */
export interface ReviewNote {
  at: number;
  author: string;
  body: string;
}

export interface InterchangeContext {
  title: string;
  /** Where the NLE finds a media file (docs/design/interchange.md#where-the-media-is). */
  mediaUrl(media: MediaRef): string;
  /** Open review notes on an item's source. */
  notes?(item: VideoItem): ReviewNote[];
}

export function interchangeFileName(title: string, format: InterchangeFormat): string {
  return `${slugify(title, 60) || 'cut'}.${INTERCHANGE_FORMATS[format].ext}`;
}

/**
 * The WebDAV root as an NLE sees it, as a URL: URLs stay as they are; absolute paths (`/Volumes/dav/rideo`,
 * `Z:\rideo`) become `file://` URLs.
 */
export function normalizeMediaBase(base: string): string {
  const b = base.trim().replace(/[\\/]+$/, '');
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(b)) return b;
  if (/^[a-z]:[\\/]/i.test(b)) return `file:///${encodeURI(b.replace(/\\/g, '/'))}`;
  if (b.startsWith('/')) return `file://${encodeURI(b)}`;
  return b;
}

export function mediaFileName(media: MediaRef): string {
  return media.path.split('/').at(-1)!;
}

/** Whole frames at a rate. */
export const toFrames = (sec: number, fps: number): number => Math.round(sec * fps);

/** Non-drop-frame SMPTE timecode (Rideo's frame rates are integers). */
export function timecode(frames: number, fps: number): string {
  const f = Math.max(0, Math.round(frames));
  const s = Math.floor(f / fps);
  return [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60, f % fps]
    .map((n) => String(n).padStart(2, '0'))
    .join(':');
}

/** Record time of sequences in NLEs starts at one hour. */
export const RECORD_START_SEC = 3600;

/** A picture or sound clip on whole frames: record range in the sequence, source range at the same rate. */
export interface FramedClip<I extends VideoItem | AudioItem = VideoItem | AudioItem> {
  item: I;
  /** Record frames from the sequence start (without the one-hour offset). */
  start: number;
  end: number;
  /** Source frames of what the record range shows (a transition's handle lies beyond `out`). */
  in: number;
  out: number;
  speed: number;
  /** The transition into this clip, in frames, starting at `start` (the cut). */
  transition: { type: NonNullable<VideoItem['transitionIn']>['type']; frames: number } | null;
}

/**
 * The picture track on whole frames. An item with `transitionIn` starts `d` before the previous one ends (the
 * magnetic track's overlap); in NLE terms that is a cut at the incoming item's start, the outgoing clip's last `d`
 * seconds being its handle.
 */
export function framedPicture(t: Timeline): FramedClip<VideoItem>[] {
  const items = primaryTrack(t).items as VideoItem[];
  const fps = t.fps;
  return items.map((item, i) => {
    const next = items[i + 1];
    const recordEnd = next?.transitionIn ? next.start : itemEnd(item);
    const start = toFrames(item.start, fps);
    const end = Math.max(start + 1, toFrames(recordEnd, fps));
    const inF = toFrames(item.in, fps);
    return {
      item,
      start,
      end,
      in: inF,
      out: inF + Math.round((end - start) * item.speed),
      speed: item.speed,
      transition:
        i > 0 && item.transitionIn
          ? { type: item.transitionIn.type, frames: Math.max(1, toFrames(item.transitionIn.duration, fps)) }
          : null,
    };
  });
}

/** An audio track's items on whole frames, in time order. */
export function framedAudio(t: Timeline, track: Track): FramedClip<AudioItem>[] {
  const fps = t.fps;
  return (track.items as AudioItem[])
    .slice()
    .sort((a, b) => a.start - b.start)
    .map((item) => {
      const start = toFrames(item.start, fps);
      const end = Math.max(start + 1, toFrames(itemEnd(item), fps));
      const inF = toFrames(item.in, fps);
      return { item, start, end, in: inF, out: inF + (end - start), speed: 1, transition: null };
    });
}

/** Splits overlapping items into lanes (NLE tracks hold one clip at a time). */
export function lanes<T extends { start: number; end: number }>(clips: readonly T[]): T[][] {
  const out: T[][] = [];
  for (const c of [...clips].sort((a, b) => a.start - b.start)) {
    const lane = out.find((l) => l.at(-1)!.end <= c.start);
    if (lane) lane.push(c);
    else out.push([c]);
  }
  return out;
}

export function textItems(t: Timeline): TextItem[] {
  return t.tracks
    .filter((tr) => tr.kind === 'text')
    .flatMap((tr) => tr.items as TextItem[])
    .sort((a, b) => a.start - b.start);
}

/** Whether a picture item's own sound plays. */
export const hasSound = (item: VideoItem): boolean =>
  !item.muted && item.volume > 0 && item.source.media.hasAudio !== false;

export const clipLabel = (item: VideoItem | AudioItem): string =>
  item.label ?? mediaFileName(item.source.media);

// XML

export interface XmlNode {
  tag: string;
  attrs?: Record<string, string | number | undefined | null>;
  children?: (XmlNode | string | null | undefined | false)[];
}

export function x(
  tag: string,
  attrs?: XmlNode['attrs'] | null,
  ...children: (
    | XmlNode
    | string
    | number
    | null
    | undefined
    | false
    | (XmlNode | null | undefined | false)[]
  )[]
): XmlNode {
  return {
    tag,
    attrs: attrs ?? undefined,
    children: children.flat().map((c) => (typeof c === 'number' ? String(c) : c)),
  };
}

export function escapeXml(s: string): string {
  return s
    .replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!,
    )
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
}

/** Renders an element tree with two-space indentation; text-only elements stay on one line. */
export function renderXml(node: XmlNode, depth = 0): string {
  const pad = '  '.repeat(depth);
  const attrs = Object.entries(node.attrs ?? {})
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => ` ${k}="${escapeXml(String(v))}"`)
    .join('');
  const kids = (node.children ?? []).filter(
    (c): c is XmlNode | string => c !== null && c !== undefined && c !== false,
  );
  if (kids.length === 0) return `${pad}<${node.tag}${attrs}/>`;
  if (kids.every((k) => typeof k === 'string'))
    return `${pad}<${node.tag}${attrs}>${escapeXml(kids.join(''))}</${node.tag}>`;
  const inner = kids
    .map((k) =>
      typeof k === 'string' ? `${'  '.repeat(depth + 1)}${escapeXml(k)}` : renderXml(k, depth + 1),
    )
    .join('\n');
  return `${pad}<${node.tag}${attrs}>\n${inner}\n${pad}</${node.tag}>`;
}

export function xmlDocument(doctype: string, root: XmlNode): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE ${doctype}>\n${renderXml(root)}\n`;
}
