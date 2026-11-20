import {
  can,
  type DeskUnitKind,
  type DeskUnitPin,
  type ElementKind,
  formatBytes,
  type LibraryApplyPlan,
  type LibraryApplyResult,
  type LibraryKind,
  type LibraryLinkStatus,
  LibraryTagSchema,
  type LibraryUses,
  type ProjectRole,
} from '@rideo/shared';
import { ApiError } from '../../lib/api';

/**
 * What the library's UI says (docs/design/library.md#the-ui): the kind chips, the rows on linked entities, an apply's
 * plan, refusals in words, and the loop behind "Use v3 in all 4 projects". Pure, so the texts are tested as they are.
 */

/** The Library page's kind chips. */
export const KIND_CHIPS: { id: string; label: string; kinds: LibraryKind[] | null }[] = [
  { id: 'all', label: 'All', kinds: null },
  { id: 'characters', label: 'Characters', kinds: ['character'] },
  { id: 'elements', label: 'Places & props', kinds: ['element'] },
  { id: 'resources', label: 'Resources', kinds: ['resource'] },
  { id: 'sets', label: '3D sets', kinds: ['desk-set'] },
  { id: 'props', label: '3D props', kinds: ['desk-prop'] },
  { id: 'figures', label: '3D figures', kinds: ['desk-figure'] },
];

/** The Elements view's picker chips: the element kind of an item's current version. */
export const ELEMENT_CHIPS: { id: ElementKind | 'all'; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'location', label: 'Locations' },
  { id: 'prop', label: 'Props' },
  { id: 'style', label: 'Styles' },
];

export const KIND_LABEL: Record<LibraryKind, string> = {
  character: 'Character',
  element: 'Place or prop',
  resource: 'Resource',
  'desk-set': '3D set',
  'desk-prop': '3D prop',
  'desk-figure': '3D figure',
};

/** The 3D row's label of each pin kind. */
export const DESK_LABEL: Record<DeskUnitKind, string> = {
  'desk-set': '3D set',
  'desk-prop': '3D prop',
  'desk-figure': '3D figure',
};

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * The library row of a linked entity: "Library: Mira v2 · v3 available". `link` is the project status's row for it
 * (null until the status arrives, or when the studio does not have the item).
 */
export function libraryRowText(version: number, link: LibraryLinkStatus | null | undefined): string {
  if (!link) return `Library: v${version}`;
  if (link.state === 'missing' || !link.item) return `Library: v${version} (not in this studio's library)`;
  const parts = [`Library: ${link.item.name} v${version}`];
  if (link.state === 'behind') parts.push(`v${link.item.current} available`);
  if (link.state === 'ahead') parts.push(`the library's current version is v${link.item.current}`);
  if (link.modified) parts.push(`edited here since v${version}`);
  if (link.item.archived) parts.push('archived');
  return parts.join(' · ');
}

/** The 3D row: "3D figure: Mira look v1 · v2 available", "3D set: none", a pin whose item this studio lacks. */
export function deskRowText(
  kind: DeskUnitKind,
  pin: Pick<DeskUnitPin, 'name' | 'version'> | null | undefined,
  link: LibraryLinkStatus | null | undefined,
): string {
  const label = DESK_LABEL[kind];
  if (!pin) return `${label}: none`;
  if (link?.state === 'missing')
    return `${label}: ${pin.name} v${pin.version} (not in this studio's library)`;
  const parts = [`${label}: ${link?.item?.name ?? pin.name} v${pin.version}`];
  if (link?.state === 'behind' && link.item) parts.push(`v${link.item.current} available`);
  if (link?.state === 'ahead' && link.item)
    parts.push(`the library's current version is v${link.item.current}`);
  if (link?.item?.archived) parts.push('archived');
  return parts.join(' · ');
}

/** The version a row offers to move to: the item's current one when the entity uses another. */
export function offeredVersion(link: LibraryLinkStatus | null | undefined): number | null {
  if (!link?.item || link.state === 'missing' || link.state === 'current') return null;
  return link.item.current;
}

const CHANGE_WORDS: Record<LibraryApplyPlan['changes'][number], string> = {
  name: 'name',
  role: 'role',
  summary: 'summary',
  identity: 'identity',
  wardrobe: 'wardrobe',
  personality: 'personality',
  references: 'references',
  voice: 'voice',
  description: 'description',
  aliases: 'other names',
  seed: 'seed',
  deskUnit: '3D unit',
  media: 'files',
};

