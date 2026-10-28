import {
  DEFAULT_REVIEW_SETTINGS,
  REVIEW_DIMENSIONS,
  type ReviewDimension,
  type ReviewStage,
  type StageAction,
  type StageIssue,
  type StageRecommendation,
  type StageReview,
  type StageVerdict,
} from '../schemas/ai-review';
import type { ProjectDocs } from '../schemas/documents';
import type { LlmStageAction, StageReviewOutput } from '../schemas/llm';
import { storyboardClips } from '../storyboard';
import { fnv1a32 } from '../util/hash';

/** A dimension below this fails the review whatever the score (docs/design/ai-review.md#the-verdict). */
export const REVIEW_MIN_DIMENSION = 4;

const round1 = (n: number) => Math.round(n * 10) / 10;
const byIndex = <T extends { index: number }>(a: T, b: T) => a.index - b.index;

/** The verdict of a review, decided by rules rather than by the model (docs/design/ai-review.md#the-verdict). */
export function stageVerdict(
  stage: ReviewStage,
  scores: Record<string, number | null | undefined>,
  issues: Pick<StageIssue, 'severity' | 'title'>[],
  threshold: number,
): StageVerdict {
  const dims = REVIEW_DIMENSIONS[stage] as readonly string[];
  const values = dims.map((d) => scores[d]).filter((v): v is number => typeof v === 'number');
  const score = values.length ? round1(values.reduce((n, v) => n + v, 0) / values.length) : 0;
  const blocking: string[] = [];
  for (const i of issues) if (i.severity === 'critical') blocking.push(`critical: ${i.title}`.slice(0, 300));
  for (const d of dims) {
    const v = scores[d];
    if (typeof v === 'number' && v < REVIEW_MIN_DIMENSION) blocking.push(`${d} ${v}/10`);
  }
  if (!values.length) blocking.push('no scores');
  else if (score < threshold) blocking.push(`score ${score} of ${threshold}`);
  return { passed: blocking.length === 0, score, blocking: blocking.slice(0, 30) };
}

/** Hash of what the screenplay review reads: the story, the scenes and the cast (docs/design/ai-review.md). */
export function screenplayReviewSubject(docs: Pick<ProjectDocs, 'screenplay' | 'characters'>): string {
  const sp = docs.screenplay;
  if (!sp) return '';
  return fnv1a32(
    JSON.stringify({
      t: [sp.title, sp.logline, sp.synopsis, sp.genre, sp.tone, sp.style],
      b: [...sp.outline].sort(byIndex).map((b) => [b.title, b.summary, b.purpose, b.estDurationSec]),
      s: [...sp.scenes]
        .sort(byIndex)
        .map((s) => [
          s.id,
          s.heading,
          s.location,
          s.timeOfDay,
          s.continuity,
          s.summary,
          s.action,
          s.dialogue.map((d) => [d.character, d.line]),
          s.characterIds,
          s.elementIds,
        ]),
      c: Object.values(docs.characters)
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((c) => [c.id, c.name, c.role, c.summary]),
    }),
  ).toString(16);
}

