import type { MediaRef } from '../schemas/common';
import type { TextItem, TextStyle, Timeline, Track, VideoItem } from '../schemas/timeline';
import { timelineDuration } from '../timeline/query';
import { type BrandBug, fontFamily, type LowerThirdTemplate, type ProjectBrand } from './schema';

export * from './schema';

/**
 * Brand kits (docs/design/brand-kits.md): the studio's fonts, colors, logo, bumpers, lower-third templates and brand
 * bug, and what a project's applied brand puts on screen.
 */

/** The text style of the brand for a title (an item's own style wins where it says something). */
export function brandTitleStyle(brand: ProjectBrand | null, base: TextStyle): TextStyle {
  if (!brand) return base;
  const font = brand.fonts.title ?? brand.fonts.body;
  return {
    ...base,
    color: base.color ?? brand.colors.text,
    ...(font && !base.font ? { font: { media: font, family: fontFamily(font) } } : {}),
    box: base.box === undefined ? brand.colors.box : base.box,
    boxOpacity: base.boxOpacity ?? brand.colors.boxOpacity,
  };
}

/** A lower third from a template: two lines (name, role) in the brand's font, color and box. */
export function lowerThirdItem(
  brand: ProjectBrand,
  template: LowerThirdTemplate,
  input: { name: string; role?: string; start: number; duration?: number },
): Omit<TextItem, 'id'> {
  const font =
    template.font === 'title'
      ? (brand.fonts.title ?? brand.fonts.body)
      : (brand.fonts.body ?? brand.fonts.title);
  return {
    kind: 'text',
    start: input.start,
    duration: input.duration ?? 4,
    text: input.role?.trim() ? `${input.name.trim()}\n${input.role.trim()}` : input.name.trim(),
    style: {
      preset: 'lower_third',
      align: template.position,
      color: template.color === 'accent' ? brand.colors.accent : brand.colors.text,
      ...(template.size ? { size: template.size } : {}),
      ...(font ? { font: { media: font, family: fontFamily(font) } } : {}),
      box: template.box ? brand.colors.box : null,
      boxOpacity: brand.colors.boxOpacity,
    },
  };
}

export const BRAND_BUG_TRACK_ID = 'trk_brandbug00001';

/** Where the logo goes: its transform for a frame of `width` × `height`. */
export function bugTransform(
  bug: BrandBug,
  logo: Pick<MediaRef, 'width' | 'height'>,
  frame: { width: number; height: number },
): { x: number; y: number; scale: number; opacity: number } {
  const aspect = logo.width && logo.height ? logo.width / logo.height : 1;
  const { width: W, height: H } = frame;
  // The picture fitted into the frame (as the compositors place it), then scaled to `size` of the frame's width
  const fittedW = Math.min(W, H * aspect);
  const w = bug.size * W;
  const h = w / aspect;
  const m = bug.margin * W;
  const left = bug.corner.endsWith('left');
  const top = bug.corner.startsWith('top');
  return {
    x: (left ? m + w / 2 : W - m - w / 2) / W,
    y: (top ? m + h / 2 : H - m - h / 2) / H,
    scale: w / fittedW,
    opacity: bug.opacity,
  };
}

/**
 * The brand bug for a render or the preview: the logo as an overlay over the whole film, in its corner (like the
 * disclosure label, drawn at render time and never stored in the cut).
 */
export function withBrand(
  t: Timeline,
  brand: Pick<ProjectBrand, 'logo' | 'bug'> | null,
  on: boolean,
): Timeline {
  if (!on || !brand?.logo) return t;
  const total = timelineDuration(t);
  if (total <= 0) return t;
  const tr = bugTransform(brand.bug, brand.logo, t);
  const item: VideoItem = {
    id: 'itm_brandbug000001',
    kind: 'video',
    source: { type: 'media', media: brand.logo },
    start: 0,
    in: 0,
    out: total,
    speed: 1,
    volume: 0,
    muted: true,
    transform: { keyframes: [{ t: 0, x: tr.x, y: tr.y, scale: tr.scale, opacity: tr.opacity }] },
    label: 'Brand bug',
  };
  const track: Track = { id: BRAND_BUG_TRACK_ID, kind: 'video', name: 'Brand bug', items: [item] };
  const tracks = t.tracks.filter((x) => x.id !== BRAND_BUG_TRACK_ID);
  // Above every other video track
  const lastVideo = tracks.reduce((k, x, i) => (x.kind === 'video' ? i : k), -1);
  return { ...t, tracks: [...tracks.slice(0, lastVideo + 1), track, ...tracks.slice(lastVideo + 1)] };
}

/** Whether bytes start like a TrueType or OpenType font. */
export function isFontFile(bytes: Uint8Array): boolean {
  if (bytes.length < 4) return false;
  const sig = String.fromCharCode(bytes[0]!, bytes[1]!, bytes[2]!, bytes[3]!);
  return (
    sig === 'OTTO' || sig === 'true' || (bytes[0] === 0 && bytes[1] === 1 && bytes[2] === 0 && bytes[3] === 0)
  );
}
