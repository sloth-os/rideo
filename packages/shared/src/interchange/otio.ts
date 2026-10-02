import { z } from 'zod';
import { newId } from '../ids';
import {
  type AudioItem,
  AudioItemSchema,
  type Source,
  type TextItem,
  TextItemSchema,
  type Timeline,
  TimelineSchema,
  type Track,
  type TransitionSchema,
  type VideoItem,
  VideoItemSchema,
} from '../schemas/timeline';
import { itemDuration, itemEnd, layoutPrimary, primaryTrack } from '../timeline/ops';
import {
  clipLabel,
  hasSound,
  type InterchangeContext,
  lanes,
  mediaFileName,
  RECORD_START_SEC,
  textItems,
} from './common';

/** OpenTimelineIO (docs/design/interchange.md): the cut as `Timeline.1` JSON, and a re-edited cut back. */

type Json = Record<string, unknown>;
const round6 = (n: number) => Math.round(n * 1e6) / 1e6;
const rt = (sec: number, fps: number): Json => ({
  OTIO_SCHEMA: 'RationalTime.1',
  rate: fps,
  value: round6(sec * fps),
});
const range = (start: number, duration: number, fps: number): Json => ({
  OTIO_SCHEMA: 'TimeRange.1',
  duration: rt(duration, fps),
  start_time: rt(start, fps),
});

const OTIO_TRANSITION: Record<NonNullable<VideoItem['transitionIn']>['type'], string> = {
  crossfade: 'SMPTE_Dissolve',
  wipe: 'Custom_Transition',
  dip_to_black: 'Custom_Transition',
};

function reference(item: VideoItem | AudioItem, ctx: InterchangeContext, fps: number): Json {
  const media = item.source.media;
  return {
    OTIO_SCHEMA: 'ExternalReference.1',
    available_range: media.durationSec ? range(0, media.durationSec, fps) : null,
    metadata: { rideo: { hash: media.hash, path: media.path } },
    name: mediaFileName(media),
    target_url: ctx.mediaUrl(media),
  };
}

function clip(
  item: VideoItem | AudioItem,
  recordDur: number,
  ctx: InterchangeContext,
  fps: number,
  extra: { markers?: Json[]; linked?: boolean } = {},
): Json {
  const speed = item.kind === 'video' ? item.speed : 1;
  return {
    OTIO_SCHEMA: 'Clip.1',
    effects:
      speed !== 1
        ? [
            {
              OTIO_SCHEMA: 'LinearTimeWarp.1',
              effect_name: 'LinearTimeWarp',
              metadata: {},
              name: '',
              time_scalar: speed,
            },
          ]
        : [],
    markers: extra.markers ?? [],
    media_reference: reference(item, ctx, fps),
    metadata: {
      rideo: {
        item,
        ...(extra.linked ? { linked: true } : {}),
        volume: item.volume,
        ...(item.kind === 'video' && item.muted ? { muted: true } : {}),
      },
    },
    name: clipLabel(item),
    // The record duration; the media used is duration × time_scalar (the adapters' convention).
    source_range: range(item.in, recordDur, fps),
  };
}

const gap = (dur: number, fps: number): Json => ({
  OTIO_SCHEMA: 'Gap.1',
  effects: [],
  markers: [],
  metadata: {},
  name: '',
  source_range: range(0, dur, fps),
});

function transition(t: NonNullable<VideoItem['transitionIn']>, fps: number): Json {
  return {
    OTIO_SCHEMA: 'Transition.1',
    // The cut is at the incoming clip's start; the outgoing clip's handle covers the transition.
    in_offset: rt(0, fps),
    metadata: { rideo: { type: t.type } },
    name: t.type,
    out_offset: rt(t.duration, fps),
    transition_type: OTIO_TRANSITION[t.type],
  };
}

const track = (name: string, kind: 'Video' | 'Audio', children: Json[], metadata: Json = {}): Json => ({
  OTIO_SCHEMA: 'Track.1',
  children,
  effects: [],
  kind,
  markers: [],
  metadata,
  name,
  source_range: null,
});

