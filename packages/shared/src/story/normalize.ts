import { fitDialogue } from '../continuity';
import { newId } from '../ids';
import { characterSeed, elementSeed } from '../prompt';
import type { EditSuggestion } from '../schemas/analysis';
import { SuggestionParamsSchema } from '../schemas/analysis';
import { type Character, type Identity, newVoice } from '../schemas/character';
import type { PlannedPlacement, Shot } from '../schemas/clip';
import type { TimeRange } from '../schemas/common';
import { type Element, type ElementKind, elementIndex } from '../schemas/element';
import type {
  ExistingNames,
  LlmCharacter,
  LlmElement,
  LlmIdentity,
  LlmScene,
  LlmShot,
  ScreenplayGenerateOutput,
} from '../schemas/llm';
import { type OutlineBeat, SCENE_CONTINUITY_MAX, type Scene, type Screenplay } from '../schemas/screenplay';

/** Case-insensitive name → character, also matching first names ("Mira" ↔ "Mira Vale"). */
export function nameIndex(characters: Pick<Character, 'id' | 'name'>[]): (name: string) => string | null {
  const exact = new Map(characters.map((c) => [c.name.trim().toLowerCase(), c.id]));
  const first = new Map<string, string | null>();
  for (const c of characters) {
    const f = c.name.trim().split(/\s+/)[0]!.toLowerCase();
    first.set(f, first.has(f) ? null : c.id);
  }
  return (name: string) => {
    const n = name.trim().toLowerCase();
    return exact.get(n) ?? first.get(n.split(/\s+/)[0] ?? '') ?? null;
  };
}

export function identityFromLlm(i: Partial<LlmIdentity>): Identity {
  const opt = (v?: string) => (v?.trim() ? v.trim() : undefined);
  return {
    age: i.age?.trim() ?? '',
    gender: i.gender?.trim() ?? '',
    ...(opt(i.ethnicity) ? { ethnicity: opt(i.ethnicity) } : {}),
    build: i.build?.trim() ?? '',
    ...(opt(i.height) ? { height: opt(i.height) } : {}),
    face: i.face?.trim() ?? '',
    hair: i.hair?.trim() ?? '',
    eyes: i.eyes?.trim() ?? '',
    skin: i.skin?.trim() ?? '',
    ...(opt(i.distinguishingMarks) ? { distinguishingMarks: opt(i.distinguishingMarks) } : {}),
  };
}

/**
 * Merges LLM characters into the cast: an existing character keeps its id, seed, references, lock and every field the
 * writer does not write (a library link, a 3D pin); a locked one stays untouched, and so does a locked voice (rule V2,
 * docs/design/dialogue.md#rules).
 */
export function mergeCharacters(llm: LlmCharacter[], existing: Character[]): Character[] {
  const byName = nameIndex(existing);
  const out: Character[] = [];
  const seen = new Set<string>();
  for (const c of llm) {
    const id = byName(c.name);
    const current = id ? existing.find((e) => e.id === id) : undefined;
    if (current && seen.has(current.id)) continue;
    const wardrobe = c.wardrobe.map((w, i) => ({
      id: newId('wardrobe'),
      name: w.name,
      description: w.description,
      ...(i === 0 ? { default: true } : {}),
    }));
    if (current) {
      seen.add(current.id);
      out.push(
        current.lock.locked
          ? current
          : {
              ...current,
              role: c.role,
              summary: c.summary || current.summary,
              identity: identityFromLlm(c.identity),
              wardrobe: wardrobe.length ? wardrobe : current.wardrobe,
              ...(c.personality ? { personality: c.personality } : {}),
              ...(c.voice && !current.voice?.lock.locked ? { voice: newVoice(c.voice) } : {}),
            },
      );
      continue;
    }
    const newIdValue = newId('character');
    out.push({
      id: newIdValue,
      name: c.name.trim(),
      role: c.role,
      summary: c.summary,
      identity: identityFromLlm(c.identity),
      wardrobe,
      ...(c.personality ? { personality: c.personality } : {}),
      ...(c.voice ? { voice: newVoice(c.voice) } : {}),
      references: [],
      seed: characterSeed(newIdValue),
      lock: { locked: false, version: 0 },
    });
  }
  for (const e of existing) if (!seen.has(e.id) && !out.some((o) => o.id === e.id)) out.push(e);
  return out;
}

