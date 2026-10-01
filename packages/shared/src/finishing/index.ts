import type {
  Delivery,
  DeliveryAspect,
  DeliveryFormat,
  DeliveryPresetId,
  DeliveryResolution,
  ExportQuality,
  LoudnessTarget,
} from '../schemas/job';
import type { AudioItem, FocusPoint, Item, TextItem, Timeline, VideoItem } from '../schemas/timeline';
import { itemDuration, itemEnd, layoutPrimary, primaryTrack } from '../timeline/ops';
import { timelineDuration } from '../timeline/query';
import { deepClone } from '../util/canonical-json';

/** Deliveries (docs/design/finishing.md#delivery-presets). */
export interface DeliveryPreset {
  label: string;
  format: DeliveryFormat;
  resolution: DeliveryResolution;
  aspect: DeliveryAspect;
  loudness: LoudnessTarget;
  captions: 'burn' | 'sidecar';
  stems: boolean;
  thumbnails: boolean;
  maxDurationSec: number | null;
}

export const DELIVERY_PRESETS: Record<DeliveryPresetId, DeliveryPreset> = {
  web: {
    label: 'Web (MP4, project size)',
    format: 'mp4',
    resolution: 'project',
    aspect: 'source',
    loudness: 'streaming',
    captions: 'burn',
    stems: false,
    thumbnails: false,
    maxDurationSec: null,
  },
  youtube: {
    label: 'YouTube (4K MP4, subtitles, thumbnails)',
    format: 'mp4',
    resolution: 'uhd',
    aspect: 'source',
    loudness: 'streaming',
    captions: 'sidecar',
    stems: false,
    thumbnails: true,
    maxDurationSec: null,
  },
  broadcast: {
    label: 'Broadcast (ProRes HD, EBU R128, stems)',
    format: 'prores',
    resolution: 'hd',
    aspect: 'source',
    loudness: 'broadcast',
    captions: 'sidecar',
    stems: true,
    thumbnails: false,
    maxDurationSec: null,
  },
  vertical: {
    label: 'Vertical 9:16 cut-down (60 s)',
    format: 'mp4',
    resolution: 'hd',
    aspect: '9:16',
    loudness: 'streaming',
    captions: 'burn',
    stems: false,
    thumbnails: true,
    maxDurationSec: 60,
  },
  square: {
    label: 'Square 1:1 cut-down (60 s)',
    format: 'mp4',
    resolution: 'hd',
    aspect: '1:1',
    loudness: 'streaming',
    captions: 'burn',
    stems: false,
    thumbnails: true,
    maxDurationSec: 60,
  },
  master_prores: {
    label: 'ProRes master',
    format: 'prores',
    resolution: 'project',
    aspect: 'source',
    loudness: 'off',
    captions: 'sidecar',
    stems: true,
    thumbnails: false,
    maxDurationSec: null,
  },
  master_frames: {
    label: 'Image-sequence master (PNG + WAV)',
    format: 'frames',
    resolution: 'project',
    aspect: 'source',
    loudness: 'off',
    captions: 'sidecar',
    stems: true,
    thumbnails: false,
    maxDurationSec: null,
  },
};

export interface DeliveryInput {
  preset?: DeliveryPresetId;
  format?: DeliveryFormat;
  resolution?: DeliveryResolution;
  fps?: number;
  aspect?: DeliveryAspect;
  maxDurationSec?: number;
  thumbnails?: boolean;
  loudness?: LoudnessTarget;
  captions?: 'burn' | 'sidecar';
  stems?: boolean;
}

export interface ResolvedDelivery extends Omit<Delivery, 'enhance'> {
  loudness: LoudnessTarget;
  captions: 'burn' | 'sidecar';
  stems: boolean;
}

const even = (v: number) => Math.max(2, Math.round(v / 2) * 2);
const ASPECT: Record<Exclude<DeliveryAspect, 'source'>, number> = { '9:16': 9 / 16, '1:1': 1 };

/** Width over height of a delivery's frame. */
export function aspectRatio(aspect: DeliveryAspect, source: { width: number; height: number }): number {
  return aspect === 'source' ? source.width / source.height : ASPECT[aspect];
}

