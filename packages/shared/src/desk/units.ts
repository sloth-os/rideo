import type { Clip } from '../schemas/clip';
import {
  DESK_UNIT_LIMITS,
  type DeskBrief,
  type DeskBriefPin,
  type DeskStateUnitUse,
  DeskStateUnitUseSchema,
  type DeskUnitFileKind,
} from '../schemas/desk';
import type { ProjectDocs } from '../schemas/documents';
import type { DigestLibraryUse } from '../schemas/library';
import { type DeskUnitKind, LIBRARY_MAX_VERSIONS, LibraryItemIdSchema } from '../schemas/library-link';
import { deskBrief } from './brief';

/**
 * Library units in the desk (docs/design/director-desk.md#library-units), the pure parts: the brief's pins slot by
 * slot, what a stored state uses (`X-Desk-State-Units`), the drift of a clip's pins from its stored state (the
 * Storyboard's 3D badge) and what the clips' stored states use for the project's digest.
 */

/** The library kind of each unit file kind. */
export const DESK_UNIT_LIBRARY_KIND: Record<DeskUnitFileKind, DeskUnitKind> = {
  set: 'desk-set',
  prop: 'desk-prop',
  figure: 'desk-figure',
};

/** A pin of a brief and its slot: `set`, `cast:<id>`, `el:<id>`. */
export interface DeskBriefPinSlot {
  slot: string;
  kind: DeskUnitFileKind;
  pin: DeskBriefPin;
}

/** The pins of a brief in slot order (the set, the cast, the elements): the order `open.units` is sent in. */
export function deskBriefPins(brief: DeskBrief): DeskBriefPinSlot[] {
  const out: DeskBriefPinSlot[] = [];
  if (brief.set.unit) out.push({ slot: 'set', kind: 'set', pin: brief.set.unit });
  for (const c of brief.cast) if (c.unit) out.push({ slot: `cast:${c.id}`, kind: 'figure', pin: c.unit });
  for (const e of brief.elements) if (e.unit) out.push({ slot: `el:${e.id}`, kind: 'prop', pin: e.unit });
  return out;
}

/**
 * The pins whose files go in an open (docs/design/director-desk.md#unit-bytes-in-open): in slot order, each
 * `ref@version` once, without the pins of a slot the state handed over needs no file for: its row is staged `unit`
 * and names the same item and version, or says `local` (a slot made local takes no unit again, whatever its pin is
 * now). `uses` null (not known): every pin goes.
 */
