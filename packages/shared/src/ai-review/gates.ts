import { isAcceptable, takeState } from '../consistency';
import { takePassesChecks } from '../feedback';
import type { StageReview, StageVerdict } from '../schemas/ai-review';
import { approvedReferences } from '../schemas/character';
import type { Clip, ClipReview, Shot, TakeWatch } from '../schemas/clip';
import type { ProjectDocs } from '../schemas/documents';
import { FEEDBACK_DIMENSIONS } from '../schemas/feedback';
import type { StageReviewOutput, TakeWatchOutput } from '../schemas/llm';
import type { VideoItem } from '../schemas/timeline';
import { boardState } from '../storyboard';
import { itemEnd } from '../timeline/ops';
import { fnv1a32 } from '../util/hash';
import { clipReviewState, clipReviewSubject } from './clip-review';

/**
 * Reviews of every step (docs/design/ai-review.md#autopilot-every-step-reviewed-and-approved): what the cast and the
 * cut reviews look at, a production scene's storyboard review, the scene review's verdict, the whole-take watch and the
 * clip gate autopilot approves a clip by.
 */

const byIndex = <T extends { index: number }>(a: T, b: T) => a.index - b.index;
const round1 = (n: number) => Math.round(n * 10) / 10;
/** A scored dimension below this fails a scene's review whatever its overall score. */
export const SCENE_MIN_DIMENSION = 4;
/** The planned action must be seen at least this much (0–1) in a take watched whole. */
export const WATCH_MIN_ACTION = 0.4;

/** The elements a written scene or a planned shot uses (as `elementsInUse`, without importing the workflow). */
function elementIdsInUse(docs: Pick<ProjectDocs, 'screenplay' | 'clips'>): Set<string> {
  const ids = new Set<string>();
  for (const s of docs.screenplay?.scenes ?? []) {
    if (s.locationId) ids.add(s.locationId);
    for (const id of s.elementIds ?? []) ids.add(id);
  }
  for (const c of Object.values(docs.clips))
    for (const shot of c.shots) for (const id of shot.elementIds) ids.add(id);
  return ids;
}

/**
 * The elements the cast review looks at: those in use, and every other one that has references (the pilot gate locks
 * the whole library before production).
 */
