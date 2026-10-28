import { isAcceptable, takeState } from '../consistency';
import { countWords, heardShares, LINE_HEARD_RATIO, WORDS_PER_SECOND } from '../continuity';
import type { Character } from '../schemas/character';
import type { Clip, Shot, Take } from '../schemas/clip';
import type { Element } from '../schemas/element';
import {
  FEEDBACK_DIMENSIONS,
  type Feedback,
  type FeedbackAction,
  type FeedbackDimension,
  type FeedbackEstimate,
  type FeedbackIssue,
  type FeedbackRecommendation,
  type FeedbackScores,
  type FeedbackSignals,
  HEARD_DIMENSION_IDS,
  type RetrospectiveItem,
  type SceneFeedback,
  VISION_DIMENSION_IDS,
} from '../schemas/feedback';
import type {
  FeedbackFilmOutput,
  FeedbackSceneOutput,
  LlmFeedbackAction,
  VisionScores,
} from '../schemas/llm';
import type { Timeline, VideoItem } from '../schemas/timeline';
import type { Prices } from '../schemas/usage';
import { itemEnd, primaryTrack } from '../timeline/ops';

/**
 * Feedback on the finished film (docs/design/feedback.md): where each shot is in the export, the signals that need no
 * model, and the assembly of the scene and film reviews into one document. Pure; the server runs it.
 */

/** A shot of the cut, in seconds of the export. */
export interface FeedbackShotSpan {
  clipId: string;
  shotId: string;
  takeId: string;
  /** "C3·S2" */
  label: string;
  clipIndex: number;
  shotIndex: number;
  start: number;
  end: number;
}

export function shotLabel(clipIndex: number, shotIndex: number): string {
  return `C${clipIndex + 1}·S${shotIndex + 1}`;
}

/** The takes of the cut's primary track that belong to a known clip and shot, in time order. */
export function shotSpans(timeline: Timeline, clips: Record<string, Clip>): FeedbackShotSpan[] {
  const out: FeedbackShotSpan[] = [];
  for (const item of primaryTrack(timeline).items as VideoItem[]) {
    if (item.kind !== 'video' || item.source.type !== 'take') continue;
    const clip = clips[item.source.clipId];
    const shot = clip?.shots.find((s) => s.id === (item.source as { shotId: string }).shotId);
    if (!clip || !shot) continue;
    out.push({
      clipId: clip.id,
      shotId: shot.id,
      takeId: item.source.takeId,
      label: shotLabel(clip.index, shot.index),
      clipIndex: clip.index,
      shotIndex: shot.index,
      start: round3(item.start),
      end: round3(itemEnd(item)),
    });
  }
  return out.sort((a, b) => a.start - b.start);
}

/** The cuts of the cut: where each primary item after the first starts, and how long its transition lasts. */
export function cutPoints(timeline: Timeline): { at: number; window: number }[] {
  const items = primaryTrack(timeline).items as VideoItem[];
  return items.slice(1).map((item) => ({ at: item.start, window: item.transitionIn?.duration ?? 0 }));
}

/**
 * Scene changes farther than `tolerance` from every cut (and outside every transition): jumps inside shots
 * (docs/design/feedback.md#how-a-film-is-watched).
 */
export function unexpectedCuts(
  changes: { t: number; score: number }[],
  cuts: { at: number; window: number }[],
  opts: { tolerance?: number; minScore?: number; durationSec?: number } = {},
): { at: number; score: number }[] {
  const tolerance = opts.tolerance ?? 0.3;
  const minScore = opts.minScore ?? 0.4;
  return changes
    .filter((c) => c.score >= minScore)
    .filter((c) => c.t > tolerance && (opts.durationSec === undefined || c.t < opts.durationSec - tolerance))
    .filter((c) => cuts.every((cut) => Math.abs(c.t - cut.at) > Math.max(tolerance, cut.window + tolerance)))
    .map((c) => ({ at: round3(c.t), score: round3(c.score) }));
}

function shotOf(clips: Record<string, Clip>, span: FeedbackShotSpan): Shot | undefined {
  return clips[span.clipId]?.shots.find((s) => s.id === span.shotId);
}

/** More than three consecutive shots of a scene with the same framing. */
export function framingRuns(
  spans: FeedbackShotSpan[],
  clips: Record<string, Clip>,
): FeedbackSignals['framingRuns'] {
  const out: FeedbackSignals['framingRuns'] = [];
  let run: { clipId: string; framing: string; spans: FeedbackShotSpan[] } | null = null;
  const flush = () => {
    if (run && run.spans.length > 3)
      out.push({
        clipId: run.clipId,
        framing: run.framing,
        count: run.spans.length,
        start: run.spans[0]!.start,
        end: run.spans[run.spans.length - 1]!.end,
      });
    run = null;
  };
  for (const span of spans) {
    const framing = shotOf(clips, span)?.camera.framing ?? 'medium';
    if (run && run.clipId === span.clipId && run.framing === framing) run.spans.push(span);
    else {
      flush();
      run = { clipId: span.clipId, framing, spans: [span] };
    }
  }
  flush();
  return out;
}

