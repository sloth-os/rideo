import type { GatewayImageRequest } from '../schemas/gateway';
import {
  avoidsTheLens,
  counted,
  EXCLUSIONS_STILL,
  elementLines,
  identityFragment,
  inFrameLine,
  LOOKING_INTO_CAMERA,
  negativePromptFor,
  type ShotContext,
  sceneLine,
  shotBodyV2,
  shotSeed,
  styleHeader,
} from './index';

/**
 * Scene sheets (docs/design/storyboard.md#scene-sheets): a scene's frames drawn together as the panels of one image,
 * because frames drawn one at a time do not see each other (docs/design/first-pass.md#a-scene-drawn-on-one-sheet).
 */

/** The most shots one sheet draws: a scene of more is drawn alone, as two sheets of it disagree. */
export const SHEET_MAX_PANELS = 8;
/** Seedream 5.0 Pro refuses a canvas of more than 4,624,220 pixels (measured on 2026-11-01). */
export const DEFAULT_SHEET_PIXELS = 4_600_000;
/** How a sheet's prompt starts (the mock gateway draws a grid for it). */
export const SHEET_PROMPT_PREFIX = 'A storyboard sheet of';
/** What fills a cell no shot fills; the cell is cut away. */
const EMPTY_CELL = 'the same place, with no one in it';

/**
 * Whether these frames of a scene are drawn on one sheet (docs/design/storyboard.md#scene-sheets): the whole scene, two
 * shots or more and no more than a sheet holds, since two sheets of one scene disagree as frames drawn alone do.
 */
export function drawnOnSheet(clip: { shots: { id: string }[] }, shotIds: string[]): boolean {
  return (
    shotIds.length >= 2 &&
    shotIds.length <= SHEET_MAX_PANELS &&
    clip.shots.every((s) => shotIds.includes(s.id))
  );
}

export interface SheetLayout {
  columns: number;
  rows: number;
  /** The panels that are shots, in reading order; the cells after them show the place alone. */
  panels: number;
  /** The canvas, in pixels. */
  width: number;
  height: number;
}

/**
 * The grid of a sheet: the one whose canvas is nearest square, an empty cell counting as much as a canvas a third
 * wider than square, never a whole empty row; as large as `maxPixels` allows, in multiples of 16.
 */
export function sheetLayout(
  panels: number,
  frame: { width: number; height: number },
  maxPixels: number = DEFAULT_SHEET_PIXELS,
): SheetLayout {
  const n = Math.max(1, Math.min(SHEET_MAX_PANELS, Math.floor(panels)));
  let best: { columns: number; rows: number; aspect: number; cost: number } | null = null;
  for (let columns = 1; columns <= n; columns++) {
    const rows = Math.ceil(n / columns);
    const empty = columns * rows - n;
    if (empty >= columns) continue;
    const aspect = (columns * frame.width) / (rows * frame.height);
    const cost = Math.abs(Math.log(aspect)) + 0.3 * empty;
    if (!best || cost < best.cost - 1e-9) best = { columns, rows, aspect, cost };
  }
  const { columns, rows, aspect } = best!;
  const width = Math.floor(Math.sqrt(maxPixels * aspect) / 16) * 16;
  const height = Math.floor(width / aspect / 16) * 16;
  return { columns, rows, panels: n, width, height };
}

/**
 * The prompt of a sheet: its layout, the style and the scene once, each panel's shot as its keyframe would say it,
 * the cast and the elements of all its shots once, then the reference images in order.
 */
export function compileSheetPrompt(
  ctxs: ShotContext[],
  layout: SheetLayout,
  /** `correction`: what the panels of the last sheet got wrong, by panel (docs/design/storyboard.md#scene-sheets). */
  opts: { referenceLabels?: string[]; correction?: string | null } = {},
): string {
  const first = ctxs[0]!;
  const { settings } = first;
  const cells = layout.columns * layout.rows;
  const characters = [...new Map(ctxs.flatMap((c) => c.characters).map((c) => [c.id, c])).values()];
  const elements = [...new Map(ctxs.flatMap((c) => c.elements ?? []).map((e) => [e.id, e])).values()];
  const location = elements.find((e) => e.kind === 'location');
  // The props none of its shots show (docs/design/first-pass.md#what-a-frame-does-not-show-is-not-named)
  const hidden = (first.hiddenProps ?? []).filter((n) => ctxs.every((c) => c.hiddenProps?.includes(n)));
  const lines = [
    `${SHEET_PROMPT_PREFIX} ${counted(cells, 'panel')} in ${counted(layout.columns, 'column')} and ${counted(layout.rows, 'row')}, with thin white gutters between the panels and around them, read left to right and top to bottom. Each panel is one ${settings.aspectRatio} film frame of the same scene: the same place, light and weather, and the same characters, clothes and props, kept the same from panel to panel.`,
    styleHeader(first.screenplay, settings, 'still', { camera: false }),
  ];
  const scene = sceneLine(first.scene, location, { hidden });
  if (scene) lines.push(scene);
  ctxs.forEach((ctx, k) => {
    const inFrame = inFrameLine(ctx, 'keyframe');
    lines.push(
      `Panel ${k + 1}: ${[...shotBodyV2(ctx, 'keyframe'), ...(inFrame ? [inFrame] : [])].join(' ')}`,
    );
  });
  for (let k = ctxs.length; k < cells; k++) lines.push(`Panel ${k + 1}: ${EMPTY_CELL}.`);
  if (characters.length) {
    // Each character as the first panel that shows them wears them
    const shotOf = (id: string) => ctxs.find((c) => c.shot.characterIds.includes(id))?.shot ?? first.shot;
    lines.push(
      `Characters (keep identities exactly as described and as in the reference images): ${characters.map((c) => identityFragment(c, shotOf(c.id))).join(' ')}`,
    );
  }
  lines.push(...elementLines(elements));
  if (opts.correction?.trim()) lines.push(`Make sure: ${opts.correction.trim().replace(/[.;\s]+$/, '')}.`);
  if (opts.referenceLabels?.length)
    lines.push(
      `Reference images, in order: ${opts.referenceLabels.map((l, i) => `${i + 1} ${l}`).join('; ')}.`,
    );
  lines.push('No text, numbers, captions or speech bubbles in the panels.');
  lines.push(`Avoid: ${EXCLUSIONS_STILL}${ctxs.some(avoidsTheLens) ? `, ${LOOKING_INTO_CAMERA}` : ''}.`);
  return lines.join(' ');
}

/** The image request of a sheet: one image of the layout's canvas, seeded by its first shot. */
export function compileSheetRequest(
  ctxs: ShotContext[],
  layout: SheetLayout,
  opts: {
    referenceUris: string[];
    referenceLabels?: string[];
    correction?: string | null;
    attempt: number;
    model?: string;
  },
): GatewayImageRequest {
  const first = ctxs[0]!;
  return {
    ...(opts.model && opts.model !== 'auto' ? { model: opts.model } : {}),
    input: [
      {
        type: 'text',
        text: compileSheetPrompt(ctxs, layout, {
          referenceLabels: opts.referenceLabels,
          correction: opts.correction,
        }),
      },
      ...opts.referenceUris.map((uri) => ({ type: 'image' as const, uri })),
    ],
    parameters: {
      dimensions: { width: layout.width, height: layout.height },
      seed: shotSeed(first.shot, first.characters, opts.attempt),
      negative_prompt: negativePromptFor(first, { camera: false }),
      output_count: 1,
    },
  };
}