/** A draft (unlocked) element for a name the writer introduced (docs/design/elements.md). */
function newElement(kind: ElementKind, name: string, description: string): Element {
  const id = newId('element');
  return {
    id,
    kind,
    name: name.trim().slice(0, 120),
    description: description.trim().slice(0, 2000),
    aliases: [],
    references: [],
    seed: elementSeed(id),
    lock: { locked: false, version: 0 },
  };
}

/**
 * Merges the writer's locations and props, plus every location and prop a scene names, into the element
 * library: existing elements (by name or alias) are kept (a missing description is filled while unlocked),
 * new names become draft elements. Returns every element, existing ones first.
 */
export function mergeElements(
  introduced: { locations: LlmElement[]; props: LlmElement[] },
  scenes: Pick<LlmScene, 'location' | 'props'>[],
  existing: Element[],
): Element[] {
  const out = existing.map((e) => ({ ...e }));
  const add = (kind: ElementKind, name: string, description = '') => {
    if (!name.trim()) return;
    const id = elementIndex(out)(kind, name);
    const current = id ? out.find((e) => e.id === id) : undefined;
    if (current) {
      if (!current.lock.locked && !current.description && description.trim())
        current.description = description.trim().slice(0, 2000);
      return;
    }
    out.push(newElement(kind, name, description));
  };
  for (const l of introduced.locations) add('location', l.name, l.description);
  for (const p of introduced.props) add('prop', p.name, p.description);
  for (const s of scenes) {
    add('location', s.location);
    for (const p of s.props) add('prop', p);
  }
  return out;
}

/**
 * How much of the project the writer is told (docs/design/continuity.md#storytelling): at most 40 characters and 80
 * locations and props, each look at most 160 characters, each element with at most 5 aliases of at most 160 characters
 * together.
 */
export const EXISTING_NAMES_LIMITS = { characters: 40, elements: 80, line: 160, aliases: 5 } as const;

const ROLE_RANK: Record<string, number> = { protagonist: 0, antagonist: 1, supporting: 2, minor: 3 };
const KIND_RANK: Record<string, number> = { location: 0, prop: 1 };

/** One line of text, cut to `max` characters with an ellipsis. */
function oneLine(text: string | undefined, max: number): string {
  const line = (text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.;,\s]+$/, '');
  return line.length <= max ? line : `${line.slice(0, max - 1).trimEnd()}…`;
}

/** A character's look in one line: age and gender, ethnicity, build, hair and marks, else its summary. */
export function lookLine(
  c: Pick<Character, 'identity' | 'summary'>,
  max: number = EXISTING_NAMES_LIMITS.line,
): string {
  const i = c.identity;
  const parts = [`${i.age ?? ''} ${i.gender ?? ''}`, i.ethnicity, i.build, i.hair, i.distinguishingMarks]
    .map((p) => oneLine(p, max))
    .filter(Boolean);
  return oneLine(parts.length ? parts.join(', ') : c.summary, max);
}

function byName(a: { name: string }, b: { name: string }): number {
  const x = a.name.trim().toLowerCase();
  const y = b.name.trim().toLowerCase();
  return x < y ? -1 : x > y ? 1 : 0;
}

/** An element's first aliases within the bounds: at most 5, of at most 160 characters together (longer ones skipped). */
function aliasesWithin(aliases: string[]): string[] {
  const { aliases: most, line } = EXISTING_NAMES_LIMITS;
  const out: string[] = [];
  let used = 0;
  for (const alias of aliases.map((a) => a.trim()).filter(Boolean)) {
    if (out.length === most) break;
    if (used + alias.length > line) continue;
    out.push(alias);
    used += alias.length;
  }
  return out;
}