/** Lines with more words than their shot has time for (`WORDS_PER_SECOND`). */
export function rushedLines(
  spans: FeedbackShotSpan[],
  clips: Record<string, Clip>,
): FeedbackSignals['rushedLines'] {
  const out: FeedbackSignals['rushedLines'] = [];
  for (const span of spans) {
    const shot = shotOf(clips, span);
    if (!shot) continue;
    const words = shot.dialogue.reduce((n, d) => n + countWords(d.line), 0);
    const durationSec = Math.max(0.1, span.end - span.start);
    if (words > Math.floor(durationSec * WORDS_PER_SECOND) + 1)
      out.push({
        clipId: span.clipId,
        shotId: span.shotId,
        shot: span.label,
        words,
        durationSec: round3(durationSec),
        start: span.start,
      });
  }
  return out;
}

function takeOf(clips: Record<string, Clip>, span: FeedbackShotSpan): { shot: Shot; take: Take } | null {
  const shot = shotOf(clips, span);
  const take = shot?.takes.find((t) => t.id === span.takeId);
  return shot && take ? { shot, take } : null;
}

/** The consistency state of the cut's takes. */
export function takeSignals(
  spans: FeedbackShotSpan[],
  clips: Record<string, Clip>,
  characters: Record<string, Character>,
  elements: Record<string, Element>,
): FeedbackSignals['takes'] {
  const out = { total: 0, passed: 0, failed: 0, unverified: 0, overridden: 0, stale: 0, qualityFailed: 0 };
  for (const span of spans) {
    const found = takeOf(clips, span);
    if (!found) continue;
    out.total++;
    const state = takeState(found.take, found.shot, characters, elements);
    out[state]++;
    if (found.take.consistency.quality?.passed === false) out.qualityFailed++;
  }
  return out;
}

const LOUDNESS_TARGETS: Record<string, number> = { streaming: -14, broadcast: -23 };

/** The `sound` dimension, from measurements: loudness on target, no long silences or clipping, speakable lines. */
export function soundScore(signals: FeedbackSignals): number | null {
  const l = signals.loudness;
  const measured = l && l.target !== 'off' && l.integratedLufs !== null;
  if (!measured && !signals.silences.length && !signals.rushedLines.length) return null;
  let score = 10;
  if (measured) {
    const target = LOUDNESS_TARGETS[l!.target];
    if (target !== undefined) score -= Math.min(4, Math.max(0, Math.abs(l!.integratedLufs! - target) - 1));
    if (l!.truePeakDb !== null && l!.truePeakDb > -1) score -= 1;
  }
  score -= Math.min(3, signals.silences.length * 0.5);
  score -= Math.min(2, signals.rushedLines.length * 0.25);
  return Math.round(Math.max(0, Math.min(10, score)) * 10) / 10;
}

type IssueDraft = Omit<FeedbackIssue, 'id'>;

/** Issues the signals raise on their own (`source: signal`). */
export function signalIssues(signals: FeedbackSignals, spans: FeedbackShotSpan[]): IssueDraft[] {
  const at = (t: number) => spans.find((s) => t >= s.start && t < s.end) ?? null;
  const pin = (t: number) => {
    const s = at(t);
    return { clipId: s?.clipId ?? null, shotId: s?.shotId ?? null, shot: s?.label ?? null };
  };
  const out: IssueDraft[] = [];
  const end = signals.durationSec;
  for (const b of signals.black) {
    // Fades at the very start and end are intended.
    if (b.start < 1 || b.end > end - 1) continue;
    out.push({
      dimension: 'editing',
      severity: b.end - b.start >= 1.5 ? 'major' : 'minor',
      title: `Black screen for ${(b.end - b.start).toFixed(1)} s`,
      detail: 'The picture goes black in the middle of the film.',
      start: b.start,
      end: b.end,
      ...pin(b.start),
      source: 'signal',
    });
  }
  for (const f of signals.frozen)
    out.push({
      dimension: 'temporal',
      severity: f.end - f.start >= 3 ? 'major' : 'minor',
      title: `Frozen picture for ${(f.end - f.start).toFixed(1)} s`,
      detail: 'Nothing moves: the shot may be a still image or a stalled generation.',
      start: f.start,
      end: f.end,
      ...pin(f.start),
      source: 'signal',
    });
  for (const c of signals.unexpectedCuts)
    out.push({
      dimension: 'temporal',
      severity: 'major',
      title: 'The picture jumps inside the shot',
      detail: `A sudden change (scene score ${c.score.toFixed(2)}) where the cut has no cut: a stray cut, a pop or a morph.`,
      start: Math.max(0, c.at - 0.25),
      end: c.at + 0.25,
      ...pin(c.at),
      source: 'signal',
    });
  for (const s of signals.silences)
    out.push({
      dimension: 'sound',
      severity: 'minor',
      title: `Silence for ${(s.end - s.start).toFixed(1)} s`,
      detail: 'No sound at all: add ambience, music or effects.',
      start: s.start,
      end: s.end,
      ...pin(s.start),
      source: 'signal',
    });
  for (const r of signals.rushedLines)
    out.push({
      dimension: 'sound',
      severity: 'minor',
      title: `Line too long for its shot (${r.words} words in ${r.durationSec.toFixed(1)} s)`,
      detail: `At ${WORDS_PER_SECOND} words a second it needs ${(r.words / WORDS_PER_SECOND).toFixed(1)} s: split it or shorten it.`,
      start: r.start,
      end: r.start + r.durationSec,
      clipId: r.clipId,
      shotId: r.shotId,
      shot: r.shot,
      source: 'signal',
    });
  for (const run of signals.framingRuns)
    out.push({
      dimension: 'cinematography',
      severity: 'minor',
      title: `${run.count} ${run.framing.replace(/_/g, ' ')} shots in a row`,
      detail: 'Vary the framing: wide to set the place, closer for emotion, inserts for detail.',
      start: run.start,
      end: run.end,
      clipId: run.clipId,
      shotId: null,
      shot: null,
      source: 'signal',
    });
  for (const m of signals.dialogue?.missing ?? [])
    out.push({
      dimension: 'dialogue',
      severity: 'major',
      title: `${m.character}’s line is not heard`,
      detail: `“${m.line.slice(0, 300)}”: ${Math.round(m.heard * 100)}% of its words were heard during ${m.shot}.`,
      start: m.start,
      end: m.end,
      clipId: m.clipId,
      shotId: m.shotId,
      shot: m.shot,
      source: 'signal',
    });
  return out;
}