export type PlanTone = 'muted' | 'info' | 'warning' | 'danger';
export interface PlanLine {
  id: string;
  tone: PlanTone;
  text: string;
}

/** The plan's title: "Update Mira from the library (v1 → v2)", "Link Mira to the library (v2)". */
export function planTitle(plan: LibraryApplyPlan, fromVersion: number | null): string {
  const to = plan.item.version;
  if (plan.mode === 'update')
    return `Update ${plan.entity.name} from the library (${fromVersion ? `v${fromVersion} → ` : ''}v${to})`;
  if (plan.mode === 'link') return `Link ${plan.entity.name} to the library (v${to})`;
  if (plan.mode === 'pin') return `Use the ${KIND_LABEL[plan.item.kind]} ${plan.item.name} v${to}`;
  return `Use ${plan.item.name} from the library (v${to})`;
}

/**
 * What an apply will do, line by line (docs/design/library.md#use-in-project-update-and-link-apply): the changes, the
 * lock versions, the takes that go stale, the approved clips that need a director, the edits made here that are
 * replaced, the files copied and the warnings.
 */
export function planLines(
  plan: LibraryApplyPlan,
  opts: { fromVersion?: number | null; canApprove: boolean },
): PlanLine[] {
  const lines: PlanLine[] = [];
  lines.push(
    plan.changes.length
      ? {
          id: 'changes',
          tone: 'muted',
          text: `Changes: ${plan.changes.map((c) => CHANGE_WORDS[c]).join(', ')}`,
        }
      : {
          id: 'changes',
          tone: 'muted',
          text: `Nothing changes: ${plan.entity.name} is already v${plan.item.version}`,
        },
  );
  const lock = (what: string, l: LibraryApplyPlan['lock']) => {
    if (!l.locked) return `${what} is not locked`;
    if (l.from === null || l.from === l.to) return `${what} stays locked at version ${l.to}`;
    return `${what}: lock version ${l.from} → ${l.to}`;
  };
  if (plan.entity.kind !== 'resource')
    lines.push({ id: 'lock', tone: 'muted', text: lock('Identity', plan.lock) });
  if (plan.voiceLock) lines.push({ id: 'voice', tone: 'muted', text: lock('Voice', plan.voiceLock) });
  if (plan.staleTakes > 0)
    lines.push({
      id: 'stale',
      tone: 'warning',
      text: `${plural(plan.staleTakes, 'take')} will need generating again`,
    });
  if (plan.approvedClips.length) {
    const clips = plan.approvedClips
      .slice(0, 5)
      .map((c) => `clip ${c.index + 1}${c.title ? ` (${c.title})` : ''}`)
      .join(', ');
    const more = plan.approvedClips.length > 5 ? ` and ${plan.approvedClips.length - 5} more` : '';
    lines.push({
      id: 'approved',
      tone: opts.canApprove ? 'warning' : 'danger',
      text: `${plural(plan.approvedClips.length, 'approved clip')} would hold stale takes: ${clips}${more}. ${
        opts.canApprove
          ? 'Updating needs a director: you are one, and the clips stay approved with their takes until generated again.'
          : 'Updating needs a director: ask one to do it.'
      }`,
    });
  }
  if (plan.localChanges)
    lines.push({
      id: 'local',
      tone: 'warning',
      text: `Edits made here${opts.fromVersion ? ` since v${opts.fromVersion}` : ''} are replaced`,
    });
  if (plan.files.toCopy > 0)
    lines.push({
      id: 'files',
      tone: 'muted',
      text: `Copies ${plural(plan.files.toCopy, 'file')} (${formatBytes(plan.files.bytesToCopy)}) into the project`,
    });
  for (const [i, w] of plan.warnings.entries()) lines.push({ id: `warning-${i}`, tone: 'warning', text: w });
  return lines;
}

/** Whether the person may confirm the plan: a director's plan needs a director. */
export function planAllowed(plan: LibraryApplyPlan, canApprove: boolean): boolean {
  return plan.needs !== 'project.approve' || canApprove;
}

