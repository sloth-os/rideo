import {
  type Actor,
  applyDocChanges,
  applyOps,
  type CommitSummary,
  type Element,
  emptyTimeline,
  evaluateWorkflow,
  type FocusKind,
  type Job,
  type ProjectDocs,
  type ProjectEvent,
  type Timeline,
  type TimelineOp,
  type WorkflowEvaluation,
} from '@rideo/shared';
import { create } from 'zustand';
import { api } from '../lib/api';
import { recordTiming } from '../lib/telemetry';

export interface ActivityEntry {
  id: string;
  actor: Actor;
  action: string;
  summary: string;
  at: string;
}

export interface ProjectSlice {
  projectId: string | null;
  seq: number;
  head: { branch: string; commit: string | null } | null;
  docs: ProjectDocs | null;
  workflow: WorkflowEvaluation | null;
  jobs: Record<string, Job>;
  commits: CommitSummary[];
  activity: ActivityEntry[];
  syncIssues: { path: string; error: string }[];
  /** Entities changed by others recently (pulse highlight), keyed by `${kind}:${id}`. */
  touched: Record<string, number>;
  /**
   * Timeline edits made here that the server has not answered yet, oldest first: the timeline shown is
   * `serverTimeline` with them replayed (docs/design/editor.md#operations).
   */
  pendingEdits: TimelineOp[][];
  /** The timeline as the server last answered it. */
  serverTimeline: Timeline | null;
  /** A commit changed the timeline while edits were pending: the editor fetches it once they are answered. */
  timelineBehind: boolean;
}

export const emptySlice: ProjectSlice = {
  projectId: null,
  seq: 0,
  head: null,
  docs: null,
  workflow: null,
  jobs: {},
  commits: [],
  activity: [],
  syncIssues: [],
  touched: {},
  pendingEdits: [],
  serverTimeline: null,
  timelineBehind: false,
};

const TIMELINE = 'timeline.json';

/** An empty timeline in the project's format, for the first edit of a project without one. */
const blankTimeline = (docs: ProjectDocs): Timeline =>
  emptyTimeline({
    fps: docs.project.settings.fps,
    width: docs.project.settings.resolution.width,
    height: docs.project.settings.resolution.height,
  });

/**
 * The timeline shown while edits are pending (docs/design/editor.md#operations): the server's, with each pending batch
 * replayed in order. A batch that no longer applies is skipped here; it stays queued, and the server refuses it when
 * its turn comes.
 */
export function replayEdits(
  server: Timeline | null,
  pending: readonly TimelineOp[][],
  blank: () => Timeline,
): Timeline | null {
  let timeline = server;
  for (const ops of pending) {
    try {
      timeline = applyOps(timeline ?? blank(), ops);
    } catch {
      // skipped until the server answers it
    }
  }
  return timeline;
}

function touchedFromPaths(paths: string[]): Record<string, number> {
  const now = Date.now();
  const out: Record<string, number> = {};
  for (const p of paths) {
    const m = /^(characters|clips|resources|analyses|exports)\/([a-z]{3}_[0-9a-z]+)\.json$/.exec(p);
    const kind = m
      ? (
          {
            characters: 'character',
            clips: 'clip',
            resources: 'resource',
            analyses: 'analysis',
            exports: 'export',
          } as const
        )[m[1] as 'clips']
      : null;
    if (m && kind) out[`${kind}:${m[2]}`] = now;
    else out[`doc:${p}`] = now;
  }
  return out;
}

/** Pure reducer: applies one live event to the project slice (docs/design/realtime-sync.md#project-events). */
export function reduceEvent(
  state: ProjectSlice,
  seq: number,
  event: ProjectEvent,
): { next: ProjectSlice; refetch: boolean } {
  switch (event.kind) {
    case 'commit': {
      const replaces = typeof event.commit.meta?.replaces === 'string' ? event.commit.meta.replaces : null;
      const commits = [
        event.commit,
        ...state.commits.filter((c) => c.id !== replaces && c.id !== event.commit.id),
      ].slice(0, 300);
      const onBranch = !state.head || !event.commit.branch || event.commit.branch === state.head.branch;
      if (!onBranch) return { next: { ...state, seq, commits }, refetch: false };
      if (!event.docs || !state.docs) return { next: { ...state, seq, commits }, refetch: true };
      // While edits are pending a commit cannot say which of them it includes: the shown timeline stays, behind
      const timelineChanged = TIMELINE in event.docs;
      const behind = timelineChanged && state.pendingEdits.length > 0;
      const changes = behind
        ? Object.fromEntries(Object.entries(event.docs).filter(([path]) => path !== TIMELINE))
        : event.docs;
      const docs = applyDocChanges(state.docs, changes);
      const fromOthers = event.commit.author.kind !== 'user';
      return {
        next: {
          ...state,
          seq,
          commits,
          docs,
          workflow: evaluateWorkflow(docs),
          head: state.head ? { ...state.head, commit: event.commit.id } : state.head,
          serverTimeline: timelineChanged && !behind ? (docs.timeline ?? null) : state.serverTimeline,
          timelineBehind: state.timelineBehind || behind,
          touched: fromOthers
            ? { ...state.touched, ...touchedFromPaths(Object.keys(event.docs)) }
            : state.touched,
        },
        refetch: false,
      };
    }
    case 'job':
      return { next: { ...state, seq, jobs: { ...state.jobs, [event.job.id]: event.job } }, refetch: false };
    case 'activity':
      return {
        next: {
          ...state,
          seq,
          activity: [
            { id: `${seq}`, actor: event.actor, action: event.action, summary: event.summary, at: event.at },
            ...state.activity,
          ].slice(0, 100),
        },
        refetch: false,
      };
    case 'head':
      return { next: { ...state, seq }, refetch: true };
    case 'sync-issue':
      return {
        next: {
          ...state,
          seq,
          syncIssues: [
            ...state.syncIssues.filter((i) => i.path !== event.path),
            { path: event.path, error: event.error },
          ],
        },
        refetch: false,
      };
  }
}