/**
 * The project's characters a fix names as in frame (docs/design/feedback.md#actions), by name and ignoring case;
 * names of no character are left out.
 */
export function castIdsOf(
  names: string[],
  characters: Record<string, Pick<Character, 'id' | 'name'>>,
): string[] {
  const byName = new Map(Object.values(characters).map((c) => [c.name.trim().toLowerCase(), c.id]));
  return [
    ...new Set(names.map((n) => byName.get(n.trim().toLowerCase())).filter((id): id is string => !!id)),
  ];
}

/** The dimensions a scene's sound review answers for (`feedback.listen`). */
const HEARD_ONLY = new Set<string>(['dialogue', 'sound']);

/**
 * One scene's review from its two halves (docs/design/feedback.md#how-a-film-is-watched, step 3): the picture from the
 * strips (the vision model) and what was heard from the scene's video (the audio-visual model). Each keeps to what it
 * judges: the picture's sound claims and the sound's picture claims are dropped.
 */
export function mergeSceneOutputs(
  picture: FeedbackSceneOutput | null,
  heard: FeedbackSceneOutput | null,
): FeedbackSceneOutput | null {
  if (!picture && !heard) return null;
  const seen = <T extends { dimension: string }>(xs: T[] | undefined) =>
    (xs ?? []).filter((x) => !HEARD_ONLY.has(x.dimension));
  const listened = <T extends { dimension: string }>(xs: T[] | undefined) =>
    (xs ?? []).filter((x) => HEARD_ONLY.has(x.dimension));
  const scores: FeedbackSceneOutput['scores'] = { ...(picture?.scores ?? {}) };
  delete scores.dialogue;
  delete scores.sound;
  if (heard) {
    if (typeof heard.scores.dialogue === 'number') scores.dialogue = heard.scores.dialogue;
    if (typeof heard.scores.sound === 'number') scores.sound = heard.scores.sound;
  }
  return {
    scores,
    summary: [picture?.summary, heard?.summary ? `Heard: ${heard.summary}` : '']
      .filter(Boolean)
      .join(' ')
      .slice(0, 3000),
    strengths: [...(picture?.strengths ?? []), ...(heard?.strengths ?? [])].slice(0, 10),
    issues: [...seen(picture?.issues), ...listened(heard?.issues)],
    recommendations: [...seen(picture?.recommendations), ...listened(heard?.recommendations)],
    transcript: heard?.transcript ?? [],
  };
}

/** Seconds around a shot in which its lines may be heard (the model's times are approximate). */
const LINE_WINDOW_SEC = 1;

/**
 * The script's lines against what the audio-visual model heard (docs/design/feedback.md#how-a-film-is-watched, step 5):
 * each utterance of the transcript counts for one shot, the one within ±1 s whose lines it matches best (on a tie, the
 * shot it falls in), and each shot's voiced lines are compared with what counts for it; null when no scene was heard.
 */
