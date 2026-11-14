import { compactIdentity } from '../prompt';
import { type DeskBrief, DeskBriefSchema, type DeskTimeOfDay } from '../schemas/desk';
import type { ProjectDocs } from '../schemas/documents';
import type { ElementKind } from '../schemas/element';
import type { ProjectSettings } from '../schemas/project';

/**
 * The brief of a clip for the 3D-Editor's desk (docs/design/director-desk.md#the-brief): a pure mapping of rideo's
 * documents, row by row of the design's table, validated against the protocol's schema before it leaves rideo.
 */

/** The protocol's limits (the brief keeps the first ones, in order). */
export const DESK_BRIEF_LIMITS = {
  cast: 16,
  elements: 64,
  shots: 200,
  name: 200,
  setDescription: 4000,
  castDescription: 4000,
  elementDescription: 2000,
  shotText: 4000,
  movement: 60,
  layout: 8,
} as const;

/** `text` cut to `max` characters, never between the halves of a surrogate pair. */
export function cutText(text: string, max: number): string {
  if (text.length <= max) return text;
  let out = text.slice(0, max);
  const last = out.charCodeAt(out.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) out = out.slice(0, -1);
  return out.trimEnd();
}

/** Rounded down to an even number: the desk's clips are H.264 4:2:0. */
export function evenDown(n: number): number {
  const i = Math.floor(n);
  return i - (i % 2);
}

/**
 * The frame rate and size of a project's desk clips: `settings.fps` (12–60, within the protocol's 1–120) and the
 * resolution (64–4096) rounded down to even numbers (the protocol takes even sizes of 16–4096).
 */
export function deskFormat(settings: Pick<ProjectSettings, 'fps' | 'resolution'>): {
  fps: number;
  width: number;
  height: number;
} {
  return {
    fps: settings.fps,
    width: evenDown(settings.resolution.width),
    height: evenDown(settings.resolution.height),
  };
}

/** A shot's frames at a frame rate: max(1, round(durationSec × fps)). */
export function deskFrames(durationSec: number, fps: number): number {
  return Math.max(1, Math.round(durationSec * fps));
}

const clean = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();