/**
 * What the writer is told about the characters, places and props the project already has (a library's cast, an earlier
 * screenplay's): the names it keeps for every person, place or object of its film that is one of them
 * (docs/design/continuity.md#storytelling). Characters by role, the locked ones first, then by name; locations before
 * props, the locked ones first, then by name; styles are left out (no scene names one). Undefined when the project has
 * none, so a new project's input is as before.
 */
export function existingNames(
  characters: Pick<Character, 'name' | 'role' | 'identity' | 'summary' | 'lock'>[],
  elements: Pick<Element, 'kind' | 'name' | 'aliases' | 'lock'>[],
): ExistingNames | undefined {
  const limits = EXISTING_NAMES_LIMITS;
  const locked = (x: { lock: { locked: boolean } }) => (x.lock.locked ? 0 : 1);
  const cast = [...characters]
    .sort(
      (a, b) => (ROLE_RANK[a.role] ?? 4) - (ROLE_RANK[b.role] ?? 4) || locked(a) - locked(b) || byName(a, b),
    )
    .slice(0, limits.characters)
    .map((c) => ({ name: c.name.trim(), role: c.role, identity: lookLine(c) }));
  const places = elements
    .filter((e) => e.kind === 'location' || e.kind === 'prop')
    .sort((a, b) => KIND_RANK[a.kind]! - KIND_RANK[b.kind]! || locked(a) - locked(b) || byName(a, b))
    .slice(0, limits.elements)
    .map((e) => ({
      kind: e.kind as 'location' | 'prop',
      name: e.name.trim(),
      aliases: aliasesWithin(e.aliases),
    }));
  return cast.length || places.length ? { characters: cast, elements: places } : undefined;
}

export function sceneFromLlm(
  s: LlmScene,
  index: number,
  beatId: string | null,
  resolve: (name: string) => string | null,
  resolveElement: (kind: ElementKind, name: string) => string | null = () => null,
): Scene {
  const characterIds = [...new Set(s.characters.map(resolve).filter((x): x is string => !!x))];
  const elementIds = [
    ...new Set(s.props.map((p) => resolveElement('prop', p)).filter((x): x is string => !!x)),
  ];
  return {
    id: newId('scene'),
    index,
    beatId,
    heading: s.heading.trim(),
    location: s.location,
    timeOfDay: s.timeOfDay,
    summary: s.summary,
    action: s.action,
    dialogue: s.dialogue.map((d) => ({
      characterId: resolve(d.character),
      character: d.character,
      line: d.line,
      ...(d.parenthetical ? { parenthetical: d.parenthetical } : {}),
    })),
    characterIds,
    locationId: s.location.trim() ? resolveElement('location', s.location) : null,
    elementIds,
    estDurationSec: Math.min(3600, Math.max(5, s.estDurationSec || 60)),
    continuity: (s.continuity ?? '').trim().slice(0, SCENE_CONTINUITY_MAX),
  };
}

/** Scales beat durations so the outline covers the target within 5% (each beat kept in [5, 600] s). */
export function fitOutline(beats: { estDurationSec: number }[], targetSec: number): number[] {
  const durations = beats.map((b) => Math.min(600, Math.max(5, b.estDurationSec || 60)));
  const total = durations.reduce((a, b) => a + b, 0);
  if (total <= 0) return durations;
  if (Math.abs(total - targetSec) / targetSec <= 0.05) return durations;
  const k = targetSec / total;
  return durations.map((d) => Math.round(Math.min(600, Math.max(5, d * k)) * 10) / 10);
}

export interface ScreenplayResult {
  screenplay: Screenplay;
  characters: Character[];
  elements: Element[];
}