export function dialogueDelivery(
  scenes: SceneReview[],
  clips: Record<string, Clip>,
  characters: Record<string, Character>,
): FeedbackSignals['dialogue'] {
  const listened = scenes.filter((s) => s.listened && s.output);
  if (!listened.length) return null;
  let lines = 0;
  let heard = 0;
  const missing: NonNullable<FeedbackSignals['dialogue']>['missing'] = [];
  for (const scene of listened) {
    const shots = scene.spans.flatMap((span) => {
      const shot = clips[span.clipId]?.shots.find((s) => s.id === span.shotId);
      const voiced = (shot?.dialogue ?? []).flatMap((d) =>
        d.characterId && d.line.trim()
          ? [{ character: characters[d.characterId]?.name ?? 'Someone', line: d.line }]
          : [],
      );
      return voiced.length ? [{ span, voiced, heard: [] as string[] }] : [];
    });
    for (const t of scene.output!.transcript) {
      const at = scene.start + t.time;
      const near = shots.filter(
        (s) => at >= s.span.start - LINE_WINDOW_SEC && at <= s.span.end + LINE_WINDOW_SEC,
      );
      const fit = (s: (typeof shots)[number]) =>
        Math.max(0, ...s.voiced.map((v) => heardShares([v.line], t.text)[0]!));
      const inside = (s: (typeof shots)[number]) => (at >= s.span.start && at < s.span.end ? 1 : 0);
      near.sort((a, b) => fit(b) - fit(a) || inside(b) - inside(a))[0]?.heard.push(t.text);
    }
    for (const { span, voiced, heard: said } of shots) {
      heardShares(
        voiced.map((v) => v.line),
        said.join(' '),
      ).forEach((share, i) => {
        lines++;
        if (share >= LINE_HEARD_RATIO) heard++;
        else
          missing.push({
            clipId: span.clipId,
            shotId: span.shotId,
            shot: span.label,
            character: voiced[i]!.character.slice(0, 200),
            line: voiced[i]!.line.slice(0, 2000),
            heard: share,
            start: span.start,
            end: span.end,
          });
      });
    }
  }
  return { lines, heard, missing: missing.slice(0, 500) };
}

/** One scene's review as the server got it (or its error). */
export interface SceneReview {
  clipId: string;
  index: number;
  title: string;
  start: number;
  end: number;
  spans: FeedbackShotSpan[];
  output: FeedbackSceneOutput | null;
  /** Watched as a video with its sound (an audio-visual model). */
  listened?: boolean;
  error?: string;
}

const SEVERITY_RANK: Record<FeedbackIssue['severity'], number> = { critical: 0, major: 1, minor: 2 };

/** The scores a review may give: the picture's, and what was heard when the model listened. */
function visionScores(v: VisionScores, listened = false): Partial<FeedbackScores> {
  const out: Partial<FeedbackScores> = {};
  for (const d of listened ? HEARD_DIMENSION_IDS : VISION_DIMENSION_IDS) {
    const x = (v as Record<string, number | undefined>)[d];
    if (typeof x === 'number' && Number.isFinite(x))
      out[d] = Math.round(Math.min(10, Math.max(0, x)) * 10) / 10;
  }
  return out;
}

/** Duration-weighted mean of the scenes' scores for one dimension. */
function sceneMean(scenes: SceneFeedback[], d: FeedbackDimension): number | null {
  let sum = 0;
  let weight = 0;
  for (const s of scenes) {
    const v = s.scores[d];
    if (typeof v !== 'number') continue;
    const w = Math.max(0.1, s.end - s.start);
    sum += v * w;
    weight += w;
  }
  return weight ? Math.round((sum / weight) * 10) / 10 : null;
}

function mapAction(
  a: LlmFeedbackAction | undefined,
  target: { clipId: string | null; shotId: string | null },
  sceneClip: (n: number) => string | null,
): FeedbackAction | null {
  if (!a) return null;
  if (a.kind === 'regenerate_shot') {
    if (!target.clipId || !target.shotId) return null;
    const fields = {
      ...(a.description ? { description: a.description } : {}),
      ...(a.action ? { action: a.action } : {}),
      ...(a.negativePrompt ? { negativePrompt: a.negativePrompt } : {}),
      ...(a.framing ? { framing: a.framing } : {}),
      ...(a.movement ? { movement: a.movement } : {}),
      ...(a.characters?.length ? { characters: a.characters } : {}),
    };
    return { kind: 'regenerate_shot', clipId: target.clipId, shotId: target.shotId, ...fields };
  }
  if (a.kind === 'replan_scene') {
    const clipId = a.scene !== undefined ? sceneClip(a.scene) : target.clipId;
    return clipId
      ? { kind: 'replan_scene', clipId, ...(a.direction ? { direction: a.direction } : {}) }
      : { kind: 'note' };
  }
  if (a.kind === 'settings')
    return a.settings && Object.keys(a.settings).length
      ? { kind: 'settings', patch: a.settings }
      : { kind: 'note' };
  return { kind: 'note' };
}

/**
 * The document from its parts (docs/design/feedback.md#how-a-film-is-watched, step 5): issue times from the cut,
 * stable ids, recommendations by priority and the weakness of their dimension, the film's scores falling back to the
 * scenes', `sound` from the signals and the overall weighted mean.
 */
export function assembleFeedback(input: {
  scenes: SceneReview[];
  film: FeedbackFilmOutput | null;
  signals: FeedbackSignals;
  retrospective: RetrospectiveItem[];
}): Pick<
  Feedback,
  'scores' | 'overall' | 'summary' | 'strengths' | 'scenes' | 'issues' | 'recommendations' | 'retrospective'
