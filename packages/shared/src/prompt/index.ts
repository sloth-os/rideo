import {
  approvedReferences,
  type Character,
  type CharacterReference,
  defaultWardrobe,
  REFERENCE_VIEW_PRIORITY,
  type ReferenceView,
} from '../schemas/character';
import type { Shot } from '../schemas/clip';
import type { GatewayImageRequest, GatewayVideoRequest, ModelLimits } from '../schemas/gateway';
import type { ProjectSettings } from '../schemas/project';
import type { Screenplay } from '../schemas/screenplay';
import { fnv1a32 } from '../util/hash';

/**
 * Deterministic conditioning (rule R3, docs/design/character-consistency.md): every generation request is
 * compiled here from locked identities; the same inputs always produce byte-identical prompts.
 */
export const BASE_NEGATIVE =
  'different person, changed face, inconsistent outfit, age change, extra people, deformed anatomy, text, logo, watermark';

export const DEFAULT_VIDEO_LIMITS = { min: 4, max: 10 };
export const DEFAULT_MAX_INPUT_IMAGES = 4;

const MAX_SEED = 2147483647;

export function characterSeed(characterId: string): number {
  return fnv1a32(`character:${characterId}`) % MAX_SEED;
}

export function shotSeed(shot: Pick<Shot, 'id'>, characters: Pick<Character, 'seed'>[], attempt = 0): number {
  let s = fnv1a32(`shot:${shot.id}`);
  for (const c of characters) s = (s ^ c.seed) >>> 0;
  return (s + attempt * 7919) % MAX_SEED;
}

function clean(s: string | undefined): string {
  return (s ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.;,\s]+$/, '');
}

export function wardrobeFor(c: Character, shot?: Pick<Shot, 'wardrobe'>) {
  const id = shot?.wardrobe[c.id];
  return (id ? c.wardrobe.find((w) => w.id === id) : undefined) ?? defaultWardrobe(c);
}

