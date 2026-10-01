import { newId } from '../ids';
import { characterSeed, elementSeed } from '../prompt';
import type { EditSuggestion } from '../schemas/analysis';
import { SuggestionParamsSchema } from '../schemas/analysis';
import { type Character, type Identity, newVoice } from '../schemas/character';
import type { Shot } from '../schemas/clip';
import type { TimeRange } from '../schemas/common';
import { type Element, type ElementKind, elementIndex } from '../schemas/element';
import type {
  LlmCharacter,
  LlmElement,
  LlmIdentity,
  LlmScene,
  LlmShot,
  ScreenplayGenerateOutput,
} from '../schemas/llm';
import type { OutlineBeat, Scene, Screenplay } from '../schemas/screenplay';

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

/** Merges LLM characters into the cast: existing characters keep id, seed, references and lock (locked ones stay untouched). */
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
              ...(c.voice ? { voice: newVoice(c.voice) } : {}),
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
      camera: s.camera,
      characterIds,
      elementIds,
      wardrobe,
      dialogue: s.dialogue.map((d) => ({ characterId: resolve(d.character), line: d.line })),
      durationSec: Math.round(s.durationSec * 100) / 100,
      continuity: index === 0 ? 'cut' : s.continuity,
      promptOverride: null,
      negativePrompt: null,
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
        `Tighten a ${len.toFixed(1)}s pause`,
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