export function toOtio(t: Timeline, ctx: InterchangeContext): Json {
  const fps = t.fps;
  const picture = primaryTrack(t);
  const items = picture.items as VideoItem[];
  const recordEnd = (i: number) => {
    const next = items[i + 1];
    return next?.transitionIn ? next.start : itemEnd(items[i]!);
  };
  const pictureChildren: Json[] = [];
  const soundChildren: Json[] = [];
  items.forEach((item, i) => {
    const dur = recordEnd(i) - item.start;
    if (item.transitionIn && i > 0) {
      pictureChildren.push(transition(item.transitionIn, fps));
      if (hasSound(items[i - 1]!) && hasSound(item)) soundChildren.push(transition(item.transitionIn, fps));
    }
    const shown = item.in + dur * item.speed;
    const markers = (ctx.notes?.(item) ?? [])
      .filter((n) => n.at >= item.in - 1e-6 && n.at <= shown + 1e-6)
      .map((n) => ({
        OTIO_SCHEMA: 'Marker.2',
        color: 'RED',
        comment: n.body,
        marked_range: range(n.at, 0, fps),
        metadata: { rideo: { note: true } },
        name: n.author,
      }));
    pictureChildren.push(clip(item, dur, ctx, fps, { markers }));
    soundChildren.push(hasSound(item) ? clip(item, dur, ctx, fps, { linked: true }) : gap(dur, fps));
  });
  const tracks: Json[] = [
    track(picture.name || 'Picture', 'Video', pictureChildren, { rideo: { trackId: picture.id } }),
  ];
  if (soundChildren.some((c) => c.OTIO_SCHEMA === 'Clip.1'))
    tracks.push(track('Production sound', 'Audio', soundChildren, { rideo: { linked: true } }));
  for (const tr of t.tracks.filter((x) => x.kind === 'audio')) {
    const sorted = (tr.items as AudioItem[]).map((item) => ({ item, start: item.start, end: itemEnd(item) }));
    lanes(sorted).forEach((lane, k) => {
      const children: Json[] = [];
      let cursor = 0;
      for (const { item, start, end } of lane) {
        if (start > cursor + 1e-6) children.push(gap(start - cursor, fps));
        children.push(clip(item, end - start, ctx, fps));
        cursor = end;
      }
      tracks.push(
        track(k === 0 ? tr.name : `${tr.name} ${k + 1}`, 'Audio', children, {
          rideo: { trackId: tr.id, role: tr.role ?? null },
        }),
      );
    });
  }
  const textTrack = (item: TextItem) => t.tracks.find((tr) => tr.items.some((i) => i.id === item.id))!.id;
  return {
    OTIO_SCHEMA: 'Timeline.1',
    global_start_time: rt(RECORD_START_SEC, fps),
    metadata: { rideo: { version: 1, fps, width: t.width, height: t.height, mix: t.mix ?? null } },
    name: ctx.title,
    tracks: {
      OTIO_SCHEMA: 'Stack.1',
      children: tracks,
      effects: [],
      markers: textItems(t).map((item) => ({
        OTIO_SCHEMA: 'Marker.2',
        color: 'PURPLE',
        comment: item.text,
        marked_range: range(item.start, item.duration, fps),
        metadata: { rideo: { text: item, trackId: textTrack(item) } },
        name: item.text.slice(0, 80),
      })),
      metadata: {},
      name: 'tracks',
      source_range: null,
    },
  };
}

// Import

const RationalTimeSchema = z.object({ rate: z.number().positive(), value: z.number() }).passthrough();
const TimeRangeSchema = z
  .object({ start_time: RationalTimeSchema, duration: RationalTimeSchema })
  .passthrough();
const MetaSchema = z.record(z.string(), z.unknown()).nullish();
const schemaOf = (prefix: string) => z.string().regex(new RegExp(`^${prefix}\\.\\d+$`));
const ReferenceSchema = z
  .object({
    OTIO_SCHEMA: z.string(),
    target_url: z.string().max(4000).nullish(),
    available_range: TimeRangeSchema.nullish(),
    name: z.string().nullish(),
    metadata: MetaSchema,
  })
  .passthrough();