/** The identity anchor text, in a fixed field order. */
export function identityFragment(c: Character, shot?: Pick<Shot, 'wardrobe'>): string {
  const i = c.identity;
  const who = [clean(`${i.age} ${i.gender}`), clean(i.ethnicity), clean(i.build), clean(i.height)].filter(
    Boolean,
  );
  const traits = [
    ['face', i.face],
    ['hair', i.hair],
    ['eyes', i.eyes],
    ['skin', i.skin],
    ['distinguishing marks', i.distinguishingMarks],
  ]
    .map(([k, v]) => [k, clean(v)] as const)
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}: ${v}`);
  let text = `${c.name}: ${who.join(', ')}`;
  if (traits.length) text += `; ${traits.join('; ')}`;
  const w = wardrobeFor(c, shot);
  text += '.';
  if (w && clean(w.description)) text += ` Wearing: ${clean(w.description)}.`;
  return text;
}

export function styleHeader(
  screenplay: Pick<Screenplay, 'style'> | null,
  settings: Pick<ProjectSettings, 'aspectRatio'>,
  mode: 'still' | 'motion',
): string {
  const s = screenplay?.style;
  const parts = [
    mode === 'still'
      ? `Cinematic film frame, ${settings.aspectRatio}`
      : `Cinematic shot, ${settings.aspectRatio}`,
  ];
  if (clean(s?.visual)) parts.push(`visual style: ${clean(s?.visual)}`);
  if (clean(s?.palette)) parts.push(`palette: ${clean(s?.palette)}`);
  if (clean(s?.lighting)) parts.push(`lighting: ${clean(s?.lighting)}`);
  if (mode === 'motion' && clean(s?.camera)) parts.push(`camera style: ${clean(s?.camera)}`);
  return `${parts.join('; ')}.`;
}

const FRAMING: Record<Shot['camera']['framing'], string> = {
  extreme_wide: 'extreme wide shot',
  wide: 'wide shot',
  medium: 'medium shot',
  medium_close: 'medium close-up',
  close_up: 'close-up',
  extreme_close_up: 'extreme close-up',
  over_shoulder: 'over-the-shoulder shot',
  pov: 'point-of-view shot',
  insert: 'insert shot',
};

const MOVEMENT: Record<Shot['camera']['movement'], string> = {
  static: 'static camera',
  pan: 'slow pan',
  tilt: 'slow tilt',
  dolly_in: 'dolly in',
  dolly_out: 'dolly out',
  tracking: 'tracking shot',
  handheld: 'handheld camera',
  crane: 'crane move',
  zoom: 'slow zoom',
  orbit: 'orbiting camera',
};

export interface ShotContext {
  shot: Shot;
  /** Characters appearing in the shot, in shot.characterIds order. */
  characters: Character[];
  screenplay: Pick<Screenplay, 'style'> | null;
  settings: ProjectSettings;
}

export function orderedShotCharacters(
  shot: Pick<Shot, 'characterIds'>,
  all: Record<string, Character>,
): Character[] {
  return shot.characterIds.map((id) => all[id]).filter((c): c is Character => !!c);
}

export function compileShotPrompt(ctx: ShotContext, mode: 'keyframe' | 'video'): string {
  const { shot } = ctx;
  const lines: string[] = [
    styleHeader(ctx.screenplay, ctx.settings, mode === 'keyframe' ? 'still' : 'motion'),
  ];
  if (shot.promptOverride && clean(shot.promptOverride)) {
    lines.push(`${clean(shot.promptOverride)}.`);
  } else {
    lines.push(`${clean(shot.description)}.`);
    if (mode === 'video' && clean(shot.action)) lines.push(`Action: ${clean(shot.action)}.`);
  }
  lines.push(
    `Camera: ${FRAMING[shot.camera.framing]}${mode === 'video' ? `, ${MOVEMENT[shot.camera.movement]}` : ''}.`,
  );
  if (ctx.characters.length) {
    lines.push(
      `Characters (keep identities exactly as described and as in the reference images): ${ctx.characters.map((c) => identityFragment(c, shot)).join(' ')}`,
    );
  }
  if (mode === 'video' && ctx.settings.generation.includeAudio && shot.dialogue.length) {
    const names = new Map(ctx.characters.map((c) => [c.id, c.name]));
    lines.push(
      `Dialogue: ${shot.dialogue.map((d) => `${d.characterId ? (names.get(d.characterId) ?? 'Someone') : 'Narrator'} says "${clean(d.line)}"`).join(' ')}.`,
    );
  }
  return lines.join(' ');
}

export interface ReferenceSelection {
  perCharacter: { characterId: string; refs: CharacterReference[] }[];
  /** True when the cast needs more images than the model accepts: compose a single cast sheet. */
  needsSheet: boolean;
}

function refRank(r: CharacterReference, wardrobeId: string | undefined): number {
  const view = REFERENCE_VIEW_PRIORITY.indexOf(r.view);
  return (wardrobeId && r.wardrobeId && r.wardrobeId !== wardrobeId ? 100 : 0) + (view < 0 ? 50 : view);
}

/** Approved references per character: matching wardrobe first, then view priority; bounded by the model. */
export function selectReferences(
  characters: Character[],
  shot: Pick<Shot, 'wardrobe'>,
  maxInputImages: number | undefined,
  perCharacterMax = 2,
): ReferenceSelection {
  const budget = Math.max(1, maxInputImages ?? DEFAULT_MAX_INPUT_IMAGES);
  const ranked = characters.map((c) => {
    const w = wardrobeFor(c, shot)?.id;
    const refs = approvedReferences(c)
      .slice()
      .sort((a, b) => refRank(a, w) - refRank(b, w) || a.createdAt.localeCompare(b.createdAt));
    return { characterId: c.id, refs };
  });
  if (characters.length > budget) {
    return {
      perCharacter: ranked.map((r) => ({ characterId: r.characterId, refs: r.refs.slice(0, 1) })),
      needsSheet: true,
    };
  }
  const each = Math.max(1, Math.min(perCharacterMax, Math.floor(budget / Math.max(1, characters.length))));
  return {
    perCharacter: ranked.map((r) => ({ characterId: r.characterId, refs: r.refs.slice(0, each) })),
    needsSheet: false,
  };
}

export function clampDuration(
  sec: number,
  limits?: Pick<ModelLimits, 'min_duration_seconds' | 'max_duration_seconds'> | null,
): number {
  const min = limits?.min_duration_seconds ?? DEFAULT_VIDEO_LIMITS.min;
  const max = limits?.max_duration_seconds ?? DEFAULT_VIDEO_LIMITS.max;
  return Math.round(Math.min(max, Math.max(min, sec)) * 100) / 100;
}

export function compileKeyframeRequest(
  ctx: ShotContext,
  opts: { referenceUris: string[]; attempt: number; model?: string },
): GatewayImageRequest {
  const { shot, settings } = ctx;
  return {
    ...(opts.model && opts.model !== 'auto' ? { model: opts.model } : {}),
    input: [
      { type: 'text', text: compileShotPrompt(ctx, 'keyframe') },
      ...opts.referenceUris.map((uri) => ({ type: 'image' as const, uri })),
    ],
    parameters: {
      dimensions: { width: settings.resolution.width, height: settings.resolution.height },
      seed: shotSeed(shot, ctx.characters, opts.attempt),
      negative_prompt: [BASE_NEGATIVE, clean(shot.negativePrompt ?? '')].filter(Boolean).join(', '),
      output_count: 1,
    },
  };
}

export function compileVideoRequest(
  ctx: ShotContext,
  opts: {
    firstFrameUri?: string;
    referenceUris: string[];
    attempt: number;
    model?: string;
    limits?: ModelLimits | null;
  },
): GatewayVideoRequest {
  const { shot, settings } = ctx;
  const refs = opts.limits?.supports_reference_image === false ? [] : opts.referenceUris;
  const input: GatewayVideoRequest['input'] = [{ type: 'text', text: compileShotPrompt(ctx, 'video') }];
  if (opts.firstFrameUri && opts.limits?.supports_first_frame !== false) {
    input.push({ type: 'image', uri: opts.firstFrameUri, role: 'first_frame' });
  }
  for (const uri of refs) input.push({ type: 'image', uri, role: 'reference_image' });
  return {
    ...(opts.model && opts.model !== 'auto' ? { model: opts.model } : {}),
    input,
    parameters: {
      duration_seconds: clampDuration(shot.durationSec, opts.limits),
      dimensions: { width: settings.resolution.width, height: settings.resolution.height },
      seed: shotSeed(shot, ctx.characters, opts.attempt),
      negative_prompt: [BASE_NEGATIVE, clean(shot.negativePrompt ?? '')].filter(Boolean).join(', '),
      include_audio: settings.generation.includeAudio,
      camera_motion: shot.camera.movement === 'static' ? 'fixed' : 'auto',
    },
  };
}

const VIEW_PHRASE: Record<ReferenceView, string> = {
  front: 'front view, facing the camera, head and shoulders',
  three_quarter: 'three-quarter view, head and shoulders',
  profile: 'side profile view',
  full_body: 'full body, standing, head to toe',
  expression: 'expressive close-up portrait',
  custom: 'portrait',
};

export function referenceDimensions(settings: Pick<ProjectSettings, 'resolution'>): {
  width: number;
  height: number;
} {
  const side = Math.max(256, Math.min(1024, Math.max(settings.resolution.width, settings.resolution.height)));
  const even = side - (side % 16);
  return { width: even, height: even };
}

export function compileReferenceRequest(
  c: Character,
  view: ReferenceView,
  ctx: {
    screenplay: Pick<Screenplay, 'style'> | null;
    settings: ProjectSettings;
    baseImageUri?: string;
    model?: string;
  },
): GatewayImageRequest {
  const style = clean(ctx.screenplay?.style.visual);
  const text = [
    `Character reference sheet, ${VIEW_PHRASE[view]}; neutral light-grey background, even soft studio lighting, sharp focus, no text.`,
    identityFragment(c),
    style ? `Visual style: ${style}.` : '',
    ctx.baseImageUri ? 'Keep exactly the same person as in the reference image.' : '',
  ]
    .filter(Boolean)
    .join(' ');
  return {
    ...(ctx.model && ctx.model !== 'auto' ? { model: ctx.model } : {}),
    input: [
      { type: 'text', text },
      ...(ctx.baseImageUri ? [{ type: 'image' as const, uri: ctx.baseImageUri }] : []),
    ],
    parameters: {
      dimensions: referenceDimensions(ctx.settings),
      seed: (c.seed + REFERENCE_VIEW_PRIORITY.indexOf(view)) % MAX_SEED,
      negative_prompt: BASE_NEGATIVE,
      output_count: 1,
    },
  };
}