/** The delivered frame: the cut's size, or a short side of 1080/2160 px; drafts stay within 720 px of height. */
export function deliverySize(
  source: { width: number; height: number },
  opts: { aspect: DeliveryAspect; resolution: DeliveryResolution; quality: ExportQuality },
): { width: number; height: number } {
  const ar = aspectRatio(opts.aspect, source);
  let width: number;
  let height: number;
  if (opts.resolution === 'project') {
    // The largest window of the aspect inside the cut's frame.
    const window = cropSize(source.width, source.height, ar);
    width = window.width;
    height = window.height;
  } else {
    const short = opts.resolution === 'uhd' ? 2160 : 1080;
    if (ar >= 1) {
      height = short;
      width = short * ar;
    } else {
      width = short;
      height = short / ar;
    }
  }
  if (opts.quality === 'draft' && height > 720) {
    width = (width * 720) / height;
    height = 720;
  }
  return { width: even(width), height: even(height) };
}

/** A preset, then every explicit option. */
export function resolveDelivery(
  source: { width: number; height: number; fps: number },
  input: DeliveryInput,
  quality: ExportQuality,
): ResolvedDelivery {
  const preset = input.preset ?? 'web';
  const p = DELIVERY_PRESETS[preset];
  const aspect = input.aspect ?? p.aspect;
  const size = deliverySize(source, { aspect, resolution: input.resolution ?? p.resolution, quality });
  return {
    preset,
    format: input.format ?? p.format,
    ...size,
    fps: input.fps ?? source.fps,
    aspect,
    maxDurationSec: input.maxDurationSec ?? p.maxDurationSec,
    thumbnails: input.thumbnails ?? p.thumbnails,
    loudness: input.loudness ?? p.loudness,
    captions: input.captions ?? p.captions,
    stems: input.stems ?? p.stems,
  };
}

/** The largest window of aspect `ar` (width / height) inside a frame, even-sized. */
export function cropSize(width: number, height: number, ar: number): { width: number; height: number } {
  if (width / height > ar) return { width: even(height * ar), height: even(height) };
  return { width: even(width), height: even(width / ar) };
}

/** The subject's position at source time `t` (linear between focus points, held before and after). */
export function focusAt(focus: readonly FocusPoint[], t: number): { x: number; y: number } {
  if (!focus.length) return { x: 0.5, y: 0.5 };
  const pts = [...focus].sort((a, b) => a.t - b.t);
  if (t <= pts[0]!.t) return { x: pts[0]!.x, y: pts[0]!.y };
  for (let k = 1; k < pts.length; k++) {
    const a = pts[k - 1]!;
    const b = pts[k]!;
    if (t <= b.t) {
      const u = b.t > a.t ? (t - a.t) / (b.t - a.t) : 1;
      return { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u };
    }
  }
  const last = pts[pts.length - 1]!;
  return { x: last.x, y: last.y };
}

/** The crop window of a source frame at time `t`: the aspect's largest window, centred on the subject, inside. */
export function cropWindow(
  src: { width: number; height: number },
  ar: number,
  focus: readonly FocusPoint[],
  t: number,
): { x: number; y: number; width: number; height: number } {
  const w = Math.min(src.width, src.height * ar);
  const h = Math.min(src.height, src.width / ar);
  const f = focusAt(focus, t);
  const x = Math.min(Math.max(0, f.x * src.width - w / 2), src.width - w);
  const y = Math.min(Math.max(0, f.y * src.height - h / 2), src.height - h);
  return { x, y, width: w, height: h };
}

const n = (v: number) => (Math.round(v * 10000) / 10000).toString();

/** A piecewise-linear expression of `s` (source seconds) through the focus points' `key`. */
function linearExpr(focus: readonly FocusPoint[], key: 'x' | 'y', s: string): string {
  const pts = [...focus].sort((a, b) => a.t - b.t);
  if (pts.length === 1) return n(pts[0]![key]);
  let expr = n(pts[pts.length - 1]![key]);
  for (let k = pts.length - 1; k >= 1; k--) {
    const a = pts[k - 1]!;
    const b = pts[k]!;
    const seg =
      b.t > a.t ? `${n(a[key])}+(${n(b[key] - a[key])})*((${s})-${n(a.t)})/${n(b.t - a.t)}` : n(b[key]);
    expr = `if(lt(${s},${n(b.t)}),${seg},${expr})`;
  }
  return `if(lt(${s},${n(pts[0]!.t)}),${n(pts[0]![key])},${expr})`;
}