/** What an apply did, in a sentence. */
export function appliedText(result: LibraryApplyResult, fromVersion: number | null = null): string {
  const { plan } = result;
  const v = plan.item.version;
  if (!result.applied)
    return plan.mode === 'pin'
      ? `${plan.entity.name} already uses ${plan.item.name} v${v}`
      : `${plan.entity.name} is already v${v}`;
  switch (plan.mode) {
    case 'create':
      return `${plan.entity.name} is in the project (v${v}${plan.keepsLibraryId ? ', the same id and seed' : ''})`;
    case 'update':
      return `Updated ${plan.entity.name} from the library (${fromVersion ? `v${fromVersion} → ` : ''}v${v})`;
    case 'link':
      return `Linked ${plan.entity.name} to the library (v${v})`;
    case 'pin':
      return `${plan.entity.name} uses the ${KIND_LABEL[plan.item.kind]} ${plan.item.name} v${v}`;
  }
}

/** A conflict's first reason, when the refusal is one (`409` `conflict` with `errors: [{reason, …}]`). */
export function conflictOf(
  err: unknown,
): { reason: 'exists' | 'name' | 'pinned' | 'archived'; entityId?: string; itemId?: string } | null {
  if (!(err instanceof ApiError) || err.code !== 'conflict') return null;
  const first = (err.problem.errors ?? [])[0] as
    | { reason?: string; entityId?: string; itemId?: string }
    | undefined;
  if (!first || !['exists', 'name', 'pinned', 'archived'].includes(first.reason ?? '')) return null;
  return first as { reason: 'exists' | 'name' | 'pinned' | 'archived'; entityId?: string; itemId?: string };
}

/** The latest version a `412` `library_conflict` names (`errors: [{latest}]`), or null. */
export function latestOf(err: unknown): number | null {
  if (!(err instanceof ApiError) || err.code !== 'library_conflict') return null;
  const first = (err.problem.errors ?? [])[0] as { latest?: unknown } | undefined;
  return typeof first?.latest === 'number' ? first.latest : null;
}

/** The real people a `consent_required` refusal names (`errors: [{what, subject, scope}]`). */
export function consentSubjectsOf(
  err: unknown,
): { what: string; subject: string | null; scope: string | null }[] {
  if (!(err instanceof ApiError) || err.code !== 'consent_required') return [];
  return (
    (err.problem.errors ?? []) as { what?: string; subject?: string | null; scope?: string | null }[]
  ).map((e) => ({ what: e.what ?? 'reference', subject: e.subject ?? null, scope: e.scope ?? null }));
}

/**
 * A refusal of the library in words (docs/design/library.md#errors): the stable code decides the sentence; the
 * server's detail is kept where it names what was refused.
 */
export function libraryErrorText(err: unknown): string {
  if (!(err instanceof ApiError)) {
    const message = err instanceof Error ? err.message : String(err);
    return /Failed to fetch|NetworkError|Load failed/i.test(message)
      ? 'The studio cannot be reached: check the connection and try again.'
      : message;
  }
  const detail = err.problem.detail;
  switch (err.code) {
    case 'consent_required':
      return 'This shows a real person: confirm that the consent covers this use first.';
    case 'library_conflict': {
      const latest = latestOf(err);
      return latest
        ? `Someone saved v${latest} meanwhile: take it first, or save anyway as the next version.`
        : 'Someone changed this item meanwhile: it was reloaded, try again.';
    }
    case 'conflict': {
      const c = conflictOf(err);
      if (c?.reason === 'archived') return `${detail} (unarchive it on the Library page first).`;
      return detail || 'It clashes with something already here.';
    }
    case 'forbidden':
      return `You may not do this: ${detail || 'ask the project’s director or the item’s owner'}.`;
    case 'not_found':
      return `It is no longer there (${detail}): reload the page.`;
    case 'storage_offline':
      return 'The project is kept in a browser tab that is closed: open the project there and try again.';
    case 'storage_error':
      return `The library could not be read or written: try again (${detail}).`;
    case 'unauthorized':
      return 'Sign in again to use the library.';
    case 'validation_error':
      return detail || 'The studio refused the request as it was.';
    case 'character_locked':
    case 'element_locked':
    case 'voice_locked':
      return detail || 'It is locked.';
    default:
      return detail || `Refused (${err.code}).`;
  }
}

/**
 * A manager's change refused (the Library page's `PATCH` with the item's revision as `If-Match`): its `412` is a change
 * made meanwhile, which the page has reloaded; not a version saved meanwhile, as the same code means for a save.
 */
