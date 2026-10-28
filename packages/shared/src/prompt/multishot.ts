import type { Shot } from '../schemas/clip';
import type { GatewayVideoRequest, ModelLimits } from '../schemas/gateway';
import {
  BASE_NEGATIVE,
  clampDuration,
  compileShotPrompt,
  dialogueBlockV2,
  elementLines,
  enhancePromptParam,
  identityFragment,
  inFrameLine,
  negativePromptFor,
  PHYSICS_LINE,
  promptVersionOf,
  type ShotContext,
  sceneLine,
  shotBodyV2,
  shotSeed,
  soundBlockV2,
  startsFromFrame,
  styleHeader,
} from './index';

/** Version 2 exclusions of a multi-shot request: its cuts are wanted. */
const EXCLUSIONS_MULTI =
  'morphing faces or bodies, extra or missing limbs, floating objects, sliding feet, flicker, on-screen text';

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
export function planShotGroups<T extends Pick<Shot, 'id' | 'index' | 'durationSec' | 'continuity'>>(
  shots: T[],
  opts: {
    maxShots: number;
    maxDurationSec: number;
    eligible: (id: string) => boolean;
    /** Whether `next` may join the group that `first` opens (docs/design/multi-shot.md#when). */
    joins?: (first: T, next: T) => boolean;
  },
): string[][] {
  const groups: string[][] = [];
  let current: T[] = [];
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
    if (
      next &&
      current.length < opts.maxShots &&
      length + shot.durationSec <= opts.maxDurationSec &&
      (opts.joins?.(current[0]!, shot) ?? true)
    ) {
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

/**
 * Wan 3.0 and models like it take a group's first frame and no references (`exclusive_frames_and_references`): a shot
 * joins only when it shows no one the first frame does not, and lasts the guide's 2-5 s
 * (docs/design/multi-shot.md#when).
 */
export const MULTI_SHOT_SEGMENT_MAX_SEC = 5;
export function framedGroupJoins(
  first: Pick<Shot, 'characterIds' | 'durationSec'>,
  next: Pick<Shot, 'characterIds' | 'durationSec'>,
): boolean {
  return (
    first.durationSec <= MULTI_SHOT_SEGMENT_MAX_SEC &&
    next.durationSec <= MULTI_SHOT_SEGMENT_MAX_SEC &&
    next.characterIds.every((id) => first.characterIds.includes(id))
  );
}

/** Seconds as a shot label writes them: whole seconds when exact, one decimal otherwise. */
const secs = (n: number) => String(Math.round(n * 10) / 10);

function shotLine(ctx: ShotContext, k: number, startSec: number, last: boolean): string {
  if (promptVersionOf(ctx.settings) >= 2) {
    // Wan 3.0's guide: a shot number, its time in the sequence and its content, then the transition
    const label = `Shot ${k + 1} [${secs(startSec)}-${secs(startSec + ctx.shot.durationSec)}s]:`;
    const dialogue = dialogueBlockV2(ctx);
    const inFrame = inFrameLine(ctx, 'video');
    return [
      label,
      ...shotBodyV2(ctx, 'video'),
      ...(inFrame ? [inFrame] : []),
      ...(dialogue ? [dialogue] : []),
      ...(last ? [] : ['Hard cut.']),
    ].join(' ');
  }
  const label = `Shot ${k + 1} (${Number(ctx.shot.durationSec.toFixed(1))} s):`;
  // The shot's own prompt without the style header, the cast and the elements (those are said once).
  const full = compileShotPrompt({ ...ctx, characters: [], elements: [] }, 'video');
  const body = full.replace(/^[^.]*\.\s*/, '');
  return `${label} ${body}`;
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
  const v2 = promptVersionOf(first.settings) >= 2;
  const header = v2
    ? [
        styleHeader(first.screenplay, first.settings, 'motion', { light: !startsFromFrame(first.settings) }),
        sceneLine(
          first.scene,
          (first.elements ?? []).find((e) => e.kind === 'location'),
        ),
      ]
        .filter(Boolean)
        .join(' ')
    : `${compileShotPrompt({ ...first, characters: [], elements: [] }, 'video').split('. ')[0]!}.`;
  const characters = [...new Map(ctxs.flatMap((c) => c.characters).map((c) => [c.id, c])).values()];
  const elements = [...new Map(ctxs.flatMap((c) => c.elements ?? []).map((e) => [e.id, e])).values()];
  const lines = [
    header,
    `A multi-shot sequence of ${ctxs.length} shots separated by hard cuts.`,
    ...ctxs.map((c, k) =>
      shotLine(
        c,
        k,
        ctxs.slice(0, k).reduce((n, p) => n + p.shot.durationSec, 0),
        k === ctxs.length - 1,
      ),
    ),
  ];
  if (characters.length)
    lines.push(
      `Characters (keep identities exactly as described and as in the reference images): ${characters.map((c) => identityFragment(c)).join(' ')}`,
    );
  lines.push(...elementLines(elements));
  if (v2) {
    const sound = soundBlockV2(first.settings, {
      lines: ctxs.some((c) => c.shot.dialogue.some((d) => d.line.trim())),
    });
    if (sound) lines.push(sound);
    lines.push(PHYSICS_LINE, `Avoid: ${EXCLUSIONS_MULTI}.`);
  }
  const total = ctxs.reduce((n, c) => n + c.shot.durationSec, 0);
  const framed = !!opts.firstFrameUri && opts.limits?.supports_first_frame !== false;
  // A start frame and references cannot travel together on some models (Wan 3.0); the frame wins
  const refs =
    opts.limits?.supports_reference_image === false ||
    (framed && opts.limits?.exclusive_frames_and_references)
      ? []
      : opts.referenceUris;
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
      ...(opts.limits?.supports_negative_prompt === false
        ? {}
        : { negative_prompt: v2 ? negativePromptFor(first).replace(/,\s*jump cut/, '') : BASE_NEGATIVE }),
      include_audio: false,
      camera_motion: 'auto',
      ...enhancePromptParam(first.settings),
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