const EffectSchema = z
  .object({ OTIO_SCHEMA: z.string(), time_scalar: z.number().optional(), effect_name: z.string().nullish() })
  .passthrough();
const MarkerSchema = z
  .object({
    OTIO_SCHEMA: schemaOf('Marker'),
    name: z.string().nullish(),
    marked_range: TimeRangeSchema,
    comment: z.string().nullish(),
    metadata: MetaSchema,
  })
  .passthrough();
const ClipSchema = z
  .object({
    OTIO_SCHEMA: schemaOf('Clip'),
    name: z.string().nullish(),
    source_range: TimeRangeSchema.nullish(),
    media_reference: ReferenceSchema.nullish(),
    media_references: z.record(z.string(), ReferenceSchema).nullish(),
    active_media_reference_key: z.string().nullish(),
    effects: z.array(EffectSchema).nullish(),
    metadata: MetaSchema,
    enabled: z.boolean().nullish(),
  })
  .passthrough();
const GapSchema = z
  .object({ OTIO_SCHEMA: schemaOf('Gap'), source_range: TimeRangeSchema.nullish() })
  .passthrough();
const TransitionInSchema = z
  .object({
    OTIO_SCHEMA: schemaOf('Transition'),
    name: z.string().nullish(),
    transition_type: z.string().nullish(),
    in_offset: RationalTimeSchema,
    out_offset: RationalTimeSchema,
    metadata: MetaSchema,
  })
  .passthrough();
const TrackInSchema = z
  .object({
    OTIO_SCHEMA: schemaOf('Track'),
    name: z.string().nullish(),
    kind: z.string(),
    children: z.array(z.object({ OTIO_SCHEMA: z.string() }).passthrough()).max(20_000),
    metadata: MetaSchema,
  })
  .passthrough();
/** The part of an OTIO file Rideo reads (other schemas and fields are ignored). */
export const OtioTimelineSchema = z
  .object({
    OTIO_SCHEMA: schemaOf('Timeline'),
    name: z.string().nullish(),
    tracks: z
      .object({
        OTIO_SCHEMA: schemaOf('Stack'),
        children: z.array(z.object({ OTIO_SCHEMA: z.string() }).passthrough()).max(200),
        markers: z.array(MarkerSchema).max(5000).nullish(),
      })
      .passthrough(),
    metadata: MetaSchema,
  })
  .passthrough();

export interface OtioClipRef {
  name: string;
  url: string | null;
  /** What Rideo wrote in the clip's `metadata.rideo`, if anything. */
  rideo: { item?: unknown } | null;
}

export interface OtioImportResult {
  timeline: Timeline;
  name: string | null;
  clips: number;
  unresolved: { name: string; url: string | null }[];
  skipped: string[];
}

const secs = (t: z.infer<typeof RationalTimeSchema>) => t.value / t.rate;
const rideoMeta = (m: unknown): Json | null =>
  m && typeof m === 'object' && (m as Json).rideo && typeof (m as Json).rideo === 'object'
    ? ((m as Json).rideo as Json)
    : null;
const TRANSITION_TYPES: NonNullable<VideoItem['transitionIn']>['type'][] = [
  'crossfade',
  'wipe',
  'dip_to_black',
];

function transitionType(
  t: z.infer<typeof TransitionInSchema>,
): NonNullable<VideoItem['transitionIn']>['type'] {
  const meta = rideoMeta(t.metadata)?.type;
  if (typeof meta === 'string' && (TRANSITION_TYPES as string[]).includes(meta)) return meta as never;
  const name = `${t.name ?? ''} ${t.transition_type ?? ''}`.toLowerCase();
  if (name.includes('wipe')) return 'wipe';
  if (name.includes('dip') || name.includes('black') || name.includes('color')) return 'dip_to_black';
  return 'crossfade';
}