/** A text as a sentence: one line, ending with a full stop. */
function sentence(s: string | null | undefined): string {
  const t = clean(s).replace(/[;,:\s]+$/, '');
  if (!t) return '';
  return /[.!?…"”')]$/.test(t) ? t : `${t}.`;
}

/** `INT.` true, `EXT.` false; `INT./EXT.`, `I/E`, `EST.` or none: null (the desk decides from the words). */
export function headingInterior(heading: string): boolean | null {
  const h = heading.trim().replace(/^\./, '').toUpperCase();
  if (/^(INT\.?\s*\/\s*EXT|EXT\.?\s*\/\s*INT|I\s*\/\s*E|E\s*\/\s*I)\b/.test(h)) return null;
  if (/^(INT|INTERIOR)\b/.test(h)) return true;
  if (/^(EXT|EXTERIOR)\b/.test(h)) return false;
  return null;
}

/** The time a heading ends with (`INT. LAMP ROOM - NIGHT` → `NIGHT`); '' when it names none. */
export function headingTime(heading: string): string {
  const parts = heading.split(/\s+[-–—]\s+/);
  return parts.length > 1 ? clean(parts[parts.length - 1]) : '';
}

/** The first rule that matches gives the time of day; anything else (`day`, `continuous`, `later`) is none. */
const TIME_RULES: readonly (readonly [RegExp, DeskTimeOfDay])[] = [
  [/\b(dawn|sunrise|daybreak|first light|early morning)\b/i, 'dawn'],
  [/\b(golden hour|magic hour)\b/i, 'golden_hour'],
  [/\b(dusk|sunset|twilight|evening)\b/i, 'dusk'],
  [/\b(night|nighttime|midnight)\b/i, 'night'],
  [/\b(noon|midday)\b/i, 'noon'],
  [/\bafternoon\b/i, 'afternoon'],
  [/\bmorning\b/i, 'morning'],
];

export function deskTimeOfDay(text: string): DeskTimeOfDay | null {
  for (const [re, time] of TIME_RULES) if (re.test(text)) return time;
  return null;
}

/** Measures a height may be written in, to metres. */
const HEIGHT_UNITS: readonly { re: RegExp; metres: (m: RegExpExecArray) => number }[] = [
  { re: /(\d+(?:\.\d+)?)\s*(?:cm|centimet(?:er|re)s?)\b/, metres: (m) => Number(m[1]) / 100 },
  { re: /(\d+(?:\.\d+)?)\s*(?:mm|millimet(?:er|re)s?)\b/, metres: (m) => Number(m[1]) / 1000 },
  { re: /(\d+(?:\.\d+)?)\s*(?:m|met(?:er|re)s?)\b/, metres: (m) => Number(m[1]) },
  {
    re: /(\d+)\s*(?:ft|feet|foot|'|′)\s*(?:(\d+(?:\.\d+)?)\s*(?:in\b|inch(?:es)?\b|"|″)?)?/,
    metres: (m) => Number(m[1]) * 0.3048 + Number(m[2] ?? 0) * 0.0254,
  },
];

/** The height an identity names ("170 cm", "1.2 m", "5 ft 8 in"), in metres to the centimetre, 0.1–4; else null. */
export function heightInMetres(text: string | null | undefined): number | null {
  const t = (text ?? '').toLowerCase().replace(/(\d),(\d)/g, '$1.$2');
  for (const unit of HEIGHT_UNITS) {
    const m = unit.re.exec(t);
    if (!m) continue;
    const metres = Math.round(unit.metres(m) * 100) / 100;
    return Number.isFinite(metres) && metres >= 0.1 && metres <= 4 ? metres : null;
  }
  return null;
}

const ELEMENT_KINDS: Record<ElementKind, DeskBrief['elements'][number]['kind']> = {
  location: 'location',
  prop: 'prop',
  // the desk stages no style
  style: 'other',
};

/** Ids in order of first appearance, once each, those `keep` accepts, at most `max`. */
function firsts(ids: Iterable<string | null | undefined>, keep: (id: string) => boolean, max: number) {
  const out: string[] = [];
  for (const id of ids) {
    if (out.length >= max) break;
    if (id && !out.includes(id) && keep(id)) out.push(id);
  }
  return out;
}

/**
 * The `SceneBrief` of a clip (docs/design/director-desk.md#the-brief), or null for a clip that is not there or has
 * no shots. The same brief goes to the desk in the studio and to agents (`desk_brief`).
 */
export function deskBrief(
  docs: Pick<ProjectDocs, 'project' | 'screenplay' | 'characters' | 'elements' | 'clips'>,
  clipId: string,
): DeskBrief | null {
  const clip = docs.clips[clipId];
  if (!clip?.shots.length) return null;
  const L = DESK_BRIEF_LIMITS;
  const shots = [...clip.shots].sort((a, b) => a.index - b.index).slice(0, L.shots);
  const scene = clip.sceneId ? docs.screenplay?.scenes.find((s) => s.id === clip.sceneId) : undefined;
  const location = scene?.locationId ? docs.elements[scene.locationId] : undefined;
  const castIds = firsts(
    shots.flatMap((s) => s.characterIds),
    (id) => !!docs.characters[id],
    L.cast,
  );
  const elementIds = firsts(
    [scene?.locationId, ...(scene?.elementIds ?? []), ...shots.flatMap((s) => s.elementIds)],
    (id) => !!docs.elements[id],
    L.elements,
  );
  const inCast = new Set(castIds);
  const inElements = new Set(elementIds);
  const place = scene ? clean(scene.location) || clean(location?.name) || clean(scene.heading) : '';
  const { fps, width, height } = deskFormat(docs.project.settings);
  const brief: DeskBrief = {
    id: clip.id,
    name: cutText(clean(clip.title), L.name) || `Scene ${clip.index + 1}`,
    fps,
    width,
    height,
    set: {
      description: cutText(
        [place, location?.description, scene?.continuity].map(sentence).filter(Boolean).join(' '),
        L.setDescription,
      ),
      interior: scene ? headingInterior(scene.heading) : null,
      timeOfDay: scene ? deskTimeOfDay(clean(scene.timeOfDay) || headingTime(scene.heading)) : null,
    },
    cast: castIds.map((id) => {
      const c = docs.characters[id]!;
      return {
        id: c.id,
        name: cutText(clean(c.name), 120) || c.id,
        description: cutText(
          [compactIdentity(c), sentence(c.summary)].filter(Boolean).join(' '),
          L.castDescription,
        ),
        // rideo has no species field: the desk reads it from the description
        kind: null,
        heightM: heightInMetres(c.identity.height),
      };
    }),
    elements: elementIds.map((id) => {
      const e = docs.elements[id]!;
      return {
        id: e.id,
        name: cutText(clean(e.name), 120) || e.id,
        description: cutText(e.description, L.elementDescription),
        kind: ELEMENT_KINDS[e.kind],
      };
    }),
    shots: shots.map((s, index) => ({
      id: s.id,
      index,
      durationSec: s.durationSec,
      description: cutText(s.description, L.shotText),
      action: cutText(s.action, L.shotText),
      castIds: firsts(s.characterIds, (id) => inCast.has(id), L.cast),
      elementIds: firsts(s.elementIds, (id) => inElements.has(id), L.elements),
      framing: s.camera.framing ?? null,
      movement: s.camera.movement ? cutText(s.camera.movement, L.movement) : null,
      move: s.camera.move ?? null,
      lensMm: s.camera.lensMm ?? null,
      continuity: s.continuity,
      layout: s.layout
        .filter((p) => inCast.has(p.characterId))
        .slice(0, L.layout)
        .map((p) => ({ castId: p.characterId, side: p.side, facing: p.facing })),
    })),
  };
  return DeskBriefSchema.parse(brief);
}