> {
  const sceneDocs: SceneFeedback[] = input.scenes.map((s) => ({
    clipId: s.clipId,
    index: s.index,
    title: s.title,
    start: s.start,
    end: s.end,
    scores: s.output ? visionScores(s.output.scores, s.listened) : {},
    summary: s.output?.summary ?? '',
    ...(s.error ? { error: s.error.slice(0, 1000) } : {}),
  }));
  const sceneClip = (n: number) => input.scenes.find((s) => s.index + 1 === n)?.clipId ?? null;
  // Issues: from the scenes (pinned to their shots) and from the signals.
  type Draft = IssueDraft & { key?: string };
  const drafts: Draft[] = [];
  for (const scene of input.scenes) {
    for (const issue of scene.output?.issues ?? []) {
      // A time in the scene's video places the issue when no shot does, or within its shot when no `at` does.
      const t = issue.time !== undefined ? Math.min(scene.end, scene.start + issue.time) : undefined;
      const span =
        issue.shot !== undefined
          ? scene.spans[issue.shot]
          : t !== undefined
            ? scene.spans.find((s) => t >= s.start && t < s.end)
            : undefined;
      const len = span ? span.end - span.start : 0;
      const within = t !== undefined && span && t >= span.start && t < span.end ? t : undefined;
      const start = span
        ? issue.at !== undefined
          ? span.start + issue.at * len
          : (within ?? span.start)
        : (t ?? scene.start);
      const end = span
        ? issue.at !== undefined || within !== undefined
          ? Math.min(span.end, start + 1)
          : span.end
        : t !== undefined
          ? Math.min(scene.end, t + 1)
          : scene.end;
      drafts.push({
        dimension: issue.dimension,
        severity: issue.severity,
        title: issue.title,
        detail: issue.detail,
        start: round3(start),
        end: round3(Math.max(start, end)),
        clipId: scene.clipId,
        shotId: span?.shotId ?? null,
        shot: span?.label ?? null,
        source: 'vision',
      });
    }
  }
  drafts.push(
    ...signalIssues(
      input.signals,
      input.scenes.flatMap((s) => s.spans),
    ),
  );
  drafts.sort((a, b) => a.start - b.start || SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
  const issues: FeedbackIssue[] = drafts.map((d, k) => ({ ...d, id: `i${k + 1}` }));

  // Scores: the film call's, else the scenes' duration-weighted mean. What was heard comes from the scenes only (the
  // film call reads text); `sound` is the mean of the measured and the heard score.
  const filmScores = input.film ? visionScores(input.film.scores) : {};
  const scores = {} as FeedbackScores;
  for (const d of FEEDBACK_DIMENSIONS) {
    if (d.id === 'sound') {
      const parts = [soundScore(input.signals), sceneMean(sceneDocs, 'sound')].filter(
        (v): v is number => v !== null,
      );
      scores.sound = parts.length
        ? Math.round((parts.reduce((a, b) => a + b, 0) / parts.length) * 10) / 10
        : null;
    } else if (d.id === 'dialogue') scores.dialogue = sceneMean(sceneDocs, 'dialogue');
    else scores[d.id] = filmScores[d.id] ?? sceneMean(sceneDocs, d.id);
  }
  const overall = weightedOverall(scores);

  // Recommendations: the scenes' (with their shot's issues) and the film's.
  type RecDraft = Omit<FeedbackRecommendation, 'id' | 'status'> & { order: number };
  const recs: RecDraft[] = [];
  input.scenes.forEach((scene) => {
    for (const r of scene.output?.recommendations ?? []) {
      const span = r.shot !== undefined ? scene.spans[r.shot] : undefined;
      recs.push({
        priority: clampPriority(r.priority),
        dimension: r.dimension,
        title: r.title,
        detail: r.detail,
        issueIds: issues
          .filter(
            (i) => i.source === 'vision' && span && i.shotId === span.shotId && i.dimension === r.dimension,
          )
          .map((i) => i.id),
        action: mapAction(r.action, { clipId: scene.clipId, shotId: span?.shotId ?? null }, sceneClip),
        order: scene.start,
      });
    }
  });
  for (const r of input.film?.recommendations ?? []) {
    const clipIds = r.scenes.map(sceneClip).filter((x): x is string => !!x);
    recs.push({
      priority: clampPriority(r.priority),
      dimension: r.dimension,
      title: r.title,
      detail: r.detail,
      issueIds: issues
        .filter((i) => i.clipId && clipIds.includes(i.clipId) && i.dimension === r.dimension)
        .map((i) => i.id)
        .slice(0, 20),
      action: mapAction(r.action, { clipId: clipIds[0] ?? null, shotId: null }, sceneClip),
      order: -1,
    });
  }
  // Lines that were not heard: generate their shot again, unless a recommendation already does.
  const missingByShot = new Map<string, NonNullable<FeedbackSignals['dialogue']>['missing']>();
  for (const m of input.signals.dialogue?.missing ?? [])
    missingByShot.set(m.shotId, [...(missingByShot.get(m.shotId) ?? []), m]);
  for (const [shotId, missing] of missingByShot) {
    if (recs.some((r) => r.action?.kind === 'regenerate_shot' && r.action.shotId === shotId)) continue;
    const m = missing[0]!;
    recs.push({
      priority: 1,
      dimension: 'dialogue',
      title: `Generate ${m.shot} again: ${missing.length === 1 ? 'a line is' : `${missing.length} lines are`} not heard`,
      detail: `${missing.map((x) => `${x.character}: “${x.line.slice(0, 200)}”`).join(' ')} The video model did not voice ${missing.length === 1 ? 'it' : 'them'} clearly; a new take with the same prompt usually does.`,
      issueIds: issues
        .filter((i) => i.source === 'signal' && i.dimension === 'dialogue' && i.shotId === shotId)
        .map((i) => i.id),
      action: { kind: 'regenerate_shot', clipId: m.clipId, shotId },
      order: m.start,
    });
  }
  const weakness = (d: FeedbackDimension) => scores[d] ?? 10;
  recs.sort(
    (a, b) => a.priority - b.priority || weakness(a.dimension) - weakness(b.dimension) || a.order - b.order,
  );
  const recommendations: FeedbackRecommendation[] = recs.slice(0, 300).map(({ order: _order, ...r }, k) => ({
    ...r,
    id: `r${k + 1}`,
    status: 'open',
  }));

  const strengths = input.film?.strengths.length
    ? input.film.strengths
    : [...new Set(input.scenes.flatMap((s) => s.output?.strengths ?? []))].slice(0, 8);
  const summary =
    input.film?.summary ||
    sceneDocs
      .filter((s) => s.summary)
      .map((s) => `${s.title}: ${s.summary}`)
      .join(' ')
      .slice(0, 8000);
  const lessons: RetrospectiveItem[] = (input.film?.lessons ?? []).map((l) => ({
    area: l.area,
    title: l.title,
    detail: l.detail,
    source: 'vision',
  }));
  return {
    scores,
    overall,
    summary,
    strengths: strengths.slice(0, 20),
    scenes: sceneDocs,
    issues: issues.slice(0, 1000),
    recommendations,
    retrospective: [...input.retrospective, ...lessons].slice(0, 60),
  };
}

function weightedOverall(scores: FeedbackScores): number | null {
  let sum = 0;
  let weight = 0;
  for (const d of FEEDBACK_DIMENSIONS) {
    const v = scores[d.id];
    if (typeof v !== 'number') continue;
    sum += v * d.weight;
    weight += d.weight;
  }
  return weight ? Math.round((sum / weight) * 10) / 10 : null;
}

function clampPriority(n: number): 1 | 2 | 3 {
  return n <= 1 ? 1 : n >= 3 ? 3 : 2;
}

/** `mm:ss.s` */
export function feedbackTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return `${String(m).padStart(2, '0')}:${s.toFixed(1).padStart(4, '0')}`;
}

