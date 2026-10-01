import { cameraMove, lensFragment, MOTION_REFERENCE_PHRASES, VARIATION_SEED_STEP } from '../directing';
import {
  approvedReferences,
  type Character,
  type CharacterReference,
  defaultWardrobe,
  REFERENCE_VIEW_PRIORITY,
  type ReferenceView,
} from '../schemas/character';
import type { EditKind, Shot } from '../schemas/clip';
import {
  approvedElementReferences,
  ELEMENT_VIEW_PRIORITY,
  type Element,
  type ElementReference,
  type ElementReferenceView,
} from '../schemas/element';
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

export function elementSeed(elementId: string): number {
  return fnv1a32(`element:${elementId}`) % MAX_SEED;
}

/**
 * R3: the seed of a shot generation: the shot's fixed seed, or one derived from the shot and its cast; attempts and
 * variations offset it (docs/design/directing.md#variations-and-comparison).
 */
export function shotSeed(
  shot: Pick<Shot, 'id'> & { seed?: number | null },
  characters: Pick<Character, 'seed'>[],
  attempt = 0,
  variation = 0,
): number {
  let s: number;
  if (shot.seed != null) s = shot.seed;
  else {
    s = fnv1a32(`shot:${shot.id}`);
    for (const c of characters) s = (s ^ c.seed) >>> 0;
  }
  return (s + attempt * 7919 + variation * VARIATION_SEED_STEP) % MAX_SEED;
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
  /** The shot's location, props and styles, in shot.elementIds order (docs/design/elements.md). */
  elements?: Element[];
  screenplay: Pick<Screenplay, 'style'> | null;
  settings: ProjectSettings;
}

export function orderedShotCharacters(
  shot: Pick<Shot, 'characterIds'>,
  all: Record<string, Character>,
): Character[] {
  return shot.characterIds.map((id) => all[id]).filter((c): c is Character => !!c);
}

/** The shot's elements: the location first, then props, then styles (each in shot.elementIds order). */
export function orderedShotElements(shot: Pick<Shot, 'elementIds'>, all: Record<string, Element>): Element[] {
  const list = (shot.elementIds ?? []).map((id) => all[id]).filter((e): e is Element => !!e);
  const rank = { location: 0, prop: 1, style: 2 } as const;
  return list
    .map((e, i) => ({ e, i }))
    .sort((a, b) => rank[a.e.kind] - rank[b.e.kind] || a.i - b.i)
    .map((x) => x.e);
}

/** An element's anchor text (rule E3): the same element always produces the same sentence. */
export function elementFragment(e: Pick<Element, 'name' | 'description'>): string {
  const d = clean(e.description);
  return d ? `${clean(e.name)} — ${d}.` : `${clean(e.name)}.`;
}

/** The element sentences of a shot prompt (location, props, styles). */
export function elementLines(elements: Element[]): string[] {
  const of = (kind: Element['kind']) => elements.filter((e) => e.kind === kind);
  const lines: string[] = [];
  const location = of('location')[0];
  if (location)
    lines.push(`Location (keep exactly as in the reference images): ${elementFragment(location)}`);
  const props = of('prop');
  if (props.length)
    lines.push(`Props (keep exactly as in the reference images): ${props.map(elementFragment).join(' ')}`);
  const styles = of('style');
  if (styles.length) lines.push(`Style reference: ${styles.map(elementFragment).join(' ')}`);
  return lines;
}