/**
 * A cut from an OTIO timeline (docs/design/interchange.md#import-opentimelineio): the first video track becomes the
 * picture track, audio tracks map to the cut's tracks, stack markers Rideo wrote become the text items. Throws a
 * ZodError when the file is not an OTIO timeline.
 */
export function fromOtio(
  doc: unknown,
  opts: {
    base: Timeline;
    resolve: (clip: OtioClipRef) => Source | null;
    newId?: (kind: 'item' | 'track') => string;
  },
): OtioImportResult {
  const gen = opts.newId ?? ((k) => newId(k));
  const tl = OtioTimelineSchema.parse(doc);
  const skipped: string[] = [];
  const unresolved: OtioImportResult['unresolved'] = [];
  const used = new Set<string>();
  const idFor = (wanted: unknown) => {
    const id =
      typeof wanted === 'string' && /^itm_[0-9a-z]{10,32}$/.test(wanted) && !used.has(wanted)
        ? wanted
        : gen('item');
    used.add(id);
    return id;
  };
  const note = (msg: string) => {
    if (!skipped.includes(msg)) skipped.push(msg);
  };

  const tracks = tl.tracks.children.flatMap((c, i) => {
    const r = TrackInSchema.safeParse(c);
    if (!r.success) {
      note(`track ${i + 1}: ${c.OTIO_SCHEMA} is not a track`);
      return [];
    }
    return [r.data];
  });
  const video = tracks.filter((t) => t.kind === 'Video');
  for (const v of video.slice(1)) note(`video track “${v.name ?? ''}” (Rideo cuts have one picture track)`);

  /** A clip's media, range and speed, or null (listed) when it cannot be placed. */
  const place = (raw: unknown, kind: 'video' | 'audio') => {
    const r = ClipSchema.safeParse(raw);
    if (!r.success) return null;
    const c = r.data;
    const ref =
      c.media_reference ??
      (c.active_media_reference_key ? c.media_references?.[c.active_media_reference_key] : null);
    const name = c.name ?? ref?.name ?? '';
    const url = ref?.target_url ?? null;
    const meta = rideoMeta(c.metadata);
    if (c.enabled === false) {
      note(`disabled clip “${name}”`);
      return { skip: true as const, dur: c.source_range ? secs(c.source_range.duration) : 0 };
    }
    const sr = c.source_range ?? ref?.available_range;
    if (!sr) {
      note(`clip “${name}” without a range`);
      return null;
    }
    const source = opts.resolve({ name, url, rideo: meta });
    const dur = secs(sr.duration);
    if (!source) {
      unresolved.push({ name, url });
      return { skip: true as const, dur };
    }
    let speed = 1;
    for (const e of c.effects ?? []) {
      if (/^LinearTimeWarp\.\d+$/.test(e.OTIO_SCHEMA) && typeof e.time_scalar === 'number')
        speed *= e.time_scalar;
      else if (/TimeWarp|FreezeFrame/.test(e.OTIO_SCHEMA)) note(`time effect ${e.OTIO_SCHEMA} on “${name}”`);
    }
    if (kind === 'audio' && speed !== 1) {
      note(`speed of the sound clip “${name}” (sound plays at normal speed)`);
      speed = 1;
    }
    if (speed <= 0) {
      note(`freeze or reverse on “${name}”`);
      return { skip: true as const, dur };
    }
    const clamped = Math.min(4, Math.max(0.25, speed));
    if (clamped !== speed) note(`speed ${speed}× on “${name}” (Rideo plays 0.25–4×)`);
    const metaItem = meta?.item;
    const inSec = Math.max(0, secs(sr.start_time));
    let out = inSec + dur * clamped;
    const mediaDur = source.media.durationSec;
    if (mediaDur !== undefined && out > mediaDur + 0.05) {
      note(`“${name}” runs past the end of its media`);
      out = mediaDur;
    }
    return { skip: false as const, dur, source, in: inSec, out, speed: clamped, name, metaItem };
  };

  // Picture
  const pictureItems: VideoItem[] = [];
  let pending: {
    inOff: number;
    outOff: number;
    type: NonNullable<VideoItem['transitionIn']>['type'];
  } | null = null;
  let gaps = 0;
  for (const child of video[0]?.children ?? []) {
    if (/^Transition\.\d+$/.test(child.OTIO_SCHEMA)) {
      const t = TransitionInSchema.safeParse(child);
      if (t.success)
        pending = {
          inOff: secs(t.data.in_offset),
          outOff: secs(t.data.out_offset),
          type: transitionType(t.data),
        };
      continue;
    }
    if (/^Gap\.\d+$/.test(child.OTIO_SCHEMA)) {
      const g = GapSchema.safeParse(child);
      if (g.success && g.data.source_range && secs(g.data.source_range.duration) > 1e-6) gaps++;
      pending = null;
      continue;
    }
    if (!/^Clip\.\d+$/.test(child.OTIO_SCHEMA)) {
      note(`${child.OTIO_SCHEMA} in the picture track`);
      pending = null;
      continue;
    }
    const p = place(child, 'video');
    if (!p || p.skip) {
      pending = null;
      continue;
    }
    const prior = VideoItemSchema.safeParse(p.metaItem);
    const keep =
      prior.success && prior.data.source.media.path === p.source.media.path
        ? {
            volume: prior.data.volume,
            muted: prior.data.muted,
            fadeIn: prior.data.fadeIn,
            fadeOut: prior.data.fadeOut,
            effects: prior.data.effects,
            label: prior.data.label,
            speech: prior.data.speech,
            crop: prior.data.crop,
          }
        : { label: p.name && p.name !== mediaFileName(p.source.media) ? p.name.slice(0, 200) : undefined };
    const item: VideoItem = {
      volume: 1,
      ...Object.fromEntries(Object.entries(keep).filter(([, v]) => v !== undefined)),
      id: idFor(prior.success ? prior.data.id : null),
      kind: 'video',
      source: p.source,
      start: 0,
      in: p.in,
      out: p.out,
      speed: p.speed,
    } as VideoItem;
    const prev = pictureItems.at(-1);
    if (pending && prev) {
      // The handles move back into the clips: the outgoing one runs on, the incoming one starts earlier, as far as
      // their media goes.
      let { inOff, outOff } = pending;
      const prevMax = prev.source.media.durationSec;
      if (prevMax !== undefined && prev.out + outOff * prev.speed > prevMax + 1e-6) {
        outOff = Math.max(0, (prevMax - prev.out) / prev.speed);
        note(`transition into “${p.name}” shortened: “${clipLabel(prev)}” has no more media`);
      }
      if (item.in < inOff * item.speed - 1e-6) {
        inOff = item.in / item.speed;
        note(`transition into “${p.name}” shortened: its media starts later`);
      }
      prev.out += outOff * prev.speed;
      item.in -= inOff * item.speed;
      const duration = Math.round((inOff + outOff) * 1e6) / 1e6;
      if (duration > 0) item.transitionIn = { type: pending.type, duration };
    }
    pending = null;
    pictureItems.push(item);
  }
  if (gaps) note(`${gaps} gap(s) in the picture track (closed: Rideo's picture track has no gaps)`);
  // Transitions stay within half the shorter neighbour, as the editor requires.
  pictureItems.forEach((item, i) => {
    if (!item.transitionIn || i === 0) return;
    const max = Math.min(itemDuration(pictureItems[i - 1]!), itemDuration(item)) / 2;
    if (item.transitionIn.duration > max) {
      note(`transition into “${clipLabel(item)}” shortened to half the shorter clip`);
      item.transitionIn = { ...item.transitionIn, duration: Math.floor(max * 1000) / 1000 } as z.infer<
        typeof TransitionSchema
      >;
    }
    if (item.transitionIn.duration <= 0) item.transitionIn = null;
  });

  // Sound
  const base = TimelineSchema.parse(opts.base);
  const audioIn: { track: Track; items: AudioItem[] }[] = base.tracks
    .filter((t) => t.kind === 'audio')
    .map((t) => ({ track: { ...t, items: [] }, items: [] }));
  for (const otioTrack of tracks.filter((t) => t.kind === 'Audio')) {
    const meta = rideoMeta(otioTrack.metadata);
    if (meta?.linked) continue;
    const name = otioTrack.name?.trim() || `Audio ${audioIn.length + 1}`;
    let target =
      (typeof meta?.trackId === 'string' && audioIn.find((a) => a.track.id === meta.trackId)) ||
      audioIn.find((a) => a.track.name.toLowerCase() === name.toLowerCase());
    if (!target) {
      target = { track: { id: gen('track'), kind: 'audio', name: name.slice(0, 100), items: [] }, items: [] };
      audioIn.push(target);
    }
    let cursor = 0;
    for (const child of otioTrack.children) {
      if (/^Gap\.\d+$/.test(child.OTIO_SCHEMA)) {
        const g = GapSchema.safeParse(child);
        if (g.success && g.data.source_range) cursor += secs(g.data.source_range.duration);
        continue;
      }
      if (/^Transition\.\d+$/.test(child.OTIO_SCHEMA)) {
        note('transitions on sound tracks (use fades)');
        continue;
      }
      const p = place(child, 'audio');
      if (!p) continue;
      if (p.skip) {
        cursor += p.dur;
        continue;
      }
      const prior = AudioItemSchema.safeParse(p.metaItem);
      const keep =
        prior.success && prior.data.source.media.path === p.source.media.path
          ? {
              volume: prior.data.volume,
              fadeIn: prior.data.fadeIn,
              fadeOut: prior.data.fadeOut,
              label: prior.data.label,
              speech: prior.data.speech,
            }
          : {};
      target.items.push({
        volume: 1,
        ...Object.fromEntries(Object.entries(keep).filter(([, v]) => v !== undefined)),
        id: idFor(prior.success ? prior.data.id : null),
        kind: 'audio',
        source: p.source,
        start: Math.round(cursor * 1e6) / 1e6,
        in: p.in,
        out: p.out,
      } as AudioItem);
      cursor += p.dur;
    }
  }

  // Text: what Rideo wrote as stack markers; without them the cut's text stays.
  const texts = (tl.tracks.markers ?? []).flatMap((m) => {
    const meta = rideoMeta(m.metadata);
    const parsed = TextItemSchema.safeParse(meta?.text);
    if (!parsed.success) return [];
    return [
      {
        trackId: typeof meta?.trackId === 'string' ? meta.trackId : null,
        item: {
          ...parsed.data,
          id: idFor(parsed.data.id),
          start: Math.max(0, secs(m.marked_range.start_time)),
        },
      },
    ];
  });

  const picture = primaryTrack(base);
  const nextTracks: Track[] = base.tracks.flatMap((t) => {
    if (t.id === picture.id) {
      const tr: Track = { ...t, items: pictureItems };
      layoutPrimary(tr);
      return [tr];
    }
    if (t.kind === 'audio') {
      const a = audioIn.find((x) => x.track.id === t.id)!;
      return [{ ...t, items: a.items.sort((p, q) => p.start - q.start) }];
    }
    if (t.kind === 'text' && texts.length) {
      const firstText = base.tracks.find((x) => x.kind === 'text')!;
      const mine = texts.filter(
        (x) => (x.trackId && base.tracks.some((b) => b.id === x.trackId) ? x.trackId : firstText.id) === t.id,
      );
      return [{ ...t, items: mine.map((x) => x.item).sort((p, q) => p.start - q.start) }];
    }
    if (t.kind === 'video') return [{ ...t, items: [] }];
    return [t];
  });
  for (const a of audioIn)
    if (!base.tracks.some((t) => t.id === a.track.id))
      nextTracks.push({ ...a.track, items: a.items.sort((p, q) => p.start - q.start) });

  const timeline = TimelineSchema.parse({ ...base, tracks: nextTracks });
  return {
    timeline,
    name: tl.name ?? null,
    clips: pictureItems.length + audioIn.reduce((n, a) => n + a.items.length, 0),
    unresolved,
    skipped,
  };
}