/** The Markdown report (docs/design/feedback.md#the-report). */
export function feedbackMarkdown(
  fb: Feedback,
  ctx: { title: string; run?: { costUsd: number | null; videoSeconds: number; hours: number | null } },
): string {
  const lines: string[] = [];
  const score = (v: number | null | undefined) => (typeof v === 'number' ? `${v.toFixed(1)}/10` : '–');
  lines.push(`# Feedback: ${ctx.title}`, '');
  lines.push(
    `Export \`${fb.exportId}\` · ${feedbackTime(fb.durationSec)} · ${fb.model ? `watched by ${fb.model}${fb.listened && fb.listener ? `, heard by ${fb.listener}` : ''}` : 'measured only (no vision model)'} · ${fb.updatedAt.slice(0, 16).replace('T', ' ')}`,
    '',
  );
  const d = fb.signals.dialogue;
  if (d?.lines) lines.push(`Lines heard: ${d.heard} of ${d.lines}.`, '');
  lines.push(`**Overall: ${score(fb.overall)}**`, '', '| Dimension | Score |', '|---|---|');
  for (const d of FEEDBACK_DIMENSIONS) lines.push(`| ${d.label} | ${score(fb.scores[d.id])} |`);
  lines.push('');
  if (fb.summary) lines.push('## Summary', '', fb.summary, '');
  if (fb.strengths.length) lines.push('## Strengths', '', ...fb.strengths.map((s) => `- ${s}`), '');
  if (fb.recommendations.length) {
    lines.push('## Recommendations', '');
    for (const r of fb.recommendations)
      lines.push(
        `- **P${r.priority} · ${label(r.dimension)}: ${r.title}**${r.status !== 'open' ? ` _(${r.status})_` : ''}${r.detail ? ` — ${r.detail}` : ''}${r.action && r.action.kind !== 'note' ? ` \`${r.action.kind}\`` : ''}`,
      );
    lines.push('');
  }
  if (fb.retrospective.length) {
    lines.push('## Retrospective: what to improve next time', '');
    for (const r of fb.retrospective)
      lines.push(`- **${r.area} · ${r.title}**${r.detail ? ` — ${r.detail}` : ''}`);
    lines.push('');
  }
  if (fb.scenes.length) {
    lines.push('## Scenes', '');
    for (const s of fb.scenes) {
      const own = fb.issues.filter((i) => i.clipId === s.clipId);
      lines.push(
        `### ${s.index + 1}. ${s.title} (${feedbackTime(s.start)}–${feedbackTime(s.end)})`,
        '',
        s.error ? `_Not reviewed: ${s.error}_` : s.summary || '_No summary._',
        '',
      );
      for (const i of own)
        lines.push(
          `- ${feedbackTime(i.start)} ${i.shot ? `${i.shot} ` : ''}**${i.severity}** · ${label(i.dimension)}: ${i.title}${i.detail ? ` — ${i.detail}` : ''}`,
        );
      if (own.length) lines.push('');
    }
  }
  const sig = fb.signals;
  lines.push(
    '## Measurements',
    '',
    `- Length ${feedbackTime(sig.durationSec)}${sig.targetDurationSec ? ` (target ${feedbackTime(sig.targetDurationSec)})` : ''}`,
    `- Takes in the cut: ${sig.takes.total} (${sig.takes.passed} passed, ${sig.takes.unverified} unverified, ${sig.takes.overridden} overridden, ${sig.takes.qualityFailed} failed the quality checks)`,
    `- Jumps inside shots: ${sig.unexpectedCuts.length}; frozen stretches: ${sig.frozen.length}; black stretches: ${sig.black.length}; silences: ${sig.silences.length}`,
    `- Lines too long for their shot: ${sig.rushedLines.length}; runs of the same framing: ${sig.framingRuns.length}`,
  );
  if (sig.loudness)
    lines.push(
      `- Loudness: ${sig.loudness.integratedLufs ?? '–'} LUFS (target ${sig.loudness.target}), true peak ${sig.loudness.truePeakDb ?? '–'} dBTP`,
    );
  if (ctx.run)
    lines.push(
      `- Run: ${ctx.run.costUsd !== null ? `about $${ctx.run.costUsd.toFixed(2)}` : 'cost not priced'}, ${Math.round(ctx.run.videoSeconds)} s of video generated${ctx.run.hours !== null ? `, ${ctx.run.hours.toFixed(1)} h` : ''}`,
    );
  lines.push('');
  return lines.join('\n');
}