interface ProjectStore extends ProjectSlice {
  loading: boolean;
  error: string | null;
  highlight: { kind: FocusKind; id: string; at: number } | null;
  playerCommand: { action: 'play' | 'pause' | 'seek'; time?: number; at: number } | null;
  load(projectId: string): Promise<ProjectSlice>;
  refresh(): Promise<void>;
  applyEvent(seq: number, event: ProjectEvent): boolean;
  /**
   * Optimistic timeline edit (docs/design/editor.md#operations): applies the ops with the shared reducer and queues
   * them until the server answers. Throws `TimelineOpError` for invalid ops, before anything is queued.
   */
  applyLocalOps(ops: TimelineOp[]): void;
  /** The server answered the oldest pending edit of `projectId` with its timeline: the rest replay on top of it. */
  confirmEdit(projectId: string, timeline: Timeline): void;
  /** The server refused the oldest pending edit of `projectId`: the rest replay on the server's timeline. */
  rejectEdit(projectId: string): void;
  /** The server's timeline (a restore, a fetch): pending edits replay on top of it, and it is no longer behind. */
  confirmTimeline(timeline: Timeline): void;
  focus(kind: FocusKind, id: string): void;
  player(action: 'play' | 'pause' | 'seek', time?: number): void;
  clear(): void;
}

export const useProject = create<ProjectStore>((set, get) => ({
  ...emptySlice,
  loading: false,
  error: null,
  highlight: null,
  playerCommand: null,
  async load(projectId) {
    set({
      loading: get().projectId !== projectId,
      error: null,
      ...(get().projectId !== projectId ? { ...emptySlice } : {}),
    });
    const started = performance.now();
    // The page renders from the state; the recent history fills in when it arrives: the first after a restart took
    // 26.5 s on OpenList (docs/design/realtime-sync.md#ordering-and-consistency)
    let early: ProjectSlice['commits'] | null = null;
    api
      .history(projectId, { limit: 100 })
      .then((commits) => {
        // Before the state: kept for the slice; after it: shown at once
        early = commits;
        if (get().projectId === projectId) set({ commits });
      })
      .catch(() => undefined);
    try {
      const state = await api.state(projectId);
      // A reload while edits are pending keeps the shown timeline: it is fetched once they are answered
      const before = get();
      const pending = before.projectId === projectId ? before.pendingEdits : [];
      const keep = pending.length > 0 && before.docs !== null;
      const docs = keep ? { ...state.docs, timeline: before.docs!.timeline } : state.docs;
      const slice: ProjectSlice = {
        ...emptySlice,
        projectId,
        seq: state.seq,
        head: state.head,
        docs,
        workflow: evaluateWorkflow(docs),
        jobs: Object.fromEntries(state.jobs.map((j) => [j.id, j])),
        // The history arrives on its own; a reload of the same project keeps the commits shown until then
        commits: early ?? (before.projectId === projectId ? before.commits : []),
        activity: before.projectId === projectId ? before.activity : [],
        syncIssues: state.syncIssues,
        pendingEdits: pending,
        serverTimeline: keep ? before.serverTimeline : (state.docs.timeline ?? null),
        timelineBehind: keep,
      };
      set({ ...slice, loading: false });
      recordTiming('project_load', (performance.now() - started) / 1000);
      return slice;
    } catch (err) {
      set({ loading: false, error: err instanceof Error ? err.message : String(err) });
      throw err;
    }
  },
  async refresh() {
    const id = get().projectId;
    if (id) await get().load(id);
  },
  applyEvent(seq, event) {
    const { next, refetch } = reduceEvent(get(), seq, event);
    set(next);
    return refetch;
  },
  applyLocalOps(ops) {
    const { docs, pendingEdits } = get();
    if (!docs) return;
    const next = applyOps(docs.timeline ?? blankTimeline(docs), ops);
    set({ docs: { ...docs, timeline: next }, pendingEdits: [...pendingEdits, ops] });
  },
  confirmEdit(projectId, timeline) {
    const { docs, pendingEdits } = get();
    if (get().projectId !== projectId || !docs) return;
    const rest = pendingEdits.slice(1);
    const shown = replayEdits(timeline, rest, () => blankTimeline(docs));
    set({ serverTimeline: timeline, pendingEdits: rest, docs: { ...docs, timeline: shown } });
  },
  rejectEdit(projectId) {
    const { docs, pendingEdits, serverTimeline } = get();
    if (get().projectId !== projectId || !docs) return;
    const rest = pendingEdits.slice(1);
    const shown = replayEdits(serverTimeline, rest, () => blankTimeline(docs));
    set({ pendingEdits: rest, docs: { ...docs, timeline: shown } });
  },
  confirmTimeline(timeline) {
    const { docs, pendingEdits } = get();
    if (!docs) return;
    const shown = replayEdits(timeline, pendingEdits, () => blankTimeline(docs));
    set({ serverTimeline: timeline, timelineBehind: false, docs: { ...docs, timeline: shown } });
  },
  focus(kind, id) {
    set({ highlight: { kind, id, at: Date.now() } });
  },
  player(action, time) {
    set({ playerCommand: { action, time, at: Date.now() } });
  },
  clear() {
    set({ ...emptySlice, loading: false, error: null, highlight: null, playerCommand: null });
  },
}));

/** A stable empty element map for selectors (a fresh `{}` would re-render forever). */
export const NO_ELEMENTS: Readonly<Record<string, Element>> = Object.freeze({});