export function deskUnitPinsToSend(
  pins: readonly DeskBriefPinSlot[],
  uses: readonly DeskStateUnitUse[] | null | undefined,
): DeskBriefPinSlot[] {
  const rows = new Map((uses ?? []).map((u) => [u.slot, u]));
  const seen = new Set<string>();
  const out: DeskBriefPinSlot[] = [];
  for (const p of pins) {
    const row = rows.get(p.slot);
    if (row?.staged === 'unit' && (row.local || (row.ref === p.pin.ref && row.version === p.pin.version)))
      continue;
    const key = `${p.pin.ref}@${p.pin.version}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}

// ---------------------------------------------------------------- X-Desk-State-Units

/** The header a desk-state write names what the state uses with (docs/design/director-desk.md#what-a-stored-state-uses). */
export const DESK_STATE_UNITS_HEADER = 'x-desk-state-units';

/** A header that does not parse: the write is refused (`422`). */
export class DeskStateUnitsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeskStateUnitsError';
  }
}

/** One row: `<slot>=<ref>@<version>:<staged>[:local][:<why>]`. */
const formatRow = (u: DeskStateUnitUse) =>
  `${u.slot}=${u.ref}@${u.version}:${u.staged}${u.local ? ':local' : ''}${u.why ? `:${u.why}` : ''}`;

/**
 * The `X-Desk-State-Units` value of what a state uses: its rows joined by `, `, `-` for none, and no header
 * (undefined) when not known, or when the rows do not fit (more than 128, over 8 KiB, a slot named twice, which
 * `parseDeskStateUnits` refuses): the write goes on with the units unknown.
 */
export function formatDeskStateUnits(
  rows: readonly DeskStateUnitUse[] | null | undefined,
): string | undefined {
  if (!rows) return undefined;
  if (rows.length === 0) return '-';
  if (rows.length > DESK_UNIT_LIMITS.stateUnits) return undefined;
  if (new Set(rows.map((r) => r.slot)).size < rows.length) return undefined;
  const value = rows.map(formatRow).join(', ');
  return value.length > DESK_UNIT_LIMITS.headerBytes ? undefined : value;
}

/**
 * What an `X-Desk-State-Units` value says: the rows (`[]` for `-`), or null without the header (not known). A value
 * that does not parse, names a slot twice, or is over 128 rows or 8 KiB throws `DeskStateUnitsError`.
 */
export function parseDeskStateUnits(value: string | undefined): DeskStateUnitUse[] | null {
  if (value === undefined) return null;
  if (value.length > DESK_UNIT_LIMITS.headerBytes)
    throw new DeskStateUnitsError(`at most ${DESK_UNIT_LIMITS.headerBytes} bytes`);
  const text = value.trim();
  if (text === '-') return [];
  if (!text) throw new DeskStateUnitsError("no rows: '-' says none");
  const parts = text.split(/\s*,\s*/);
  if (parts.length > DESK_UNIT_LIMITS.stateUnits)
    throw new DeskStateUnitsError(`at most ${DESK_UNIT_LIMITS.stateUnits} rows`);
  const rows: DeskStateUnitUse[] = [];
  const slots = new Set<string>();
  for (const part of parts) {
    const row = parseRow(part);
    if (!row)
      throw new DeskStateUnitsError(
        `"${part.slice(0, 80)}" is not <slot>=<ref>@<version>:<staged>[:local][:<why>]`,
      );
    if (slots.has(row.slot)) throw new DeskStateUnitsError(`${row.slot} is named twice`);
    slots.add(row.slot);
    rows.push(row);
  }
  return rows;
}

function parseRow(part: string): DeskStateUnitUse | null {
  // the slot, the ref and the reason never hold `=`, `@`, `,` or spaces; a slot's id may hold `:`
  const eq = part.indexOf('=');
  const at = part.indexOf('@', eq + 1);
  if (eq < 1 || at < 0) return null;
  const [version, staged, ...rest] = part.slice(at + 1).split(':');
  const local = rest[0] === 'local';
  if (local) rest.shift();
  if (rest.length > 1 || !version || !/^[1-9][0-9]{0,9}$/.test(version)) return null;
  const row = DeskStateUnitUseSchema.safeParse({
    slot: part.slice(0, eq),
    ref: part.slice(eq + 1, at),
    version: Number(version),
    staged,
    local,
    ...(rest.length ? { why: rest[0] } : {}),
  });
  return row.success ? row.data : null;
}

// ---------------------------------------------------------------- drift: the Storyboard's 3D badge

/**
 * How a pinned slot of a clip's brief stands against what the clip's stored state uses
 * (docs/design/director-desk.md#drift-the-storyboard-badge).
 */
export type DeskUnitDriftStatus =
  | 'current'
  | 'update'
  | 'pending'
  | 'refused'
  | 'local'
  | 'unknown'
  | 'approved';

export interface DeskUnitDrift {
  slot: string;
  kind: DeskUnitFileKind;
  /** What the slot stages: the scene's place, a character, a prop. */
  label: string;
  /** The entity's pin: the library item, the version and the item's name when it was pinned. */
  pin: { itemId: string; version: number; name: string };
  /** What the stored state uses for the slot; null when it has no row or its units are not known. */
  used: DeskStateUnitUse | null;
  status: DeskUnitDriftStatus;
}

const SLOT_NOUN: Record<DeskUnitFileKind, string> = { set: 'set', prop: 'prop', figure: 'figure' };

/**
 * The drift of every pinned slot of a clip's brief (all three kinds) from what its stored state uses. A clip without
 * a stored state has none (its first open stages with the pins); a state whose units are not known gives `unknown`.
 */
export function deskUnitDrift(
  docs: Pick<ProjectDocs, 'project' | 'screenplay' | 'characters' | 'elements' | 'clips'>,
  clipId: string,
): DeskUnitDrift[] {
  const clip = Object.hasOwn(docs.clips, clipId) ? docs.clips[clipId] : undefined;
  if (!clip?.deskState) return [];
  let brief: DeskBrief | null;
  try {
    brief = deskBrief(docs, clipId, { units: { kinds: ['set', 'prop', 'figure'] } });
  } catch {
    return [];
  }
  if (!brief) return [];
  const units = clip.deskState.units ?? null;
  const scene = clip.sceneId ? docs.screenplay?.scenes.find((s) => s.id === clip.sceneId) : undefined;
  const approved = clip.status === 'approved';
  return deskBriefPins(brief).map(({ slot, kind, pin }) => {
    const own = <T>(record: Readonly<Record<string, T>>, id: string | null | undefined) =>
      id && Object.hasOwn(record, id) ? record[id] : undefined;
    const entity =
      slot === 'set'
        ? own(docs.elements, scene?.locationId)
        : slot.startsWith('cast:')
          ? own(docs.characters, slot.slice(5))
          : own(docs.elements, slot.slice(3));
    const label = entity?.name.trim() || (slot === 'set' ? "the scene's place" : slot);
    const name = entity?.deskUnit?.name ?? `3D ${SLOT_NOUN[kind]}`;
    const used = units?.find((u) => u.slot === slot) ?? null;
    return {
      slot,
      kind,
      label,
      pin: { itemId: pin.ref, version: pin.version, name },
      used,
      status: driftStatus(units === null, approved, pin, used),
    };
  });
}

function driftStatus(
  unknown: boolean,
  approved: boolean,
  pin: DeskBriefPin,
  used: DeskStateUnitUse | null,
): DeskUnitDriftStatus {
  if (unknown) return 'unknown';
  // a slot made local stays local whatever its pin becomes: the desk never puts a unit back in it
  if (used?.staged === 'unit' && used.local) return 'local';
  const uses = !!used && used.ref === pin.ref && used.version === pin.version;
  if (uses && used.staged === 'unit') return 'current';
  // an approved clip keeps its stored state: it does not use the pinned version, and nothing updates it
  if (approved) return 'approved';
  if (!uses) return 'update';
  return used.staged === 'pending' ? 'pending' : 'refused';
}

/** Why a pin waits or was refused, in words. */
const REASONS: Record<string, string> = {
  missing: 'it was not sent to the desk',
  mismatch: 'its file did not match',
  unavailable: 'the desk could not use it this time',
  unreadable: 'the desk cannot read it',
  too_new: 'a newer desk made it',
  too_large: 'it is over 32 MiB',
  wrong_kind: 'it is another kind of unit',
  figure_kind: "the figure is not of the staged actor's kind (or of a kind the desk does not build)",
  figure_rig: "the figure does not fit the staged actor's rig or height (±5 mm)",
  over_budget: 'it is larger than one desk staging takes',
  set_ground: 'its ground is not at height 0',
};

/** One slot's line of the badge's tooltip. */
export function deskUnitDriftLine(d: DeskUnitDrift): string {
  const pinned = `${d.pin.name} v${d.pin.version}`;
  const why = d.used?.why ? (REASONS[d.used.why] ?? d.used.why) : '';
  switch (d.status) {
    case 'current':
      return `${d.label}: ${pinned}, up to date`;
    case 'update':
      return `${d.label}: ${pinned} available (${
        !d.used
          ? 'not staged yet'
          : d.used.ref === d.pin.itemId
            ? `the stored desk uses v${d.used.version}`
            : 'the stored desk uses another unit'
      })`;
    case 'pending':
      return `${d.label}: ${pinned} waiting${why ? ` (${why})` : ''}`;
    case 'refused':
      return `${d.label}: can't use ${pinned}${why ? ` (${why})` : ''}`;
    case 'local': {
      const from = d.used ?? { ref: d.pin.itemId, version: d.pin.version };
      if (from.ref === d.pin.itemId && from.version === d.pin.version)
        return `${d.label}: made local in the desk (from ${pinned})`;
      const was = from.ref === d.pin.itemId ? `${d.pin.name} v${from.version}` : 'another unit';
      return `${d.label}: made local in the desk (from ${was}); ${pinned} is pinned now`;
    }
    case 'unknown':
      return `${d.label}: ${pinned}; what the stored desk uses is not known`;
    case 'approved':
      return `${d.label}: ${pinned}; the approved clip keeps ${d.used?.staged === 'unit' ? `v${d.used.version}` : 'its staging'}`;
  }
}

