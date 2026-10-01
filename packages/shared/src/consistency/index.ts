import { type Character, voiceOf } from '../schemas/character';
import type { CharacterVerdict, Clip, ConsistencyStatus, ElementVerdict, Shot, Take } from '../schemas/clip';
import type { Element } from '../schemas/element';

/**
 * Take states as seen by the consistency invariant (docs/design/character-consistency.md):
 * only `passed` and `overridden` takes may enter approved clips, cuts and exports.
 */
export type TakeState = 'passed' | 'failed' | 'unverified' | 'stale' | 'overridden';

export function staleCharacters(
  take: Take,
  shot: Pick<Shot, 'characterIds'>,
  characters: Record<string, Character>,
): string[] {
  return shot.characterIds.filter((id) => {
    const c = characters[id];
    if (!c) return false;
    const used = take.characterLocks[id];
    return used === undefined || used !== c.lock.version;
  });
}

/** Elements of the shot whose lock changed since the take was generated (rule E6, docs/design/elements.md). */
export function staleElements(
  take: Take,
  shot: Pick<Shot, 'elementIds'>,
  elements: Record<string, Element>,
): string[] {
  return (shot.elementIds ?? []).filter((id) => {
    const e = elements[id];
    if (!e) return false;
    const used = take.elementLocks?.[id];
    return used === undefined || used !== e.lock.version;
  });
}

/** Speakers whose voice lock changed since the take was generated (rule V6, docs/design/dialogue.md). */
export function staleVoices(take: Take, characters: Record<string, Character>): string[] {
  return Object.entries(take.audio?.voiceLocks ?? {})
    .filter(([id, version]) => {
      const c = characters[id];
      return !!c && voiceOf(c).lock.version !== version;
    })
    .map(([id]) => id);
}

export function takeState(
  take: Take,
  shot: Pick<Shot, 'characterIds'> & Partial<Pick<Shot, 'elementIds'>>,
  characters: Record<string, Character>,
  elements: Record<string, Element> = {},
): TakeState {
  if (take.override) return 'overridden';
  if (staleCharacters(take, shot, characters).length > 0) return 'stale';
  if (staleElements(take, { elementIds: shot.elementIds ?? [] }, elements).length > 0) return 'stale';
  if (staleVoices(take, characters).length > 0) return 'stale';
  return take.consistency.status;
}

export function isAcceptable(state: TakeState): boolean {
  return state === 'passed' || state === 'overridden';
}

export interface Blocker {
  clipId: string;
  shotId: string;
  takeId?: string;
  state: TakeState | 'missing';
  message: string;
}

export function shotBlocker(
  clip: Clip,
  shot: Shot,
  characters: Record<string, Character>,
  elements: Record<string, Element> = {},
): Blocker | null {
  const label = `shot c${clip.index + 1}-s${shot.index + 1}`;
  const take = shot.takes.find((t) => t.id === shot.selectedTakeId);
  if (!take?.video) {
    return { clipId: clip.id, shotId: shot.id, state: 'missing', message: `${label} has no selected take` };
  }
  const state = takeState(take, shot, characters, elements);
  if (isAcceptable(state)) return null;
  const why: Record<Exclude<TakeState, 'passed' | 'overridden'>, string> = {
    failed: 'failed the consistency check',
    unverified: 'is not verified',
    stale: 'was generated from an older character, element or voice lock',
  };
  return {
    clipId: clip.id,
    shotId: shot.id,
    takeId: take.id,
    state,
    message: `${label} take ${shot.takes.indexOf(take) + 1} ${why[state as keyof typeof why]}`,
  };
}

/** R7: everything that prevents approving a clip. */
export function clipBlockers(
  clip: Clip,
  characters: Record<string, Character>,
  elements: Record<string, Element> = {},
): Blocker[] {
  if (clip.shots.length === 0) {
    return [
      { clipId: clip.id, shotId: '', state: 'missing', message: `clip ${clip.index + 1} has no shots` },
    ];
  }
  return clip.shots
    .slice()
    .sort((a, b) => a.index - b.index)
    .map((s) => shotBlocker(clip, s, characters, elements))
    .filter((b): b is Blocker => b !== null);
}

export interface FrameVerdict {
  characterId: string;
  present: boolean;
  identityScore: number;
  outfitScore?: number;
  issues?: string[];
}

export interface AggregateOptions {
  threshold: number;
  /** Characters with an expected wardrobe get the 0.75/0.25 identity/outfit weighting. */
  expectsWardrobe?: (characterId: string) => boolean;
}

/**
 * Aggregates per-frame judge verdicts into per-character verdicts and a gate status.
 * Present = present in at least one frame; score = min over frames where present.
 */
export function aggregateVerdicts(
  expected: string[],
  frames: FrameVerdict[][],
  opts: AggregateOptions,
): { status: ConsistencyStatus; score: number; characters: CharacterVerdict[] } {
  if (expected.length === 0) return { status: 'passed', score: 1, characters: [] };
  const characters: CharacterVerdict[] = expected.map((id) => {
    let present = false;
    let score = 1;
    const issues = new Set<string>();
    for (const frame of frames) {
      const v = frame.find((x) => x.characterId === id);
      if (!v?.present) continue;
      present = true;
      const wardrobe = opts.expectsWardrobe?.(id) && v.outfitScore !== undefined;
      const s = wardrobe ? 0.75 * v.identityScore + 0.25 * (v.outfitScore ?? 0) : v.identityScore;
      score = Math.min(score, clamp01(s));
      for (const issue of v.issues ?? []) issues.add(issue.slice(0, 500));
    }
    if (!present) issues.add('character not visible in any sampled frame');
    return { characterId: id, present, score: present ? round3(score) : 0, issues: [...issues].slice(0, 10) };
  });
  const score = Math.min(...characters.map((c) => c.score));
  const passed = characters.every((c) => c.present && c.score >= opts.threshold);
  return { status: passed ? 'passed' : 'failed', score: round3(score), characters };
}

export interface ElementFrameVerdict {
  elementId: string;
  present: boolean;
  score: number;
  issues?: string[];
}

/**
 * Element verdicts (rule E4): present in at least one frame, score = minimum where present; every element
 * must be present at or above the threshold.
 */
export function aggregateElementVerdicts(
  expected: string[],
  frames: ElementFrameVerdict[][],
  threshold: number,
): { passed: boolean; score: number; elements: ElementVerdict[] } {
  if (expected.length === 0) return { passed: true, score: 1, elements: [] };
  const elements: ElementVerdict[] = expected.map((id) => {
    let present = false;
    let score = 1;
    const issues = new Set<string>();
    for (const frame of frames) {
      const v = frame.find((x) => x.elementId === id);
      if (!v?.present) continue;
      present = true;
      score = Math.min(score, clamp01(v.score));
      for (const issue of v.issues ?? []) issues.add(issue.slice(0, 500));
    }
    if (!present) issues.add('element not visible in any sampled frame');
    return { elementId: id, present, score: present ? round3(score) : 0, issues: [...issues].slice(0, 10) };
  });
  return {
    passed: elements.every((e) => e.present && e.score >= threshold),
    score: round3(Math.min(...elements.map((e) => e.score))),
    elements,
  };
}

function clamp01(n: number): number {
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
