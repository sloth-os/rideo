import type { ConsistencyReport, QualityVerdict } from '../schemas/clip';
import type { DialogueDirection } from '../schemas/llm';
import type { DialogueLevel } from '../schemas/project';

/**
 * Continuity, storytelling and realism (docs/design/continuity.md): dialogue levels, dialogue that fits its shot and
 * the quality checks of the gate. Pure, shared by the server, the studio and the tests.
 */

/** How fast a line is spoken, in words per second (a calm, clear pace for every level). */
export const WORDS_PER_SECOND = 2.2;
/** A scene change at or above this score inside one shot is a jump: a stray cut, a pop or a morph. */
export const TEMPORAL_JUMP_SCORE = 0.45;
/** The `select` threshold of the measurement (lower, so the highest score is known even without a jump). */
export const TEMPORAL_SCAN_SCORE = 0.25;

/** What each CEFR level means for a writer (docs/design/continuity.md#storytelling). */
export const DIALOGUE_LEVELS: Record<
  Exclude<DialogueLevel, 'any'>,
  { label: string; guidance: string; maxWords: number }
> = {
  A1: {
    label: 'A1 · beginner',
    guidance:
      'Use only the most common English words. Sentences of 3–6 words. Present simple only. No idioms, phrasal verbs or slang.',
    maxWords: 6,
  },
  A2: {
    label: 'A2 · elementary',
    guidance:
      'Use everyday English words. Sentences of up to 8 words. Present and past simple and "going to". No idioms or slang.',
    maxWords: 8,
  },
  B1: {
    label: 'B1 · intermediate',
    guidance:
      'Use everyday English words and common phrasal verbs (look at, come on, slow down). Sentences of up to 12 words. Present, past and future forms. Simple linking words (because, so, but, when). No rare idioms and no slang.',
    maxWords: 12,
  },
  B2: {
    label: 'B2 · upper intermediate',
    guidance:
      'Natural conversational English with some common idioms. Sentences of up to 16 words. Keep it clear.',
    maxWords: 16,
  },
  C1: {
    label: 'C1 · advanced',
    guidance: 'Natural, idiomatic English that suits each character.',
    maxWords: 24,
  },
  C2: {
    label: 'C2 · proficient',
    guidance: 'Natural, idiomatic English that suits each character.',
    maxWords: 30,
  },
};

/** Words of a line: runs of letters or digits (punctuation alone is not a word). */
export function countWords(text: string): number {
  return (text.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? []).length;
}

/** How many words a shot of this length can speak. */
export function wordsCapacity(durationSec: number): number {
  return Math.max(1, Math.floor(durationSec * WORDS_PER_SECOND));
}

/** The dialogue inputs of the writing and planning tasks for a level and the video model's longest shot. */
export function dialogueDirection(level: DialogueLevel, maxShotSec: number): DialogueDirection {
  const capacity = wordsCapacity(maxShotSec);
  if (level === 'any') return { maxWordsPerLine: capacity };
  const l = DIALOGUE_LEVELS[level];
  return {
    dialogueLevel: level,
    dialogueGuidance: l.guidance,
    maxWordsPerLine: Math.min(l.maxWords, capacity),
  };
}

interface FitShot {
  durationSec: number;
  continuity: 'cut' | 'continuous';
  dialogue: { character: string; line: string }[];
}

/**
 * Dialogue fits its shot (docs/design/continuity.md#shot-planning): a shot whose lines need more time is lengthened
 * up to the model's maximum, and lines that still do not fit move to continuous shots inserted after it (same
 * description and camera). Nothing is cut from a line: a single line longer than the longest shot keeps a shot of its
 * own at the maximum.
 */
export function fitDialogue<T extends FitShot>(shots: T[], opts: { minSec: number; maxSec: number }): T[] {
  const min = Math.max(0.5, opts.minSec);
  const max = Math.max(min, opts.maxSec);
  const need = (lines: FitShot['dialogue']) =>
    lines.reduce((sum, d) => sum + countWords(d.line), 0) / WORDS_PER_SECOND;
  const out: T[] = [];
  for (const shot of shots) {
    if (need(shot.dialogue) <= shot.durationSec) {
      out.push(shot);
      continue;
    }
    // Lines in order, packed into shots of at most `max` seconds.
    const groups: FitShot['dialogue'][] = [];
    let current: FitShot['dialogue'] = [];
    for (const line of shot.dialogue) {
      if (current.length && need([...current, line]) > max) {
        groups.push(current);
        current = [];
      }
      current.push(line);
    }
    if (current.length) groups.push(current);
    groups.forEach((lines, k) => {
      const seconds = Math.min(max, Math.max(min, Math.ceil(need(lines) * 10) / 10));
      out.push({
        ...shot,
        dialogue: lines,
        durationSec: k === 0 ? Math.max(shot.durationSec, seconds) : seconds,
        continuity: k === 0 ? shot.continuity : 'continuous',
      });
    });
  }
  return out;
}