export function screenplayFromLlm(
  out: ScreenplayGenerateOutput,
  opts: { targetDurationSec: number; language: string; existing: Character[]; existingElements?: Element[] },
): ScreenplayResult {
  const characters = mergeCharacters(out.characters, opts.existing);
  const resolve = nameIndex(characters);
  const elements = mergeElements(out, out.scenes, opts.existingElements ?? []);
  const resolveElement = elementIndex(elements);
  const durations = fitOutline(out.outline, opts.targetDurationSec);
  const outline: OutlineBeat[] = out.outline.map((b, i) => ({
    id: newId('beat'),
    index: i,
    title: b.title,
    summary: b.summary,
    estDurationSec: durations[i]!,
    sceneId: null,
    purpose: (b.purpose ?? '').trim().toLowerCase().slice(0, 60),
  }));
  const scenes: Scene[] = [];
  out.scenes.forEach((s, i) => {
    const beat = outline[s.beatIndex ?? i] ?? outline[i] ?? null;
    const scene = sceneFromLlm(
      s,
      scenes.length,
      beat && !beat.sceneId ? beat.id : null,
      resolve,
      resolveElement,
    );
    if (beat && !beat.sceneId) {
      beat.sceneId = scene.id;
      scene.estDurationSec = beat.estDurationSec;
    }
    scenes.push(scene);
  });
  return {
    screenplay: {
      title: out.title,
      logline: out.logline,
      synopsis: out.synopsis,
      genre: out.genre,
      tone: out.tone,
      language: opts.language,
      style: out.style,
      outline,
      scenes,
      ended: out.ended,
    },
    characters,
    elements,
  };
}

/** Appends extension scenes to the screenplay, linking each to its outline beat and to its elements. */
export function appendScenes(
  sp: Screenplay,
  llm: LlmScene[],
  characters: Character[],
  elements: { existing: Element[]; introduced?: { locations: LlmElement[]; props: LlmElement[] } } = {
    existing: [],
  },
): { screenplay: Screenplay; added: Scene[]; elements: Element[] } {
  const resolve = nameIndex(characters);
  const library = mergeElements(elements.introduced ?? { locations: [], props: [] }, llm, elements.existing);
  const resolveElement = elementIndex(library);
  const outline = sp.outline.map((b) => ({ ...b }));
  const scenes = [...sp.scenes];
  const added: Scene[] = [];
  for (const s of llm) {
    const beat =
      outline.find((b) => b.index === s.beatIndex && !b.sceneId) ?? outline.find((b) => !b.sceneId);
    const scene = sceneFromLlm(s, scenes.length, beat?.id ?? null, resolve, resolveElement);
    if (beat) {
      beat.sceneId = scene.id;
      scene.estDurationSec = beat.estDurationSec;
    }
    scenes.push(scene);
    added.push(scene);
  }
  return { screenplay: { ...sp, outline, scenes }, added, elements: library };
}

/**
 * A review's revision of the screenplay (docs/design/ai-review.md#how-a-review-runs): the revised scenes replace the
 * scenes of the same number and keep their ids, index and beat (planned clips stay attached); beats of the outline
 * change by index; new places and props join the library.
 */
export function reviseScenes(
  sp: Screenplay,
  revised: (LlmScene & { number: number })[],
  outline: { index: number; title?: string; summary?: string; purpose?: string; estDurationSec?: number }[],
  characters: Character[],
  elements: { existing: Element[]; introduced?: { locations: LlmElement[]; props: LlmElement[] } } = {
    existing: [],
  },
): { screenplay: Screenplay; changed: string[]; elements: Element[] } {
  const resolve = nameIndex(characters);
  const library = mergeElements(
    elements.introduced ?? { locations: [], props: [] },
    revised,
    elements.existing,
  );
  const resolveElement = elementIndex(library);
  const ordered = [...sp.scenes].sort((a, b) => a.index - b.index);
  const beats = sp.outline.map((b) => {
    const patch = outline.find((o) => o.index === b.index);
    if (!patch) return { ...b };
    return {
      ...b,
      ...(patch.title?.trim() ? { title: patch.title.trim().slice(0, 200) } : {}),
      ...(patch.summary?.trim() ? { summary: patch.summary.trim().slice(0, 4000) } : {}),
      ...(patch.purpose?.trim() ? { purpose: patch.purpose.trim().slice(0, 60) } : {}),
      ...(patch.estDurationSec ? { estDurationSec: Math.min(3600, Math.max(5, patch.estDurationSec)) } : {}),
    };
  });
  const changed: string[] = [];
  const replaced = new Map<string, Scene>();
  for (const r of revised) {
    const old = ordered[r.number - 1];
    if (!old || replaced.has(old.id)) continue;
    const fresh = sceneFromLlm(r, old.index, old.beatId, resolve, resolveElement);
    const beat = beats.find((b) => b.id === old.beatId);
    replaced.set(old.id, {
      ...fresh,
      id: old.id,
      estDurationSec: beat?.estDurationSec ?? old.estDurationSec,
    });
    changed.push(old.id);
  }
  return {
    screenplay: { ...sp, outline: beats, scenes: sp.scenes.map((s) => replaced.get(s.id) ?? s) },
    changed,
    elements: library,
  };
}