export function castElements(docs: Pick<ProjectDocs, 'elements' | 'screenplay' | 'clips'>) {
  const inUse = elementIdsInUse(docs);
  return Object.values(docs.elements)
    .filter((e) => inUse.has(e.id) || e.references.length > 0)
    .sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Hash of what the cast review looks at: every character's identity, wardrobe and references, and the elements it
 * reviews with theirs. Approving or locking does not change it (the review's own pass approves and locks).
 */
export function castReviewSubject(
  docs: Pick<ProjectDocs, 'characters' | 'elements' | 'screenplay' | 'clips'>,
): string {
  return fnv1a32(
    JSON.stringify({
      c: Object.values(docs.characters)
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((c) => [
          c.id,
          c.name,
          c.identity,
          c.wardrobe.map((w) => [w.id, w.description]),
          c.references.map((r) => [r.id, r.view, r.media.hash]),
        ]),
      e: castElements(docs).map((e) => [
        e.id,
        e.name,
        e.description,
        e.references.map((r) => [r.id, r.view, r.media.hash]),
      ]),
    }),
  ).toString(16);
}

/** Every character and element in use has at least one reference to review. */
export function castReadyForReview(
  docs: Pick<ProjectDocs, 'characters' | 'elements' | 'screenplay' | 'clips'>,
) {
  const chars = Object.values(docs.characters);
  const inUse = elementIdsInUse(docs);
  return (
    chars.length > 0 &&
    chars.every((c) => c.references.length > 0) &&
    [...inUse].every((id) => !docs.elements[id] || docs.elements[id]!.references.length > 0)
  );
}

/** The items of the cut that show a take, in cut order. */
export function cutTakeItems(docs: Pick<ProjectDocs, 'timeline'>) {
  const out: {
    itemId: string;
    clipId: string;
    shotId: string;
    takeId: string;
    start: number;
    end: number;
  }[] = [];
  for (const track of docs.timeline?.tracks ?? []) {
    if (track.kind !== 'video') continue;
    for (const item of track.items as VideoItem[]) {
      const src = item.source;
      if (src.type !== 'take') continue;
      out.push({
        itemId: item.id,
        clipId: src.clipId,
        shotId: src.shotId,
        takeId: src.takeId,
        start: item.start,
        end: itemEnd(item),
      });
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

/** The clips of the cut, in the order the cut shows them. */
export function cutClips(docs: Pick<ProjectDocs, 'timeline' | 'clips'>): Clip[] {
  const seen: string[] = [];
  for (const t of cutTakeItems(docs)) if (!seen.includes(t.clipId)) seen.push(t.clipId);
  return seen.map((id) => docs.clips[id]).filter((c): c is Clip => !!c);
}

/** Hash of what the cut review looks at: the takes of the cut, and the selected takes of its scenes. */
export function cutReviewSubject(docs: Pick<ProjectDocs, 'timeline' | 'clips'>): string {
  return fnv1a32(
    JSON.stringify({
      t: cutTakeItems(docs).map((t) => [t.clipId, t.shotId, t.takeId]),
      s: cutClips(docs).map((c) => [c.id, clipReviewSubject(c)]),
    }),
  ).toString(16);
}

/** Hash of what a production scene's storyboard review sees: its shots and their frames. */
export function clipBoardSubject(clip: Pick<Clip, 'id' | 'shots'>): string {
  return fnv1a32(
    JSON.stringify([
      clip.id,
      [...clip.shots]
        .sort(byIndex)
        .map((s) => [
          s.id,
          s.durationSec,
          s.description,
          s.action,
          s.camera.framing,
          s.camera.movement,
          s.characterIds,
          s.dialogue.map((d) => [d.characterId, d.line]),
          s.board?.keyframe.hash ?? null,
        ]),
    ]),
  ).toString(16);
}

export type BoardReviewState =
  | 'missing'
  | 'running'
  | 'error'
  | 'outdated'
  | 'failed'
  | 'passed'
  | 'overridden';

/** Where a production scene's storyboard review stands against the clip as it is now. */
export function clipBoardReviewState(
  clip: Pick<Clip, 'id' | 'shots'> & { boardReview: StageReview | null },
): BoardReviewState {
  const r = clip.boardReview;
  if (!r) return 'missing';
  if (r.status === 'running') return 'running';
  if (r.status === 'failed') return 'error';
  const subject = clipBoardSubject(clip);
  if (r.override && r.override.subject === subject) return 'overridden';
  if (r.subject !== subject) return 'outdated';
  return r.verdict?.passed ? 'passed' : 'failed';
}

/** Every frame of the clip approved and current (its review's pass approves them). */
export function clipFramesApproved(clip: Clip, docs: Parameters<typeof boardState>[1]): boolean {
  return clip.shots.length > 0 && clip.shots.every((s) => boardState(s, docs) === 'approved');
}

/**
 * The verdict of a scene's review (docs/design/ai-review.md#the-clip-gate): the overall score reaches the threshold,
 * no critical issue, no scored dimension below 4.
 */
export function clipReviewVerdict(
  review: Pick<ClipReview, 'overall' | 'scores' | 'issues'>,
  threshold: number,
): StageVerdict {
  const blocking: string[] = [];
  for (const i of review.issues)
    if (i.severity === 'critical')
      blocking.push(`critical: ${i.shot ? `${i.shot} ` : ''}${i.title}`.slice(0, 300));
  for (const d of FEEDBACK_DIMENSIONS) {
    const v = review.scores[d.id];
    if (typeof v === 'number' && v < SCENE_MIN_DIMENSION) blocking.push(`${d.id} ${v}/10`);
  }
  const score = review.overall ?? 0;
  if (review.overall === null) blocking.push('no scores');
  else if (score < threshold) blocking.push(`score ${round1(score)} of ${threshold}`);
  return { passed: blocking.length === 0, score: round1(score), blocking: blocking.slice(0, 30) };
}

/**
 * The verdict of a take watched whole (docs/design/ai-review.md#takes-watched-whole): a critical issue, motion, physics
 * or identity under the quality threshold, or an action that does not happen fails the attempt.
 */
export function watchVerdict(
  out: TakeWatchOutput,
  qualityThreshold: number,
): { passed: boolean; issues: string[] } {
  const issues: string[] = [];
  for (const i of out.issues)
    if (i.severity === 'critical') issues.push(`watched: ${i.title} at ${i.time.toFixed(1)} s`.slice(0, 500));
  if (out.motion < qualityThreshold)
    issues.push(`watched: motion ${out.motion.toFixed(2)} (morphing or flicker)`);
  if (out.physics < qualityThreshold) issues.push(`watched: physics ${out.physics.toFixed(2)}`);
  if (out.identity < qualityThreshold) issues.push(`watched: identity drifts (${out.identity.toFixed(2)})`);
  if (out.action < WATCH_MIN_ACTION)
    issues.push(`watched: the planned action does not happen (${out.action.toFixed(2)})`);
  return { passed: issues.length === 0, issues };
}

/** The watch record of a take from the watcher's answer. */
export function takeWatchOf(
  out: TakeWatchOutput,
  opts: { model: string; via: 'vision' | 'omni'; qualityThreshold: number; at?: string },
): TakeWatch {
  return {
    model: opts.model,
    via: opts.via,
    overall: round1(out.overall),
    motion: out.motion,
    physics: out.physics,
    action: out.action,
    camera: out.camera,
    identity: out.identity,
    others: out.others,
    issues: out.issues,
    passed: watchVerdict(out, opts.qualityThreshold).passed,
    ...(opts.at ? { checkedAt: opts.at } : {}),
  };
}

/** Takes are watched whole: the setting and the quality checks it is one of (docs/design/ai-review.md). */
export function watchesTakes(settings: {
  review?: { watchTakes?: boolean };
  consistency: { qualityChecks?: boolean };
}) {
  return settings.review?.watchTakes === true && settings.consistency.qualityChecks === true;
}

/** A selected take that passes everything its report checked, its whole-take watch included. */
function takeClears(shot: Shot, docs: Pick<ProjectDocs, 'characters' | 'elements'>, watchTakes: boolean) {
  const take = shot.takes.find((t) => t.id === shot.selectedTakeId);
  if (!take?.video) return `shot ${shot.index + 1} has no take`;
  const state = takeState(take, shot, docs.characters, docs.elements);
  if (!isAcceptable(state)) return `shot ${shot.index + 1}: take is ${state}`;
  if (take.override) return null;
  if (!takePassesChecks(take, shot, docs.characters, docs.elements))
    return `shot ${shot.index + 1}: take fails its checks`;
  if (watchTakes && !take.consistency.quality?.watch)
    return `shot ${shot.index + 1}: take was not watched whole`;
  return null;
}

/**
 * Whether autopilot may approve a clip (docs/design/ai-review.md#the-clip-gate), and what holds it back: every take's
 * checks and the scene's review. Its frames were approved before its video (the batch makes sure): a scene review's
 * fix that revises a shot outdates the shot's frame, and must not hold the clip back.
 */
export function clipGate(clip: Clip, docs: ProjectDocs): { ok: boolean; blocking: string[] } {
  const settings = docs.project.settings;
  const review = { ...{ scenes: true, sceneThreshold: 6 }, ...(settings.review ?? {}) };
  const blocking: string[] = [];
  for (const shot of [...clip.shots].sort(byIndex)) {
    const why = takeClears(shot, docs, watchesTakes(settings));
    if (why) blocking.push(why);
  }
  if (review.scenes && clip.shots.length >= 2) {
    const r = clip.review;
    const state = clipReviewState(clip);
    if (!r || state !== 'current') blocking.push(`the scene review is ${state}`);
    else {
      const v = r.verdict ?? clipReviewVerdict(r, review.sceneThreshold);
      if (!v.passed) blocking.push(`the scene review did not pass (${v.blocking.slice(0, 2).join('; ')})`);
    }
  }
  return { ok: blocking.length === 0, blocking };
}

/** Characters that need references approved before they can be locked by the cast review. */
export function charactersWithoutApprovedRefs(docs: Pick<ProjectDocs, 'characters'>) {
  return Object.values(docs.characters).filter((c) => approvedReferences(c).length === 0);
}

/**
 * The cast review's answers as one (docs/design/ai-review.md#how-a-review-runs): each subject's scores weigh the same,
 * and every issue and recommendation names its subject.
 */
export function mergeSubjectReviews(
  parts: { name: string; kind: 'character' | 'element'; out: StageReviewOutput }[],
): StageReviewOutput {
  const sums: Record<string, { n: number; total: number }> = {};
  for (const p of parts)
    for (const [d, v] of Object.entries(p.out.scores))
      if (typeof v === 'number') {
        sums[d] ??= { n: 0, total: 0 };
        sums[d]!.n++;
        sums[d]!.total += v;
      }
  const who = (p: (typeof parts)[number]) =>
    p.kind === 'character' ? { character: p.name } : { element: p.name };
  return {
    scores: Object.fromEntries(Object.entries(sums).map(([d, x]) => [d, round1(x.total / x.n)])),
    summary: parts
      .filter((p) => p.out.summary)
      .map((p) => `${p.name}: ${p.out.summary}`)
      .join(' ')
      .slice(0, 3000),
    strengths: parts.flatMap((p) => p.out.strengths).slice(0, 10),
    issues: parts
      .flatMap((p) =>
        p.out.issues.map((i) => ({ ...who(p), ...i, ...(i.character || i.element ? {} : who(p)) })),
      )
      .slice(0, 60),
    recommendations: parts
      .flatMap((p) =>
        p.out.recommendations.map((r) => ({ ...r, ...(r.character || r.element ? {} : who(p)) })),
      )
      .slice(0, 40),
  };
}