/** Scene scores printed by ffmpeg's `metadata=print` (after `select`): `{t, score}` per selected frame. */
export function parseSceneScores(text: string): { t: number; score: number }[] {
  const out: { t: number; score: number }[] = [];
  let t: number | null = null;
  for (const line of text.split('\n')) {
    const time = /pts_time:([0-9.]+)/.exec(line);
    if (time) {
      t = Number(time[1]);
      continue;
    }
    const score = /lavfi\.scene_score=([0-9.]+)/.exec(line);
    if (score && t !== null) {
      out.push({ t, score: Number(score[1]) });
      t = null;
    }
  }
  return out;
}

/** Jumps inside one shot: frames whose scene score reaches `TEMPORAL_JUMP_SCORE`. */
export function temporalVerdict(scores: { t: number; score: number }[]): {
  jumps: number[];
  maxScore: number;
} {
  return {
    jumps: scores.filter((s) => s.score >= TEMPORAL_JUMP_SCORE).map((s) => Math.round(s.t * 100) / 100),
    maxScore: Math.round(Math.max(0, ...scores.map((s) => s.score)) * 1000) / 1000,
  };
}

export interface QualityFrame {
  physics?: { score: number; issues?: string[] };
  continuity?: { score: number; issues?: string[] };
}

/**
 * The quality verdict of an attempt (docs/design/continuity.md#quality-checks-in-the-gate): the lowest physics
 * score, the mean continuity score and the temporal jumps; temporal and physics decide `passed`.
 */
export function aggregateQuality(input: {
  frames: QualityFrame[];
  temporal: { jumps: number[]; maxScore: number } | null;
  threshold: number;
}): QualityVerdict {
  const physicsScores = input.frames.flatMap((f) => (f.physics ? [clamp01(f.physics.score)] : []));
  const continuityScores = input.frames.flatMap((f) => (f.continuity ? [clamp01(f.continuity.score)] : []));
  const physics = physicsScores.length ? round3(Math.min(...physicsScores)) : null;
  const continuity = continuityScores.length
    ? round3(continuityScores.reduce((a, b) => a + b, 0) / continuityScores.length)
    : null;
  const issues = new Set<string>();
  if (input.temporal?.jumps.length)
    issues.add(`the shot jumps at ${input.temporal.jumps.map((t) => `${t.toFixed(1)} s`).join(', ')}`);
  for (const f of input.frames)
    if (f.physics && f.physics.score < input.threshold)
      for (const i of f.physics.issues ?? []) issues.add(i.slice(0, 500));
  for (const f of input.frames)
    if (f.continuity && f.continuity.score < 0.5)
      for (const i of f.continuity.issues ?? []) issues.add(`continuity: ${i}`.slice(0, 500));
  const passed = (physics === null || physics >= input.threshold) && !input.temporal?.jumps.length;
  return { passed, temporal: input.temporal, physics, continuity, issues: [...issues].slice(0, 20) };
}

/** Is attempt `a` better than `b`? Identity first, then quality, then the score. */
export function betterAttempt(
  a: Pick<ConsistencyReport, 'status' | 'score' | 'quality'>,
  b: Pick<ConsistencyReport, 'status' | 'score' | 'quality'> | null,
): boolean {
  if (!b) return true;
  const rank = (r: Pick<ConsistencyReport, 'status' | 'quality'>) =>
    (r.status !== 'failed' ? 2 : 0) + (r.quality?.passed === false ? 0 : 1);
  const ra = rank(a);
  const rb = rank(b);
  return ra !== rb ? ra > rb : a.score > b.score;
}

/** An attempt that needs no retry: identity not failed and the quality checks (when run) passed. */
export function attemptDone(r: Pick<ConsistencyReport, 'status' | 'quality'>): boolean {
  return r.status !== 'failed' && r.quality?.passed !== false;
}

function clamp01(n: number): number {
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