export interface ShotPlanOptions {
  characters: Character[];
  minSec: number;
  maxSec: number;
  targetSec: number;
  /** The scene's location (on every shot) and its props (a shot keeps those the planner names). */
  locationId?: string | null;
  sceneElements?: Element[];
}

/** Deterministic post-processing of a planned shot list (docs/design/generation-pipeline.md#planning). */
export function normalizePlannedShots(planned: LlmShot[], opts: ShotPlanOptions): Shot[] {
  const resolve = nameIndex(opts.characters);
  const min = Math.max(1, opts.minSec);
  const max = Math.max(min, opts.maxSec);
  const target = Math.min(180, Math.max(10, opts.targetSec));
  type Draft = LlmShot & { continuity: 'cut' | 'continuous' };
  let drafts: Draft[] = planned.filter((s) => s.description.trim()).map((s) => ({ ...s }));
  if (!drafts.length) return [];
  const split: Draft[] = [];
  for (const s of drafts) {
    const d = Math.max(min, s.durationSec || min);
    if (d <= max) {
      split.push({ ...s, durationSec: d });
      continue;
    }
    const parts = Math.ceil(d / max);
    for (let p = 0; p < parts; p++) {
      split.push({
        ...s,
        durationSec: d / parts,
        continuity: p === 0 ? s.continuity : 'continuous',
        dialogue: p === 0 ? s.dialogue : [],
      });
    }
  }
  drafts = split;
  const total = drafts.reduce((a, s) => a + s.durationSec, 0);
  const k = target / total;
  if (Math.abs(k - 1) > 0.1) {
    for (const s of drafts) s.durationSec = Math.min(max, Math.max(min, s.durationSec * k));
  }
  // Every line speakable in its shot (docs/design/continuity.md#shot-planning).
  drafts = fitDialogue(drafts, { minSec: min, maxSec: max });
  return drafts.map((s, index) => {
    const characterIds = [...new Set(s.characters.map(resolve).filter((x): x is string => !!x))];
    const wardrobe: Record<string, string> = {};
    for (const id of characterIds) {
      const c = opts.characters.find((x) => x.id === id);
      const w = c?.wardrobe.find((x) => x.default) ?? c?.wardrobe[0];
      if (w) wardrobe[id] = w.id;
    }
    const propIndex = elementIndex(opts.sceneElements ?? []);
    const props = s.props
      .map((p) => propIndex('prop', p) ?? propIndex('style', p))
      .filter((x): x is string => !!x);
    const elementIds = [...new Set([...(opts.locationId ? [opts.locationId] : []), ...props])];
    return {
      id: newId('shot'),
      index,
      description: s.description.trim(),
      action: s.action,
      camera: { ...s.camera, ...(s.lensMm ? { lensMm: s.lensMm } : {}) },
      characterIds,
      elementIds,
      wardrobe,
      dialogue: s.dialogue.map((d) => ({ characterId: resolve(d.character), line: d.line })),
      durationSec: Math.round(s.durationSec * 100) / 100,
      continuity: index === 0 ? 'cut' : s.continuity,
      endState: (s.endState ?? '').trim().slice(0, 1000),
      // The planned layout, of the shot's own characters, once each
      layout: (s.layout ?? [])
        .map((p) => ({ characterId: resolve(p.name), side: p.side, facing: p.facing }))
        .filter(
          (p, i, all): p is PlannedPlacement =>
            !!p.characterId &&
            characterIds.includes(p.characterId) &&
            all.findIndex((q) => q.characterId === p.characterId) === i,
        ),
      promptOverride: null,
      negativePrompt: null,
      startFrame: { mode: 'auto', resourceId: null },
      endFrame: { mode: 'none', description: '', resourceId: null },
      motionReference: null,
      seed: null,
      status: 'planned',
      takes: [],
      selectedTakeId: null,
      board: null,
      lastError: null,
    };
  });
}