export function changeErrorText(err: unknown): string {
  return err instanceof ApiError && err.code === 'library_conflict'
    ? 'Someone changed this item meanwhile: it was reloaded, try again.'
    : libraryErrorText(err);
}

/** Tags typed as "season 1, harbour town": each one checked; the ones that are not tags. */
export function parseTags(text: string): { tags: string[]; invalid: string[] } {
  const tags: string[] = [];
  const invalid: string[] = [];
  for (const raw of text.split(',')) {
    const t = raw.trim();
    if (!t) continue;
    const parsed = LibraryTagSchema.safeParse(t);
    if (parsed.success) {
      if (!tags.includes(parsed.data)) tags.push(parsed.data);
    } else invalid.push(t);
  }
  return { tags, invalid };
}

// ---------------------------------------------------------------- Use vN in all projects

/** A project whose pins of a 3D item are at another version than the item's current one. */
export interface DeskMove {
  projectId: string;
  title: string;
  role: ProjectRole;
  targets: { kind: 'character' | 'element'; id: string; name: string; version: number }[];
}

/**
 * The projects "Use v3 in all 4 projects" goes through (docs/design/library.md#the-library-page): those with a pin of
 * the item at another version, each with the entities to move.
 */
export function deskMoves(uses: LibraryUses, current: number): DeskMove[] {
  const moves: DeskMove[] = [];
  for (const p of uses.projects) {
    const targets = p.uses
      .filter(
        (u) =>
          u.via === 'deskUnit' &&
          u.version !== current &&
          (u.entity?.kind === 'character' || u.entity?.kind === 'element'),
      )
      .map((u) => ({
        kind: u.entity!.kind as 'character' | 'element',
        id: u.entity!.id,
        name: u.entity!.name,
        version: u.version,
      }));
    if (targets.length) moves.push({ projectId: p.projectId, title: p.title, role: p.role, targets });
  }
  return moves;
}

export interface MoveResult {
  projectId: string;
  title: string;
  entity: string | null;
  outcome: 'applied' | 'unchanged' | 'refused' | 'skipped';
  text: string;
}

/**
 * Moves the pins one project after the other, one apply each (no fan-out on the server, decision 11), and lists what
 * each answered: applied, refused with the reason, or skipped where the person may not edit.
 */
export async function moveEverywhere(
  moves: DeskMove[],
  itemId: string,
  version: number,
  apply: (
    projectId: string,
    input: { itemId: string; version: number; target: { kind: 'character' | 'element'; id: string } },
  ) => Promise<LibraryApplyResult>,
  onResult?: (r: MoveResult) => void,
): Promise<MoveResult[]> {
  const results: MoveResult[] = [];
  const push = (r: MoveResult) => {
    results.push(r);
    onResult?.(r);
  };
  for (const m of moves) {
    if (!can(m.role, 'project.edit')) {
      push({
        projectId: m.projectId,
        title: m.title,
        entity: null,
        outcome: 'skipped',
        text: `${m.title}: skipped, you may not edit this project`,
      });
      continue;
    }
    for (const t of m.targets) {
      try {
        const out = await apply(m.projectId, { itemId, version, target: { kind: t.kind, id: t.id } });
        push({
          projectId: m.projectId,
          title: m.title,
          entity: t.name,
          outcome: out.applied ? 'applied' : 'unchanged',
          text: `${m.title} · ${t.name}: ${out.applied ? `now uses v${version}` : `already uses v${version}`}`,
        });
      } catch (err) {
        push({
          projectId: m.projectId,
          title: m.title,
          entity: t.name,
          outcome: 'refused',
          text: `${m.title} · ${t.name}: refused: ${libraryErrorText(err)}`,
        });
      }
    }
  }
  return results;
}

/** "Use v3 in all 2 projects" ("Use v3 in 1 project" for one). */
export function moveEverywhereLabel(version: number, projects: number): string {
  return projects === 1 ? `Use v${version} in 1 project` : `Use v${version} in all ${projects} projects`;
}

/** A use of the item in a project, in words. */
export function usageText(u: LibraryUses['projects'][number]['uses'][number]): string {
  if (u.via === 'deskState')
    return `Stored desk states: ${plural(u.clips ?? 0, 'clip')} use v${u.version}${
      u.approved ? ` (${u.approved} approved)` : ''
    }`;
  const name = u.entity?.name ?? 'an entity';
  return u.via === 'deskUnit' ? `${name}: pins v${u.version}` : `${name}: v${u.version}`;
}
