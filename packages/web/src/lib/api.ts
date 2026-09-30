import type {
  Analysis,
  BranchInfo,
  Character,
  Clip,
  CommitSummary,
  Diff,
  Export,
  Job,
  Project,
  ProjectDocs,
  ProjectSummary,
  Resource,
  Screenplay,
  TagInfo,
  Timeline,
  TimelineOp,
  WorkflowEvaluation,
} from '@rideo/shared';

export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail: string;
  code: string;
  errors?: unknown[];
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly problem: ProblemDetails,
  ) {
    super(problem.detail || problem.title || `HTTP ${status}`);
    this.name = 'ApiError';
  }
  get code(): string {
    return this.problem.code;
  }
}

export interface ProjectState {
  seq: number;
  head: { branch: string; commit: string | null };
  docs: ProjectDocs;
  jobs: Job[];
  workflow: WorkflowEvaluation;
  syncIssues: { path: string; error: string }[];
}

export interface PublicConfig {
  version: string;
  brand: { name: string; owner: string; url: string };
  user: { id: string; name: string };
  features: {
    mcp: boolean;
    embeddedDav: boolean;
    davUrl: string | null;
    webdavRoot: string;
    judge: string;
    stt: boolean;
    auth: boolean;
  };
  llm: { provider: string; model: string; vision: string };
  models: Record<'image' | 'video' | 'music', { id: string; limits?: Record<string, unknown> | null }[]>;
}