export function compileShotPrompt(
  ctx: ShotContext,
  mode: 'keyframe' | 'video',
  opts: { motionReference?: boolean } = {},
): string {
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
  // Directing controls (docs/design/directing.md): a move of the library replaces the movement; lens and aperture.
  const move = cameraMove(shot.camera.move);
  const lens = lensFragment(shot.camera);
  lines.push(
    `Camera: ${FRAMING[shot.camera.framing]}${mode === 'video' ? `, ${move ? move.phrase : MOVEMENT[shot.camera.movement]}` : ''}${lens ? `; ${lens}` : ''}.`,
  );
  if (mode === 'video' && opts.motionReference && shot.motionReference)
    lines.push(MOTION_REFERENCE_PHRASES[shot.motionReference.mode]);
  if (ctx.characters.length) {
    lines.push(
      `Characters (keep identities exactly as described and as in the reference images): ${ctx.characters.map((c) => identityFragment(c, shot)).join(' ')}`,
    );
  }
  lines.push(...elementLines(ctx.elements ?? []));
  // Lines are written into the prompt whenever they are heard, so the speakers' lips move (docs/design/dialogue.md).
  const spoken = ctx.settings.generation.includeAudio || (ctx.settings.dialogue?.mode ?? 'off') !== 'off';
  const said = shot.dialogue.filter((d) => clean(d.line));
  if (mode === 'video' && spoken && said.length) {
    const names = new Map(ctx.characters.map((c) => [c.id, c.name]));
    lines.push(
      `Dialogue: ${said.map((d) => `${d.characterId ? (names.get(d.characterId) ?? 'Someone') : 'Narrator'} says "${clean(d.line)}"`).join(' ')}.`,
    );
  }
  return lines.join(' ');
}

export interface ReferenceSelection {
  perCharacter: { characterId: string; refs: CharacterReference[] }[];
  /** True when the cast needs more images than the model accepts: compose a single cast sheet. */
  needsSheet: boolean;
  /** One reference per element (location first; docs/design/elements.md#prompt-and-references). */
  perElement: { elementId: string; refs: ElementReference[] }[];
  /** True when the elements outnumber their slots: compose one element sheet. */
  elementSheet: boolean;
}

function elementRef(e: Element): ElementReference | undefined {
  return approvedElementReferences(e)
    .slice()
    .sort(
      (a, b) =>
        ELEMENT_VIEW_PRIORITY.indexOf(a.view) - ELEMENT_VIEW_PRIORITY.indexOf(b.view) ||
        a.createdAt.localeCompare(b.createdAt),
    )[0];
}

function refRank(r: CharacterReference, wardrobeId: string | undefined): number {
  const view = REFERENCE_VIEW_PRIORITY.indexOf(r.view);
  return (wardrobeId && r.wardrobeId && r.wardrobeId !== wardrobeId ? 100 : 0) + (view < 0 ? 50 : view);
}

/**
 * Approved references per character (matching wardrobe first, then view priority) and one per element, bounded
 * by the model. Elements get a quarter of the budget (at least one image) when the cast leaves room.
 */
export function selectReferences(
  characters: Character[],
  shot: Pick<Shot, 'wardrobe'>,
  maxInputImages: number | undefined,
  perCharacterMax = 2,
  elements: Element[] = [],
): ReferenceSelection {
  const total = Math.max(1, maxInputImages ?? DEFAULT_MAX_INPUT_IMAGES);
  const withRefs = elements.filter((e) => elementRef(e));
  let elementSlots = withRefs.length ? Math.min(withRefs.length, Math.max(1, Math.floor(total / 4))) : 0;
  if (characters.length + elementSlots > total)
    elementSlots = Math.max(0, total - Math.max(1, characters.length));
  // More elements than slots: all of them go into one sheet that takes a single slot.
  const elementSheet = elementSlots > 0 && withRefs.length > elementSlots;
  const perElement = (elementSlots > 0 ? withRefs : []).map((e) => ({
    elementId: e.id,
    refs: [elementRef(e)!],
  }));
  const budget = Math.max(1, total - (elementSheet ? 1 : perElement.length));
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
      perElement,
      elementSheet,
    };
  }
  const each = Math.max(1, Math.min(perCharacterMax, Math.floor(budget / Math.max(1, characters.length))));
  return {
    perCharacter: ranked.map((r) => ({ characterId: r.characterId, refs: r.refs.slice(0, each) })),
    needsSheet: false,
    perElement,
    elementSheet,
  };
}