/** Hash of what the storyboard review sees: the storyboarded shots and their frames. */
export function storyboardReviewSubject(docs: Pick<ProjectDocs, 'screenplay' | 'project' | 'clips'>): string {
  return fnv1a32(
    JSON.stringify(
      storyboardClips(docs).map((c) => [
        c.id,
        [...c.shots]
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
    ),
  ).toString(16);
}

export function reviewSubject(docs: ProjectDocs, stage: ReviewStage): string {
  return stage === 'screenplay' ? screenplayReviewSubject(docs) : storyboardReviewSubject(docs);
}

export function reviewSettings(docs: Pick<ProjectDocs, 'project'>) {
  return { ...DEFAULT_REVIEW_SETTINGS, ...(docs.project.settings.review ?? {}) };
}

export function reviewEnabled(docs: Pick<ProjectDocs, 'project'>, stage: ReviewStage): boolean {
  if (stage === 'storyboard' && docs.project.settings.storyboard?.enabled === false) return false;
  return reviewSettings(docs)[stage];
}

export type ReviewState =
  | 'off'
  | 'missing'
  | 'running'
  | 'error'
  | 'outdated'
  | 'failed'
  | 'passed'
  | 'overridden';

/** Where a stage's review stands against the documents as they are now. */
export function reviewState(docs: ProjectDocs, stage: ReviewStage): ReviewState {
  if (!reviewEnabled(docs, stage)) return 'off';
  const r = docs.aiReviews[stage];
  if (!r) return 'missing';
  if (r.status === 'running') return 'running';
  if (r.status === 'failed') return 'error';
  const subject = reviewSubject(docs, stage);
  if (r.override && r.override.subject === subject) return 'overridden';
  if (r.subject !== subject) return 'outdated';
  return r.verdict?.passed ? 'passed' : 'failed';
}

/** The gate requirement of a stage's review (docs/design/ai-review.md#the-gates). */
export function reviewRequirement(
  docs: ProjectDocs,
  stage: ReviewStage,
): { ok: boolean; message: string; details?: string[] } {
  const r = docs.aiReviews[stage];
  const of = r?.verdict ? ` (${r.verdict.score} of ${r.threshold})` : '';
  switch (reviewState(docs, stage)) {
    case 'off':
      return { ok: true, message: `The ${stage} review is off` };
    case 'passed':
      return { ok: true, message: `The ${stage} review passed${of}` };
    case 'overridden':
      return { ok: true, message: `Continued without passing the ${stage} review` };
    case 'missing':
      return { ok: false, message: `Review the ${stage}` };
    case 'running':
      return { ok: false, message: `The ${stage} is being reviewed` };
    case 'error':
      return { ok: false, message: `The ${stage} review could not run: review again` };
    case 'outdated':
      return { ok: false, message: `The ${stage} changed since its review: review again` };
    default:
      return {
        ok: false,
        message: `The ${stage} review did not pass${of}`,
        details: r?.verdict?.blocking.slice(0, 5),
      };
  }
}

/** Where the reviewer's scene numbers and shot positions point (docs/design/ai-review.md#how-a-review-runs). */
export interface ReviewTargets {
  /** Scene number (1-based) → scene id. */
  scenes: Map<number, string>;
  /** Storyboard: scene number → its clip and its shots in order. */
  clips?: Map<number, { clipId: string; shots: { shotId: string; label: string }[] }>;
}

function dimensionOf(stage: ReviewStage, raw: string): ReviewDimension {
  const dims = REVIEW_DIMENSIONS[stage] as readonly string[];
  const d = raw.trim().toLowerCase();
  return (dims.includes(d) ? d : dims[0]) as ReviewDimension;
}

function actionOf(
  stage: ReviewStage,
  a: LlmStageAction | undefined,
  at: { scene?: number; shot?: number },
  fallback: string,
  targets: ReviewTargets,
): StageAction | null {
  if (!a) return null;
  const instruction = (a.instruction || a.direction || fallback).slice(0, 2000);
  if (stage === 'screenplay') {
    if (a.kind === 'revise_scene') {
      const sceneId = at.scene !== undefined ? targets.scenes.get(at.scene) : undefined;
      return sceneId && instruction ? { kind: 'revise_scene', sceneId, instruction } : { kind: 'note' };
    }
    if (a.kind === 'revise_outline')
      return instruction ? { kind: 'revise_outline', instruction } : { kind: 'note' };
    return { kind: 'note' };
  }
  const clip = at.scene !== undefined ? targets.clips?.get(at.scene) : undefined;
  if (a.kind === 'redraw_board') {
    const shot = clip && at.shot !== undefined ? clip.shots[at.shot] : undefined;
    if (!clip || !shot) return { kind: 'note' };
    return {
      kind: 'redraw_board',
      clipId: clip.clipId,
      shotId: shot.shotId,
      ...(a.description ? { description: a.description } : {}),
      ...(a.action ? { action: a.action } : {}),
      ...(a.framing ? { framing: a.framing } : {}),
      ...(a.movement ? { movement: a.movement } : {}),
      ...(a.characters?.length ? { characters: a.characters } : {}),
      ...(a.durationSec ? { durationSec: a.durationSec } : {}),
    };
  }
  if (a.kind === 'replan_scene')
    return clip && instruction
      ? { kind: 'replan_scene', clipId: clip.clipId, direction: instruction }
      : { kind: 'note' };
  return { kind: 'note' };
}

/**
 * The document parts of a review from the model's answer: scores of the stage's dimensions, issues and
 * recommendations pointed at scenes and shots, recommendations by priority, and the verdict by rule.
 */
export function assembleStageReview(
  stage: ReviewStage,
  out: StageReviewOutput,
  targets: ReviewTargets,
  threshold: number,
  round = 1,
): Pick<StageReview, 'scores' | 'summary' | 'strengths' | 'issues' | 'recommendations' | 'verdict'> {
  // Later rounds number their own, so the fixes of earlier rounds keep their ids beside them
  const id = (kind: 'i' | 'r', k: number) => (round > 1 ? `${kind}${round}.${k + 1}` : `${kind}${k + 1}`);
  const scores: Record<string, number | null> = {};
  for (const d of REVIEW_DIMENSIONS[stage]) {
    const v = out.scores[d];
    scores[d] = typeof v === 'number' ? round1(Math.min(10, Math.max(0, v))) : null;
  }
  const place = (scene?: number, shot?: number) => {
    const where: Partial<StageIssue> = {};
    if (scene !== undefined) {
      where.scene = scene;
      const sceneId = targets.scenes.get(scene);
      if (sceneId) where.sceneId = sceneId;
      const clip = targets.clips?.get(scene);
      const s = clip && shot !== undefined ? clip.shots[shot] : undefined;
      if (clip && s) Object.assign(where, { clipId: clip.clipId, shotId: s.shotId, shot: s.label });
    }
    return where;
  };
  const issues: StageIssue[] = out.issues.map((i, k) => ({
    id: id('i', k),
    dimension: dimensionOf(stage, i.dimension),
    severity: i.severity,
    title: i.title,
    detail: i.detail,
    ...place(i.scene, i.shot),
  }));
  const recommendations: StageRecommendation[] = out.recommendations
    .map((r, k) => ({ r, k }))
    .sort((a, b) => a.r.priority - b.r.priority || a.k - b.k)
    .map(({ r }, k) => ({
      id: id('r', k),
      round,
      priority: r.priority as 1 | 2 | 3,
      dimension: dimensionOf(stage, r.dimension),
      title: r.title,
      detail: r.detail,
      issueIds: issues
        .filter(
          (i) =>
            r.scene !== undefined &&
            i.scene === r.scene &&
            (r.shot === undefined || i.shot === place(r.scene, r.shot).shot),
        )
        .map((i) => i.id)
        .slice(0, 50),
      action: actionOf(stage, r.action, { scene: r.scene, shot: r.shot }, r.detail || r.title, targets),
      status: 'open' as const,
    }));
  return {
    scores,
    summary: out.summary,
    strengths: out.strengths,
    issues,
    recommendations,
    verdict: stageVerdict(stage, scores, issues, threshold),
  };
}

/** The storyboard scenes' answers as one: scores weighted by the scenes' lengths, issues and fixes in scene order. */
export function mergeSceneReviews(
  parts: { number: number; durationSec: number; out: StageReviewOutput }[],
): StageReviewOutput {
  const scores: Record<string, number> = {};
  const weights: Record<string, number> = {};
  for (const p of parts)
    for (const [d, v] of Object.entries(p.out.scores)) {
      if (typeof v !== 'number') continue;
      const w = Math.max(1, p.durationSec);
      scores[d] = (scores[d] ?? 0) + v * w;
      weights[d] = (weights[d] ?? 0) + w;
    }
  for (const d of Object.keys(scores)) scores[d] = round1(scores[d]! / weights[d]!);
  return {
    scores,
    summary: parts
      .filter((p) => p.out.summary)
      .map((p) => `Scene ${p.number}: ${p.out.summary}`)
      .join(' ')
      .slice(0, 3000),
    strengths: parts.flatMap((p) => p.out.strengths).slice(0, 10),
    issues: parts
      .flatMap((p) => p.out.issues.map((i) => ({ ...i, scene: i.scene ?? p.number })))
      .slice(0, 60),
    recommendations: parts
      .flatMap((p) => p.out.recommendations.map((r) => ({ ...r, scene: r.scene ?? p.number })))
      .slice(0, 40),
  };
}

/** The recommendations a round applies by itself: open, priority 1 or 2, with something to do. */
export function autoApplicable(review: Pick<StageReview, 'recommendations'>): StageRecommendation[] {
  return review.recommendations.filter(
    (r) => r.status === 'open' && r.priority <= 2 && r.action && r.action.kind !== 'note',
  );
}

/** The fixes earlier rounds applied, kept beside a new round's recommendations. */
export function carriedFixes(
  previous: Pick<StageReview, 'recommendations'> | null | undefined,
): StageRecommendation[] {
  return (previous?.recommendations ?? []).filter((r) => r.status === 'applied');
}