const TOKEN_KEY = 'rideo.token';

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    // storage unavailable (private mode): token lives for this page only
  }
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<T> {
  const token = getToken();
  const isForm = typeof FormData !== 'undefined' && body instanceof FormData;
  const res = await fetch(`/api${path}`, {
    method,
    headers: {
      ...(body !== undefined && !isForm ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : isForm ? (body as FormData) : JSON.stringify(body),
  });
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { detail: text };
  }
  if (!res.ok) {
    const problem = (json ?? {}) as Partial<ProblemDetails>;
    throw new ApiError(res.status, {
      type: problem.type ?? 'about:blank',
      title: problem.title ?? res.statusText,
      status: res.status,
      detail: problem.detail ?? res.statusText,
      code: problem.code ?? 'internal_error',
      errors: problem.errors,
    });
  }
  return json as T;
}

export function mediaUrl(projectId: string, path: string): string {
  const token = getToken();
  return `/api/projects/${projectId}/media/${path}${token ? `?token=${encodeURIComponent(token)}` : ''}`;
}

const p = (id: string) => `/projects/${id}`;

/** Typed REST client (docs/api/rest.md). */
export const api = {
  config: () => request<PublicConfig>('GET', '/config'),
  projects: () => request<ProjectSummary[]>('GET', '/projects'),
  createProject: (body: {
    kind: 'story' | 'edit';
    title: string;
    brief?: { prompt?: string };
    settings?: Record<string, unknown>;
  }) => request<Project>('POST', '/projects', body),
  deleteProject: (id: string) => request<void>('DELETE', p(id)),
  state: (id: string) => request<ProjectState>('GET', `${p(id)}/state`),
  updateProject: (
    id: string,
    body: {
      title?: string;
      brief?: { prompt?: string; attachmentResourceIds?: string[] };
      settings?: Record<string, unknown>;
    },
  ) => request<Project>('PATCH', p(id), body),
  sync: (id: string, discardInvalid = false) =>
    request<{ changed: string[]; issues: unknown[]; imported: string[] }>('POST', `${p(id)}/sync`, {
      discardInvalid,
    }),
  approve: (id: string, gate: string) =>
    request<WorkflowEvaluation>('POST', `${p(id)}/workflow/approve`, { gate }),
  reopen: (id: string, stage: string) =>
    request<WorkflowEvaluation>('POST', `${p(id)}/workflow/reopen`, { stage }),
  upload: (id: string, file: File, fields: Record<string, string> = {}) => {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) form.set(k, v);
    form.set('file', file, file.name);
    return request<Resource>('POST', `${p(id)}/uploads`, form);
  },
  generateScreenplay: (id: string, body: { prompt?: string; attachmentResourceIds?: string[] } = {}) =>
    request<Job>('POST', `${p(id)}/screenplay/generate`, body),
  patchScreenplay: (id: string, body: Record<string, unknown>, coalesce?: string) =>
    request<Screenplay>(
      'PATCH',
      `${p(id)}/screenplay`,
      body,
      coalesce ? { 'x-rideo-coalesce': coalesce } : {},
    ),
  extendScreenplay: (id: string, beats = 3) => request<Job>('POST', `${p(id)}/screenplay/extend`, { beats }),
  createCharacter: (id: string, body: { name: string; role?: string; summary?: string }) =>
    request<Character>('POST', `${p(id)}/characters`, body),
  updateCharacter: (id: string, cid: string, body: Record<string, unknown>, coalesce?: string) =>
    request<Character>(
      'PATCH',
      `${p(id)}/characters/${cid}`,
      body,
      coalesce ? { 'x-rideo-coalesce': coalesce } : {},
    ),
  deleteCharacter: (id: string, cid: string) => request<void>('DELETE', `${p(id)}/characters/${cid}`),
  generateRefs: (id: string, cid: string, views?: string[]) =>
    request<Job>('POST', `${p(id)}/characters/${cid}/references/generate`, views ? { views } : {}),
  uploadReference: (id: string, cid: string, file: File, view: string) => {
    const form = new FormData();
    form.set('view', view);
    form.set('file', file, file.name);
    return request<Character>('POST', `${p(id)}/characters/${cid}/references`, form);
  },
  approveReference: (id: string, cid: string, rid: string, approved: boolean) =>
    request<Character>('PATCH', `${p(id)}/characters/${cid}/references/${rid}`, { approved }),
  deleteReference: (id: string, cid: string, rid: string) =>
    request<Character>('DELETE', `${p(id)}/characters/${cid}/references/${rid}`),
  describeCharacter: (id: string, cid: string, resourceId: string) =>
    request<Job>('POST', `${p(id)}/characters/${cid}/describe`, { resourceId }),
  lock: (id: string, cid: string) => request<Character>('POST', `${p(id)}/characters/${cid}/lock`),
  unlock: (id: string, cid: string) => request<Character>('POST', `${p(id)}/characters/${cid}/unlock`),
  generateMusic: (id: string, body: { prompt: string; durationSec?: number; instrumental?: boolean }) =>
    request<Job>('POST', `${p(id)}/music`, body),
  planClip: (id: string, sceneId: string, generate = false) =>
    request<Job>('POST', `${p(id)}/clips/plan`, { sceneId, generate }),
  generateClip: (id: string, clipId: string) => request<Job>('POST', `${p(id)}/clips/${clipId}/generate`),
  updateShot: (id: string, clipId: string, shotId: string, body: Record<string, unknown>) =>
    request<Clip>('PATCH', `${p(id)}/clips/${clipId}/shots/${shotId}`, body),
  regenerateShot: (id: string, clipId: string, shotId: string) =>
    request<Job>('POST', `${p(id)}/clips/${clipId}/shots/${shotId}/regenerate`),
  selectTake: (id: string, clipId: string, shotId: string, takeId: string) =>
    request<Clip>('POST', `${p(id)}/clips/${clipId}/shots/${shotId}/takes/${takeId}/select`),
  overrideTake: (id: string, clipId: string, shotId: string, takeId: string, reason: string) =>
    request<Clip>('POST', `${p(id)}/clips/${clipId}/shots/${shotId}/takes/${takeId}/override`, { reason }),
  approveClip: (id: string, clipId: string) => request<Clip>('POST', `${p(id)}/clips/${clipId}/approve`),
  unapproveClip: (id: string, clipId: string) => request<Clip>('POST', `${p(id)}/clips/${clipId}/unapprove`),
  startBatch: (id: string) => request<Job>('POST', `${p(id)}/batch`, {}),
  pauseBatch: (id: string) => request<{ cancelled: string | null }>('DELETE', `${p(id)}/batch`),
  timeline: (id: string) => request<Timeline>('GET', `${p(id)}/timeline`),
  applyOps: (id: string, ops: TimelineOp[], coalesce?: string) =>
    request<{ timeline: Timeline; commit: CommitSummary | null }>(
      'POST',
      `${p(id)}/timeline/ops`,
      { ops },
      coalesce ? { 'x-rideo-coalesce': coalesce } : {},
    ),
  assemble: (id: string, body: { captions?: boolean; musicResourceId?: string }) =>
    request<{ timeline: Timeline }>('POST', `${p(id)}/timeline/assemble`, body),
  analyze: (id: string, resourceId: string) =>
    request<{ analysis: Analysis; job: Job }>('POST', `${p(id)}/analyses`, { resourceId }),
  reviewSuggestions: (
    id: string,
    aid: string,
    decisions: { id: string; status: 'pending' | 'accepted' | 'rejected' }[],
  ) => request<Analysis>('PATCH', `${p(id)}/analyses/${aid}/suggestions`, { decisions }),
  autoEdit: (id: string, aid: string) =>
    request<{ timeline: Timeline }>('POST', `${p(id)}/analyses/${aid}/auto-edit`),
  exportServer: (id: string, quality: 'draft' | 'standard' | 'high') =>
    request<{ export: Export; job: Job }>('POST', `${p(id)}/exports`, { quality }),
  exportUpload: (id: string, blob: Blob, meta: Record<string, unknown>, filename = 'browser-export.mp4') => {
    const form = new FormData();
    form.set('meta', JSON.stringify(meta));
    form.set('file', blob, filename);
    return request<{ export: Export; job: Job }>('POST', `${p(id)}/exports/upload`, form);
  },
  history: (id: string, q: { path?: string; limit?: number; before?: string } = {}) => {
    const qs = new URLSearchParams(
      Object.entries(q)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => [k, String(v)]),
    );
    return request<CommitSummary[]>('GET', `${p(id)}/history${qs.size ? `?${qs}` : ''}`);
  },
  diff: (id: string, from: string | null, to: string) =>
    request<Diff>('GET', `${p(id)}/history/diff?${from ? `from=${from}&` : ''}to=${to}`),
  restore: (id: string, commit: string, paths?: string[]) =>
    request<CommitSummary | null>('POST', `${p(id)}/history/restore`, { commit, paths }),
  branches: (id: string) => request<BranchInfo[]>('GET', `${p(id)}/branches`),
  createBranch: (id: string, name: string, from?: string) =>
    request<BranchInfo>('POST', `${p(id)}/branches`, { name, from }),
  switchBranch: (id: string, name: string) =>
    request<{ branch: string }>('POST', `${p(id)}/branches/${name}/switch`),
  tags: (id: string) => request<TagInfo[]>('GET', `${p(id)}/tags`),
  createTag: (id: string, name: string, commit?: string, message?: string) =>
    request<TagInfo>('POST', `${p(id)}/tags`, { name, commit, message }),
  cancelJob: (id: string, jobId: string) => request<Job>('POST', `${p(id)}/jobs/${jobId}/cancel`),
  detectMedia: (projectId: string, mediaPath: string) =>
    request<WatermarkDetection>('POST', '/watermark/detect', { projectId, mediaPath }),
  detectWatermark: (file: File) => {
    const form = new FormData();
    form.set('file', file, file.name);
    return request<WatermarkDetection>('POST', '/watermark/detect', form);
  },
};

export interface WatermarkDetection {
  found: boolean;
  id?: string;
  corrected?: number;
  confidence: number;
  meanMargin: number;
  framesAnalyzed: number;
  provenance?: {
    id: string;
    brand: { name: string; owner: string; url: string };
    projectId: string;
    asset: { kind: string; id: string; clipId?: string; shotId?: string };
    createdAt: string;
  } | null;
  metadata: { comment?: string; copyright?: string; description?: string };
}
