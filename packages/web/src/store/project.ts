import {
  type Actor,
  applyDocChanges,
  type CommitSummary,
  evaluateWorkflow,
  type FocusKind,
  type Job,
  type ProjectDocs,
  type ProjectEvent,
  type WorkflowEvaluation,
} from '@rideo/shared';
import { create } from 'zustand';
import { api } from '../lib/api';

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
};

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
      const docs = applyDocChanges(state.docs, event.docs);
      const fromOthers = event.commit.author.kind !== 'user';
      return {
        next: {
          ...state,
          seq,
          commits,
          docs,
          workflow: evaluateWorkflow(docs),
          head: state.head ? { ...state.head, commit: event.commit.id } : state.head,
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
    try {
      const [state, commits] = await Promise.all([
        api.state(projectId),
        api.history(projectId, { limit: 100 }),
      ]);
      const slice: ProjectSlice = {
        ...emptySlice,
        projectId,
        seq: state.seq,
        head: state.head,
        docs: state.docs,
        workflow: evaluateWorkflow(state.docs),
        jobs: Object.fromEntries(state.jobs.map((j) => [j.id, j])),
        commits,
        activity: get().projectId === projectId ? get().activity : [],
        syncIssues: state.syncIssues,
      };
      set({ ...slice, loading: false });
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