const ELEMENT_VIEW_PHRASE: Record<Element['kind'], Partial<Record<ElementReferenceView, string>>> = {
  location: {
    establishing: 'establishing wide shot of the place, empty of people, even natural light',
    angle: 'the reverse angle of the same place, empty of people',
    detail: 'a characteristic detail of the place',
    custom: 'the place',
  },
  prop: {
    detail: 'the object alone on a neutral light-grey background, soft studio lighting, sharp focus',
    angle: 'the same object from another angle on a neutral light-grey background',
    establishing: 'the object in context',
    custom: 'the object',
  },
  style: {
    custom: 'a style frame that shows the look: medium, palette, texture and lighting',
    establishing: 'a wide style frame',
    angle: 'a second style frame',
    detail: 'a close-up style frame',
  },
};

/** A reference-sheet image of an element (`element.refs`); the first approved view anchors the next ones. */
export function compileElementReferenceRequest(
  e: Element,
  view: ElementReferenceView,
  ctx: {
    screenplay: Pick<Screenplay, 'style'> | null;
    settings: ProjectSettings;
    baseImageUri?: string;
    model?: string;
  },
): GatewayImageRequest {
  const style = clean(ctx.screenplay?.style.visual);
  const text = [
    `Element reference sheet, ${e.kind}: ${ELEMENT_VIEW_PHRASE[e.kind][view] ?? 'reference'}; no text.`,
    `${clean(e.name)}: ${clean(e.description) || clean(e.name)}.`,
    style && e.kind !== 'style' ? `Visual style: ${style}.` : '',
    ctx.baseImageUri ? 'Keep exactly the same design as in the reference image.' : '',
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
      seed: (e.seed + ELEMENT_VIEW_PRIORITY.indexOf(view)) % MAX_SEED,
      negative_prompt: 'people, text, logo, watermark, deformed',
      output_count: 1,
    },
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
  opts: { referenceUris: string[]; attempt: number; model?: string; variation?: number },
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
      seed: shotSeed(shot, ctx.characters, opts.attempt, opts.variation),
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
    /** Dialogue (docs/design/dialogue.md): reference audio the model must accept, and whether it renders sound. */
    referenceAudioUris?: string[];
    includeAudio?: boolean;
    /** The shot's length when its dialogue needs more time than planned. */
    durationSec?: number;
    /** Directing controls (docs/design/directing.md): the end frame, the motion reference, the variation. */
    lastFrameUri?: string;
    referenceVideoUri?: string;
    variation?: number;
  },
): GatewayVideoRequest {
  const { shot, settings } = ctx;
  const refs = opts.limits?.supports_reference_image === false ? [] : opts.referenceUris;
  const referenceVideo =
    opts.referenceVideoUri && opts.limits?.supports_reference_video !== false
      ? opts.referenceVideoUri
      : undefined;
  const input: GatewayVideoRequest['input'] = [
    { type: 'text', text: compileShotPrompt(ctx, 'video', { motionReference: !!referenceVideo }) },
  ];
  if (opts.firstFrameUri && opts.limits?.supports_first_frame !== false) {
    input.push({ type: 'image', uri: opts.firstFrameUri, role: 'first_frame' });
  }
  if (opts.lastFrameUri && opts.limits?.supports_last_frame !== false)
    input.push({ type: 'image', uri: opts.lastFrameUri, role: 'last_frame' });
  for (const uri of refs) input.push({ type: 'image', uri, role: 'reference_image' });
  if (referenceVideo) input.push({ type: 'video', uri: referenceVideo, role: 'reference_video' });
  for (const uri of opts.referenceAudioUris ?? [])
    input.push({ type: 'audio', uri, role: 'reference_audio' });
  return {
    ...(opts.model && opts.model !== 'auto' ? { model: opts.model } : {}),
    input,
    parameters: {
      duration_seconds: clampDuration(opts.durationSec ?? shot.durationSec, opts.limits),
      dimensions: { width: settings.resolution.width, height: settings.resolution.height },
      seed: shotSeed(shot, ctx.characters, opts.attempt, opts.variation),
      negative_prompt: [BASE_NEGATIVE, clean(shot.negativePrompt ?? '')].filter(Boolean).join(', '),
      include_audio: opts.includeAudio ?? settings.generation.includeAudio,
      camera_motion:
        cameraMove(shot.camera.move)?.cameraMotion ?? (shot.camera.movement === 'static' ? 'fixed' : 'auto'),
    },
  };
}

