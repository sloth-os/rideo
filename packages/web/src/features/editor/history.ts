import type { CommitSummary } from '@rideo/shared';

/**
 * The editor's edit history (docs/design/editing-tools.md#undo-and-redo): commit ids of timeline states to go back
 * and forth to, and the commit the timeline is at. Undo and redo restore `timeline.json` from a commit, which makes a
 * new commit: history is never rewritten.
 */
export interface EditHistory {
  /** States to undo to, the latest last. */
  undo: string[];
  /** States to redo to, the latest last. */
  redo: string[];
  /** The commit of the timeline now. */
  current: string | null;
}

/** States kept on each stack. */
export const HISTORY_LIMIT = 100;

const changesTimeline = (c: CommitSummary) => c.changes.some((ch) => ch.path === 'timeline.json');
const keep = (ids: string[]) => ids.slice(-HISTORY_LIMIT);

/** At load: the last timeline change can be undone (to its parent). `commits` are newest first. */
export function seedHistory(commits: readonly CommitSummary[]): EditHistory {
  const last = commits.find(changesTimeline);
  const parent = last?.parents[0];
  return { undo: parent ? [parent] : [], redo: [], current: last?.id ?? null };
}

/** A confirmed edit: its parent goes onto undo, redo empties. No commit (nothing changed): no step. */
export function recordEdit(h: EditHistory, commit: CommitSummary | null): EditHistory {
  if (!commit) return h;
  const parent = commit.parents[0];
  return { undo: parent ? keep([...h.undo, parent]) : h.undo, redo: [], current: commit.id };
}

/** The state an undo restores, or null. */
export const undoTarget = (h: EditHistory): string | null => h.undo.at(-1) ?? null;
/** The state a redo restores, or null. */
export const redoTarget = (h: EditHistory): string | null => h.redo.at(-1) ?? null;

/** After an undo restored the top of undo as commit `restored` (null when nothing changed). */
export function undone(h: EditHistory, restored: string | null): EditHistory {
  const target = undoTarget(h);
  if (!target) return h;
  return {
    undo: h.undo.slice(0, -1),
    redo: h.current ? keep([...h.redo, h.current]) : h.redo,
    current: restored ?? target,
  };
}

/** After a redo restored the top of redo as commit `restored`. */
export function redone(h: EditHistory, restored: string | null): EditHistory {
  const target = redoTarget(h);
  if (!target) return h;
  return {
    undo: h.current ? keep([...h.undo, h.current]) : h.undo,
    redo: h.redo.slice(0, -1),
    current: restored ?? target,
  };
}
