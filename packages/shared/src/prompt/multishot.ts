import type { Shot } from '../schemas/clip';
import type { GatewayVideoRequest, ModelLimits } from '../schemas/gateway';
import {
  BASE_NEGATIVE,
  clampDuration,
  compileShotPrompt,
  elementLines,
  identityFragment,
  type ShotContext,
  shotSeed,
} from './index';

/**
 * Multi-shot generation (docs/design/multi-shot.md): which shots render together, the request, and where the
 * result is split.
 */

/** Shots that need a request of their own: directing controls bound to one shot's start, end or motion. */
export function needsOwnRequest(shot: Pick<Shot, 'startFrame' | 'endFrame' | 'motionReference'>): boolean {
  return shot.startFrame.mode === 'resource' || shot.endFrame.mode !== 'none' || !!shot.motionReference;
}

/**
 * Consecutive shots (by index) grouped while a group has at most `maxShots` shots and its planned length fits
 * `maxDurationSec`. A group starts at a cut and only holds shots that `eligible` accepts; other shots are alone.
 */
export function planShotGroups(
  shots: Pick<Shot, 'id' | 'index' | 'durationSec' | 'continuity'>[],
  opts: { maxShots: number; maxDurationSec: number; eligible: (id: string) => boolean },
): string[][] {
  const groups: string[][] = [];
  let current: Pick<Shot, 'id' | 'index' | 'durationSec'>[] = [];
  let length = 0;
  const flush = () => {
    if (current.length) groups.push(current.map((s) => s.id));
    current = [];
    length = 0;
  };
  for (const shot of [...shots].sort((a, b) => a.index - b.index)) {
    if (!opts.eligible(shot.id)) {
      flush();
      groups.push([shot.id]);
      continue;
    }
    // only the next shot of the film joins a group (a shot that already has a take may sit in between)
    const next = current.length > 0 && current[current.length - 1]!.index + 1 === shot.index;
    if (next && current.length < opts.maxShots && length + shot.durationSec <= opts.maxDurationSec) {
      current.push(shot);
      length += shot.durationSec;
      continue;
    }
    flush();
    // A continuation that cannot join its predecessor's group needs that shot's last frame: it goes alone.
    if (shot.continuity === 'continuous' && shot.index > 0) {
      groups.push([shot.id]);
      continue;
    }
    current.push(shot);
    length = shot.durationSec;
  }
  flush();
  return groups;
}

function shotLine(ctx: ShotContext, k: number): string {
  // The shot's own prompt without the style header, the cast and the elements (those are said once).
  const full = compileShotPrompt({ ...ctx, characters: [], elements: [] }, 'video');
  const body = full.replace(/^[^.]*\.\s*/, '');
  return `Shot ${k + 1} (${Number(ctx.shot.durationSec.toFixed(1))} s): ${body}`;
}

/** One request for a group of shots (docs/design/multi-shot.md#request). */
export function compileMultiShotRequest(
  ctxs: ShotContext[],
  opts: {
    firstFrameUri?: string;
    referenceUris: string[];
    attempt: number;
    model?: string;
    limits?: ModelLimits | null;
  },
): GatewayVideoRequest {
  const first = ctxs[0]!;
  const header = compileShotPrompt({ ...first, characters: [], elements: [] }, 'video').split('. ')[0]!;
  const characters = [...new Map(ctxs.flatMap((c) => c.characters).map((c) => [c.id, c])).values()];
  const elements = [...new Map(ctxs.flatMap((c) => c.elements ?? []).map((e) => [e.id, e])).values()];
  const lines = [
    `${header}.`,
    `A multi-shot sequence of ${ctxs.length} shots separated by hard cuts.`,
    ...ctxs.map((c, k) => shotLine(c, k)),
  ];
  if (characters.length)
    lines.push(
      `Characters (keep identities exactly as described and as in the reference images): ${characters.map((c) => identityFragment(c)).join(' ')}`,
    );
  lines.push(...elementLines(elements));
  const total = ctxs.reduce((n, c) => n + c.shot.durationSec, 0);
  const refs = opts.limits?.supports_reference_image === false ? [] : opts.referenceUris;
  const input: GatewayVideoRequest['input'] = [{ type: 'text', text: lines.join(' ') }];
  if (opts.firstFrameUri && opts.limits?.supports_first_frame !== false)
    input.push({ type: 'image', uri: opts.firstFrameUri, role: 'first_frame' });
  for (const uri of refs) input.push({ type: 'image', uri, role: 'reference_image' });
  return {
    ...(opts.model && opts.model !== 'auto' ? { model: opts.model } : {}),
    input,
    parameters: {
      duration_seconds: clampDuration(total, opts.limits),
      dimensions: { width: first.settings.resolution.width, height: first.settings.resolution.height },
      seed: shotSeed(first.shot, first.characters, opts.attempt),
      negative_prompt: BASE_NEGATIVE,
      include_audio: false,
      camera_motion: 'auto',
    },
  };
}

/**
 * Where to split a multi-shot render: the detected cuts when there is exactly one fewer than shots, otherwise the
 * planned durations scaled to the render's length. Returns the `planned.length + 1` boundaries.
 */
export function multiShotBoundaries(
  detected: readonly number[],
  planned: readonly number[],
  total: number,
): { boundaries: number[]; cut: 'detected' | 'planned' } {
  const cuts = [...detected].filter((t) => t > 0.2 && t < total - 0.2).sort((a, b) => a - b);
  if (cuts.length === planned.length - 1) return { boundaries: [0, ...cuts, total], cut: 'detected' };
  const sum = planned.reduce((n, d) => n + d, 0) || 1;
  const boundaries = [0];
  let at = 0;
  for (const d of planned) {
    at += (d / sum) * total;
    boundaries.push(Math.round(at * 1000) / 1000);
  }
  boundaries[boundaries.length - 1] = total;
  return { boundaries, cut: 'planned' };
}