/** The badge: what needs attention first, in the order can't use, waiting, available, approved. */
export interface DeskUnitBadge {
  status: 'refused' | 'pending' | 'update' | 'approved';
  text: string;
  /** Every pinned slot, one line each. */
  title: string;
}

/** The Storyboard's 3D badge of a clip's drift, or null when nothing needs attention. */
export function deskUnitBadge(drifts: readonly DeskUnitDrift[]): DeskUnitBadge | null {
  const title = drifts.map(deskUnitDriftLine).join('\n');
  for (const status of ['refused', 'pending', 'update', 'approved'] as const) {
    const d = drifts.find((x) => x.status === status);
    if (!d) continue;
    const text =
      status === 'refused'
        ? `3D: can't use ${d.pin.name} v${d.pin.version}`
        : status === 'pending'
          ? '3D: waiting'
          : status === 'update'
            ? `3D: v${d.pin.version} available`
            : `approved: keeps ${d.used?.staged === 'unit' ? `v${d.used.version}` : 'its staging'}`;
    return { status, text, title };
  }
  return null;
}

// ---------------------------------------------------------------- where it is used: the stored states

/**
 * The `deskState` rows of a project's digest (docs/design/library.md#where-it-is-used): per library version, the
 * clips whose stored state uses it (staged `unit`, not made local), and the approved ones among them.
 */
export function deskStateUses(clips: Readonly<Record<string, Clip>>): DigestLibraryUse[] {
  const uses = new Map<string, { itemId: string; version: number; clips: number; approved: number }>();
  for (const clip of Object.values(clips)) {
    const seen = new Set<string>();
    for (const u of clip.deskState?.units ?? []) {
      if (u.staged !== 'unit' || u.local) continue;
      if (!LibraryItemIdSchema.safeParse(u.ref).success || u.version > LIBRARY_MAX_VERSIONS) continue;
      const key = `${u.ref}@${u.version}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const use = uses.get(key) ?? { itemId: u.ref, version: u.version, clips: 0, approved: 0 };
      use.clips += 1;
      if (clip.status === 'approved') use.approved += 1;
      uses.set(key, use);
    }
  }
  return [...uses.values()].map((u) => ({ ...u, via: 'deskState' as const }));
}