function label(d: FeedbackDimension): string {
  return FEEDBACK_DIMENSIONS.find((x) => x.id === d)?.label ?? d;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** Selected takes of the cut that are acceptable (used by the retrospective). */
export function acceptableTake(
  shot: Shot,
  take: Take,
  characters: Record<string, Character>,
  elements: Record<string, Element>,
): boolean {
  return isAcceptable(takeState(take, shot, characters, elements));
}

/**
 * The log of the export's signal pass (docs/design/feedback.md#how-a-film-is-watched, step 1): `blackdetect`,
 * `freezedetect`, scene scores printed by `metadata=print` after `select`, and `silencedetect`.
 */
export function parseSignalLog(
  log: string,
  durationSec: number,
): {
  black: { start: number; end: number }[];
  frozen: { start: number; end: number }[];
  silences: { start: number; end: number }[];
  changes: { t: number; score: number }[];
} {
  const black: { start: number; end: number }[] = [];
  const frozen: { start: number; end: number }[] = [];
  const silences: { start: number; end: number }[] = [];
  const changes: { t: number; score: number }[] = [];
  let freezeStart: number | null = null;
  let silenceStart: number | null = null;
  let t: number | null = null;
  const n = (re: RegExp, line: string) => {
    const m = re.exec(line);
    return m ? Number(m[1]) : null;
  };
  for (const line of log.split('\n')) {
    const bs = n(/black_start:\s*([\d.]+)/, line);
    const be = n(/black_end:\s*([\d.]+)/, line);
    if (bs !== null && be !== null) black.push({ start: round3(bs), end: round3(be) });
    const fs = n(/freeze_start:\s*([\d.]+)/, line);
    if (fs !== null) freezeStart = fs;
    const fe = n(/freeze_end:\s*([\d.]+)/, line);
    if (fe !== null && freezeStart !== null) {
      frozen.push({ start: round3(freezeStart), end: round3(fe) });
      freezeStart = null;
    }
    const ss = n(/silence_start:\s*(-?[\d.]+)/, line);
    if (ss !== null) silenceStart = Math.max(0, ss);
    const se = n(/silence_end:\s*([\d.]+)/, line);
    if (se !== null && silenceStart !== null) {
      silences.push({ start: round3(silenceStart), end: round3(se) });
      silenceStart = null;
    }
    const time = n(/pts_time:([\d.]+)/, line);
    if (time !== null && !line.includes('black_') && !line.includes('freeze')) t = time;
    const score = n(/lavfi\.scene_score=([\d.]+)/, line);
    if (score !== null && t !== null) {
      changes.push({ t: round3(t), score: round3(score) });
      t = null;
    }
  }
  if (freezeStart !== null && durationSec > freezeStart)
    frozen.push({ start: round3(freezeStart), end: round3(durationSec) });
  if (silenceStart !== null && durationSec > silenceStart)
    silences.push({ start: round3(silenceStart), end: round3(durationSec) });
  return { black, frozen, silences, changes };
}

/** A take passes every check: its identity verdict (or an override) and its quality checks, when they ran. */
export function takePassesChecks(
  take: Take,
  shot: Pick<Shot, 'characterIds'> & Partial<Pick<Shot, 'elementIds'>>,
  characters: Record<string, Character>,
  elements: Record<string, Element> = {},
): boolean {
  return (
    isAcceptable(takeState(take, shot, characters, elements)) && take.consistency.quality?.passed !== false
  );
}

/** What became of an applied shot fix (docs/design/feedback.md#when-a-fix-does-not-pass). */
export type FixOutcome =
  | { state: 'pending' }
  | {
      state: 'fixed' | 'not_fixed';
      clipId: string;
      shotId: string;
      takeId: string;
      /** The new take shows in the cut. */
      inCut: boolean;
      /** Why it did not pass. */
      issues: string[];
    };

/** The outcome of a `regenerate_shot` recommendation from the take its job made; null for anything else. */
export function fixOutcome(
  rec: FeedbackRecommendation,
  docs: {
    clips: Record<string, Clip>;
    characters: Record<string, Character>;
    elements: Record<string, Element>;
    timeline: Timeline | null;
  },
): FixOutcome | null {
  const action = rec.action;
  if (rec.status !== 'applied' || action?.kind !== 'regenerate_shot' || !rec.jobId) return null;
  const shot = docs.clips[action.clipId]?.shots.find((s) => s.id === action.shotId);
  const take = shot?.takes.find((t) => t.jobId === rec.jobId && t.video);
  if (!shot || !take) return { state: 'pending' };
  const inCut = !!docs.timeline?.tracks.some((track) =>
    track.items.some((i) => i.kind !== 'text' && i.source.type === 'take' && i.source.takeId === take.id),
  );
  const fixed = takePassesChecks(take, shot, docs.characters, docs.elements);
  const identity = take.consistency.characters.flatMap((c) => c.issues);
  return {
    state: fixed ? 'fixed' : 'not_fixed',
    clipId: action.clipId,
    shotId: action.shotId,
    takeId: take.id,
    inCut,
    issues: fixed ? [] : [...identity, ...(take.consistency.quality?.issues ?? [])].slice(0, 6),
  };
}

/** The mean video attempts of the project's selected takes, at least 1: what a shot of this film has cost so far. */
export function meanAttempts(clips: Record<string, Clip>): number {
  const attempts = Object.values(clips).flatMap((c) =>
    c.shots.flatMap((s) => {
      const t = s.takes.find((x) => x.id === s.selectedTakeId);
      return t ? [Math.max(1, t.consistency.attempts)] : [];
    }),
  );
  return attempts.length ? attempts.reduce((a, b) => a + b, 0) / attempts.length : 1;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * What applying a recommendation is expected to cost (docs/design/feedback.md#what-a-fix-costs): its shots' seconds
 * times the expected attempts, priced with the pinned video model (else the take's), plus a keyframe per attempt for a
 * shot without an approved storyboard frame. Null for an action that generates nothing.
 */
export function fixEstimate(
  action: FeedbackAction | null,
  docs: {
    clips: Record<string, Clip>;
    project: { settings: { models?: { image?: string; video?: string } } };
  },
  prices: Prices,
  attempts: number,
): FeedbackEstimate | null {
  if (!action || (action.kind !== 'regenerate_shot' && action.kind !== 'replan_scene')) return null;
  const clip = docs.clips[action.clipId];
  const shots =
    action.kind === 'regenerate_shot'
      ? (clip?.shots ?? []).filter((s) => s.id === action.shotId)
      : (clip?.shots ?? []);
  if (!shots.length) return null;
  const n = Math.max(1, attempts);
  const takes = shots.flatMap((s) => {
    const t = s.takes.find((x) => x.id === s.selectedTakeId) ?? s.takes.at(-1);
    return t ? [t] : [];
  });
  const pinned = (m: string | undefined) => (m && m !== 'auto' ? m : undefined);
  const models = docs.project.settings.models ?? {};
  const videoModel = pinned(models.video) ?? takes.find((t) => t.request.videoModel)?.request.videoModel;
  const imageModel = pinned(models.image) ?? takes.find((t) => t.request.imageModel)?.request.imageModel;
  const videoSeconds = round2(shots.reduce((sum, s) => sum + s.durationSec, 0) * n);
  const keyframes = shots.filter((s) => !s.board?.approved).length * n;
  const videoPrice = videoModel ? prices[videoModel]?.videoSecond : undefined;
  const imagePrice = (imageModel ? prices[imageModel]?.image : undefined) ?? 0;
  return {
    usd: videoPrice === undefined ? null : round2(videoSeconds * videoPrice + keyframes * imagePrice),
    videoSeconds,
    attempts: round2(n),
  };
}