/**
 * The ffmpeg crop of an item for a chunk (docs/design/finishing.md#auto-reframe-and-cut-downs): `t` is the stream's
 * time from the chunk's first source second `srcIn`, at the item's speed.
 */
export function cropFilter(focus: readonly FocusPoint[], ar: number, srcIn: number, speed: number): string {
  const s = `${n(srcIn)}+t*${n(speed)}`;
  const w = `min(iw\\,ih*${n(ar)})`;
  const h = `min(ih\\,iw/${n(ar)})`;
  return (
    `crop=w='${w}':h='${h}':` +
    `x='clip((${linearExpr(focus, 'x', s)})*iw-ow/2\\,0\\,iw-ow)':` +
    `y='clip((${linearExpr(focus, 'y', s)})*ih-oh/2\\,0\\,ih-oh)'`
  );
}

/**
 * The cut reframed to a delivery's aspect: the timeline takes the crop's size and every video item follows its
 * take's focus (centred when unknown).
 */
export function reframeTimeline(
  t: Timeline,
  opts: {
    aspect: Exclude<DeliveryAspect, 'source'>;
    focusByTake: Record<string, FocusPoint[] | null | undefined>;
  },
): Timeline {
  const out = deepClone(t);
  const size = cropSize(t.width, t.height, ASPECT[opts.aspect]);
  out.width = size.width;
  out.height = size.height;
  for (const item of primaryTrack(out).items as VideoItem[]) {
    const focus = item.source.type === 'take' ? opts.focusByTake[item.source.takeId] : null;
    item.crop = { focus: focus?.length ? focus : [{ t: 0, x: 0.5, y: 0.5 }] };
  }
  return out;
}

/**
 * A cut-down (docs/design/finishing.md#auto-reframe-and-cut-downs): the cut up to `maxSec`, the last item trimmed to
 * it with a fade to black, sound fading out with it, everything later dropped.
 */
export function cutDown(t: Timeline, maxSec: number): Timeline {
  if (timelineDuration(t) <= maxSec + 1e-6) return t;
  const out = deepClone(t);
  const primary = primaryTrack(out);
  const items = primary.items as VideoItem[];
  const keep: VideoItem[] = [];
  for (const item of items) {
    if (item.start >= maxSec - 0.05) break;
    if (itemEnd(item) > maxSec) {
      item.out = item.in + (maxSec - item.start) * item.speed;
      item.fadeOut = Math.min(1, itemDuration(item) / 2);
    }
    keep.push(item);
  }
  primary.items = keep;
  layoutPrimary(primary);
  const end = keep.length ? itemEnd(keep[keep.length - 1]!) : 0;
  for (const track of out.tracks) {
    if (track === primary) continue;
    track.items = (track.items as Item[]).flatMap((item): Item[] => {
      if (item.start >= end - 0.05) return [];
      if (item.kind === 'text') {
        const text = item as TextItem;
        return [{ ...text, duration: Math.min(text.duration, end - text.start) }];
      }
      const audio = item as AudioItem;
      if (itemEnd(audio) <= end) return [audio];
      const out2 = audio.in + (end - audio.start);
      return [{ ...audio, out: out2, fadeOut: Math.min(1.5, (out2 - audio.in) / 2) }];
    });
  }
  return out;
}

/**
 * Candidate thumbnail times: the middle of the cut's longest items, then times spread evenly over the picture until
 * there are `count` (at least half a second apart), in time order.
 */
export function thumbnailTimes(t: Timeline, count: number): number[] {
  const items = primaryTrack(t).items as VideoItem[];
  const times = [...items]
    .sort((a, b) => itemDuration(b) - itemDuration(a))
    .slice(0, count)
    .map((i) => i.start + itemDuration(i) / 2);
  const end = items.length ? itemEnd(items[items.length - 1]!) : 0;
  for (let k = 0; times.length < count && k < count * 4; k++) {
    const at = ((k + 0.5) / (count * 4)) * end;
    if (times.every((x) => Math.abs(x - at) >= 0.5)) times.push(at);
  }
  return times.map((x) => Math.round(x * 1000) / 1000).sort((a, b) => a - b);
}