const EDIT_PHRASE: Record<EditKind, (instruction: string) => string> = {
  restyle: (i) =>
    `Restyle the video: ${i}. Keep the people, their faces, the action and the camera move unchanged.`,
  relight: (i) =>
    `Relight the video: ${i}. Keep the people, their faces, the action and the camera move unchanged.`,
  replace: (i) => `Replace ${i}. Keep the people, their faces, the action and the camera move unchanged.`,
  angle: (i) =>
    `Show the same moment from a new camera angle: ${i}. Keep the people, their faces and the action.`,
  remove: (i) =>
    `Remove ${i} from the video and fill the background naturally. Keep everything else unchanged.`,
};

/**
 * A video-to-video edit of a take (docs/design/take-editing.md#edits-takeedit): the take as `reference_video`, the
 * characters' references to keep the faces, and the instruction.
 */
export function compileEditRequest(
  ctx: ShotContext,
  opts: {
    kind: EditKind;
    instruction: string;
    takeUri: string;
    referenceUris: string[];
    durationSec: number;
    attempt: number;
    model?: string;
    limits?: ModelLimits | null;
  },
): GatewayVideoRequest {
  const { shot, settings } = ctx;
  const refs = opts.limits?.supports_reference_image === false ? [] : opts.referenceUris;
  return {
    ...(opts.model && opts.model !== 'auto' ? { model: opts.model } : {}),
    input: [
      { type: 'text', text: EDIT_PHRASE[opts.kind](clean(opts.instruction)) },
      { type: 'video', uri: opts.takeUri, role: 'reference_video' },
      ...refs.map((uri) => ({ type: 'image' as const, uri, role: 'reference_image' as const })),
    ],
    parameters: {
      duration_seconds: clampDuration(opts.durationSec, opts.limits),
      dimensions: { width: settings.resolution.width, height: settings.resolution.height },
      seed: shotSeed(shot, ctx.characters, opts.attempt, 0) ^ 0x5eed,
      negative_prompt: BASE_NEGATIVE,
      include_audio: false,
    },
  };
}

/** A continuation of a take or an item (docs/design/take-editing.md#extensions-takeextend). */
export function compileExtendRequest(
  ctx: ShotContext,
  opts: {
    seconds: number;
    prompt?: string;
    firstFrameUri?: string;
    lastFrameUri?: string;
    referenceUris: string[];
    attempt: number;
    model?: string;
    limits?: ModelLimits | null;
  },
): GatewayVideoRequest {
  const req = compileVideoRequest(ctx, {
    firstFrameUri: opts.firstFrameUri,
    lastFrameUri: opts.lastFrameUri,
    referenceUris: opts.referenceUris,
    attempt: opts.attempt,
    model: opts.model,
    limits: opts.limits,
    durationSec: opts.seconds,
    variation: 7,
    includeAudio: false,
  });
  const text = req.input[0] as { type: 'text'; text: string };
  const what = clean(opts.prompt ?? '');
  text.text = `${text.text} ${
    opts.lastFrameUri
      ? `Lead into the last frame seamlessly${what ? `: ${what}` : ''}.`
      : `Continue the action seamlessly from the first frame${what ? `: ${what}` : ''}.`
  }`;
  return req;
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