/** Deterministic edit suggestions from signal analysis (always available, no LLM needed). */
export function ruleSuggestions(input: {
  durationSec: number;
  silences: TimeRange[];
  blackSegments: TimeRange[];
}): EditSuggestion[] {
  const out: EditSuggestion[] = [];
  const d = input.durationSec;
  const add = (
    params: EditSuggestion['params'],
    description: string,
    rationale: string,
    confidence: number,
  ) =>
    out.push({
      id: newId('suggestion'),
      source: 'rules',
      description,
      rationale,
      confidence,
      params,
      status: 'pending',
    });
  for (const b of input.blackSegments) {
    if (b.end - b.start >= 0.3)
      add(
        { kind: 'cut', start: b.start, end: b.end },
        `Cut black frames ${b.start.toFixed(1)}–${b.end.toFixed(1)}s`,
        'Black segment detected.',
        0.9,
      );
  }
  for (const s of input.silences) {
    const len = s.end - s.start;
    if (s.start <= 0.05 && len > 0.4)
      add(
        { kind: 'cut', start: 0, end: Math.max(0, s.end - 0.2) },
        'Trim the silent start',
        'Leading silence.',
        0.8,
      );
    else if (s.end >= d - 0.05 && len > 0.6)
      add({ kind: 'cut', start: s.start + 0.3, end: d }, 'Trim the silent ending', 'Trailing silence.', 0.75);
    else if (len > 1.2)
      add(
        { kind: 'tighten_silence', start: s.start, end: s.end, keepSec: 0.4 },
        // the definite article fits every length ("a 8.0s" would not: the article follows the spoken number)
        `Tighten the ${len.toFixed(1)}s pause`,
        'Long silence slows the pace.',
        0.7,
      );
  }
  if (d > 4) add({ kind: 'fade', in: 0.5, out: 1 }, 'Fade in and out', 'Softer start and ending.', 0.6);
  return out;
}

/** Converts a flat LLM suggestion into a validated EditSuggestion (invalid ones are dropped). */
export function suggestionFromLlm(raw: Record<string, unknown>, durationSec: number): EditSuggestion | null {
  const { description, rationale, confidence, ...params } = raw as {
    description?: string;
    rationale?: string;
    confidence?: number;
  } & Record<string, unknown>;
  const parsed = SuggestionParamsSchema.safeParse(params);
  if (!parsed.success) return null;
  const p = parsed.data;
  const inRange = (t: number) => t >= 0 && t <= durationSec + 0.05;
  if ('start' in p && 'end' in p && (!(p.end > p.start) || !inRange(p.start) || !inRange(p.end))) return null;
  if (p.kind === 'transition' && !inRange(p.at)) return null;
  if (p.kind === 'title' && !inRange(p.start)) return null;
  return {
    id: newId('suggestion'),
    source: 'ai',
    description: String(description ?? p.kind).slice(0, 1000),
    rationale: String(rationale ?? '').slice(0, 2000),
    confidence: typeof confidence === 'number' && confidence >= 0 && confidence <= 1 ? confidence : 0.5,
    params: p,
    status: 'pending',
  };
}
