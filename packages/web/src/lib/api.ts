import type {
  Analysis,
  Annotation,
  AuditEvent,
  AuthMe,
  BranchInfo,
  Character,
  Clip,
  CommentTarget,
  CommentThread,
  CommitSummary,
  ConsentInput,
  DeliveryInput,
  Diff,
  EditKind,
  EditorJobKind,
  Element,
  ElementKind,
  ElementReferenceView,
  Export,
  ExportQuality,
  Job,
  LoudnessTarget,
  Notification,
  Probe,
  Project,
  ProjectDocs,
  ProjectRole,
  ProjectSummary,
  PublicUser,
  RenderEngineChoice,
  Resource,
  ResourceRole,
  Review,
  ReviewItem,
  ReviewTarget,
  Screenplay,
  TagInfo,
  Timeline,
  TimelineOp,
  TokenInfo,
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

/** A project's members as people (docs/design/accounts.md#surfaces). */
export interface ProjectAccessView {
  visibility: 'private' | 'studio';
  members: { userId: string; role: ProjectRole; name: string; email: string }[];
  invites: { email: string; role: ProjectRole; invitedBy: string; at: string }[];
  /** No access settings yet: open to everyone. */
  open: boolean;
  role: ProjectRole | null;
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
    tts: { provider: string; clone: boolean } | null;
    voiceJudge: boolean;
    /** Generated sound effects (docs/design/post-audio.md). */
    sfx?: { provider: string } | null;
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

/** Called when the server says the caller is not signed in (docs/design/accounts.md). */
let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(fn: (() => void) | null): void {
  onUnauthorized = fn;
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<T> {
  const token = getToken();
  const isForm = typeof FormData !== 'undefined' && body instanceof FormData;
  const isBlob = typeof Blob !== 'undefined' && body instanceof Blob;
  const res = await fetch(`/api${path}`, {
    method,
    headers: {
      ...(body !== undefined && !isForm
        ? { 'content-type': isBlob ? 'application/octet-stream' : 'application/json' }
        : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body:
      body === undefined ? undefined : isForm || isBlob ? (body as FormData | Blob) : JSON.stringify(body),
  });
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { detail: text };
  }
  if (res.status === 401 && !path.startsWith('/auth/')) onUnauthorized?.();
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

/** A download of the shot list (the token rides in the query like media URLs). */
export function shotListUrl(projectId: string, format: 'csv' | 'pdf'): string {
  const token = getToken();
  return `/api/projects/${projectId}/shotlist.${format}${token ? `?token=${encodeURIComponent(token)}` : ''}`;
}

export function mediaUrl(projectId: string, path: string): string {
  const token = getToken();
  return `/api/projects/${projectId}/media/${path}${token ? `?token=${encodeURIComponent(token)}` : ''}`;
}

/** The cut's subtitles, in a language when given (docs/design/localization.md#subtitle-files). */
export function subtitlesUrl(projectId: string, format: 'srt' | 'vtt', language?: string): string {
  const q = new URLSearchParams();
  if (language) q.set('language', language);
  const token = getToken();
  if (token) q.set('token', token);
  const qs = q.toString();
  return `/api/projects/${projectId}/subtitles.${format}${qs ? `?${qs}` : ''}`;
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
  /** Uploads a file with the browser's probe and poster (docs/design/editor.md#media-preparation-uploads). */
  upload: (
    id: string,
    file: File,
    opts: { role?: ResourceRole; probe?: Probe | null; poster?: Blob | null } = {},
  ) => {
    const form = new FormData();
    form.set(
      'meta',
      JSON.stringify({
        ...(opts.role ? { role: opts.role } : {}),
        ...(opts.probe ? { probe: opts.probe } : {}),
      }),
    );
    form.set('file', file, file.name);
    if (opts.poster) form.set('poster', opts.poster, 'poster.jpg');
    return request<Resource>('POST', `${p(id)}/uploads`, form);
  },
  doc: <T>(id: string, path: string, at?: string) =>
    request<T>('GET', `${p(id)}/docs/${path}${at ? `?at=${encodeURIComponent(at)}` : ''}`),
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
  /** `consent` states whether the image shows a real person (docs/design/provenance.md#consent-records). */
  uploadReference: (id: string, cid: string, file: File, view: string, consent: ConsentInput) => {
    const form = new FormData();
    form.set('view', view);
    form.set('consent', JSON.stringify(consent));
    form.set('file', file, file.name);
    return request<Character>('POST', `${p(id)}/characters/${cid}/references`, form);
  },
  approveReference: (id: string, cid: string, rid: string, approved: boolean) =>
    request<Character>('PATCH', `${p(id)}/characters/${cid}/references/${rid}`, { approved }),
  deleteReference: (id: string, cid: string, rid: string) =>
    request<Character>('DELETE', `${p(id)}/characters/${cid}/references/${rid}`),
  describeCharacter: (id: string, cid: string, resourceId: string, consent: ConsentInput) =>
    request<Job>('POST', `${p(id)}/characters/${cid}/describe`, { resourceId, consent }),
  lock: (id: string, cid: string) => request<Character>('POST', `${p(id)}/characters/${cid}/lock`),
  unlock: (id: string, cid: string) => request<Character>('POST', `${p(id)}/characters/${cid}/unlock`),
  // Voices (docs/design/dialogue.md#surfaces)
  designVoice: (id: string, cid: string) =>
    request<Job>('POST', `${p(id)}/characters/${cid}/voice/design`, {}),
  selectVoice: (id: string, cid: string, candidateId: string) =>
    request<Character>('POST', `${p(id)}/characters/${cid}/voice/select`, { candidateId }),
  /** `consent` states whether the recording is a real person (docs/design/provenance.md#consent-records). */
  cloneVoice: (id: string, cid: string, file: File, consent: ConsentInput) => {
    const form = new FormData();
    form.set('consent', JSON.stringify(consent));
    form.set('file', file, file.name);
    return request<Character>('POST', `${p(id)}/characters/${cid}/voice/clone`, form);
  },
  lockVoice: (id: string, cid: string) => request<Character>('POST', `${p(id)}/characters/${cid}/voice/lock`),
  unlockVoice: (id: string, cid: string) =>
    request<Character>('POST', `${p(id)}/characters/${cid}/voice/unlock`),
  // Elements: locations, props, styles (docs/design/elements.md)
  createElement: (id: string, body: { kind: ElementKind; name: string; description?: string }) =>
    request<Element>('POST', `${p(id)}/elements`, body),
  updateElement: (
    id: string,
    eid: string,
    body: { name?: string; description?: string; aliases?: string[] },
    coalesce?: string,
  ) =>
    request<Element>(
      'PATCH',
      `${p(id)}/elements/${eid}`,
      body,
      coalesce ? { 'x-rideo-coalesce': coalesce } : {},
    ),
  deleteElement: (id: string, eid: string) => request<void>('DELETE', `${p(id)}/elements/${eid}`),
  generateElementRefs: (id: string, eid: string, views?: ElementReferenceView[]) =>
    request<Job>('POST', `${p(id)}/elements/${eid}/references/generate`, views ? { views } : {}),
  uploadElementReference: (id: string, eid: string, file: File, view: ElementReferenceView) => {
    const form = new FormData();
    form.set('view', view);
    form.set('file', file, file.name);
    return request<Element>('POST', `${p(id)}/elements/${eid}/references`, form);
  },
  approveElementReference: (id: string, eid: string, rid: string, approved: boolean) =>
    request<Element>('PATCH', `${p(id)}/elements/${eid}/references/${rid}`, { approved }),
  deleteElementReference: (id: string, eid: string, rid: string) =>
    request<Element>('DELETE', `${p(id)}/elements/${eid}/references/${rid}`),
  lockElement: (id: string, eid: string) => request<Element>('POST', `${p(id)}/elements/${eid}/lock`),
  unlockElement: (id: string, eid: string) => request<Element>('POST', `${p(id)}/elements/${eid}/unlock`),
  generateMusic: (id: string, body: { prompt: string; durationSec?: number; instrumental?: boolean }) =>
    request<Job>('POST', `${p(id)}/music`, body),
  planClip: (id: string, sceneId: string, generate = false) =>
    request<Job>('POST', `${p(id)}/clips/plan`, { sceneId, generate }),
  generateClip: (id: string, clipId: string) => request<Job>('POST', `${p(id)}/clips/${clipId}/generate`),
  updateShot: (id: string, clipId: string, shotId: string, body: Record<string, unknown>) =>
    request<Clip>('PATCH', `${p(id)}/clips/${clipId}/shots/${shotId}`, body),
  // Take edits and extensions (docs/design/take-editing.md)
  editTake: (
    id: string,
    clipId: string,
    shotId: string,
    takeId: string,
    body: { kind: EditKind; instruction: string },
  ) => request<Job>('POST', `${p(id)}/clips/${clipId}/shots/${shotId}/takes/${takeId}/edit`, body),
  extendTake: (
    id: string,
    clipId: string,
    shotId: string,
    takeId: string,
    body: { seconds: number; prompt?: string },
  ) => request<Job>('POST', `${p(id)}/clips/${clipId}/shots/${shotId}/takes/${takeId}/extend`, body),
  extendItem: (
    id: string,
    itemId: string,
    body: { edge: 'start' | 'end'; seconds: number; prompt?: string },
  ) => request<Job>('POST', `${p(id)}/timeline/items/${itemId}/extend`, body),
  /** N takes with offset seeds (docs/design/directing.md#variations-and-comparison). */
  variations: (id: string, clipId: string, shotId: string, count: number) =>
    request<Job[]>('POST', `${p(id)}/clips/${clipId}/shots/${shotId}/variations`, { count }),
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
  /** Accounts (docs/design/accounts.md#surfaces). */
  me: () => request<AuthMe>('GET', '/auth/me'),
  logout: () => request<{ ok: true }>('POST', '/auth/logout', {}),
  projectAccess: (id: string) => request<ProjectAccessView>('GET', `${p(id)}/access`),
  setProjectAccess: (
    id: string,
    body: { visibility?: 'private' | 'studio'; members?: { email: string; role: ProjectRole }[] },
  ) => request<ProjectAccessView>('PUT', `${p(id)}/access`, body),
  tokens: () => request<TokenInfo[]>('GET', '/tokens'),
  createToken: (body: { name: string; role: ProjectRole; projectIds?: string[]; expiresInDays?: number }) =>
    request<{ token: TokenInfo; secret: string }>('POST', '/tokens', body),
  revokeToken: (id: string) => request<TokenInfo>('DELETE', `/tokens/${id}`),
  users: () => request<PublicUser[]>('GET', '/users'),
  updateUser: (id: string, body: { studioRole?: 'admin' | 'member'; disabled?: boolean }) =>
    request<PublicUser>('PATCH', `/users/${id}`, body),
  audit: (q: { projectId?: string; type?: string; limit?: number } = {}) => {
    const qs = new URLSearchParams(
      Object.entries(q).flatMap(([k, v]) => (v === undefined ? [] : [[k, String(v)]])),
    );
    return request<AuditEvent[]>('GET', `/audit${qs.size ? `?${qs}` : ''}`);
  },
  /** Post audio (docs/design/post-audio.md#surfaces): a cue per scene, effects from the action lines. */
  scoreCut: (id: string, body: { direction?: string }) =>
    request<Job>('POST', `${p(id)}/timeline/score`, body),
  generateEffects: (id: string) => request<Job>('POST', `${p(id)}/timeline/effects`, {}),
  /** Localization (docs/design/localization.md#surfaces). */
  localize: (id: string, body: { language: string; dub?: boolean; lipSync?: boolean }) =>
    request<Job>('POST', `${p(id)}/localizations`, body),
  updateTranslation: (id: string, language: string, body: { shotId: string; index: number; text: string }) =>
    request<unknown>('PATCH', `${p(id)}/localizations/${language}/lines`, body),
  removeLocalization: (id: string, language: string) =>
    request<void>('DELETE', `${p(id)}/localizations/${language}`),
  analyze: (id: string, resourceId: string) =>
    request<{ analysis: Analysis; job: Job }>('POST', `${p(id)}/analyses`, { resourceId }),
  reviewSuggestions: (
    id: string,
    aid: string,
    decisions: { id: string; status: 'pending' | 'accepted' | 'rejected' }[],
  ) => request<Analysis>('PATCH', `${p(id)}/analyses/${aid}/suggestions`, { decisions }),
  autoEdit: (id: string, aid: string) =>
    request<{ timeline: Timeline }>('POST', `${p(id)}/analyses/${aid}/auto-edit`),
  /** Queues an export; an editor tab renders it and the server watermarks it. */
  createExport: (
    id: string,
    body: {
      quality: ExportQuality;
      engine: RenderEngineChoice;
      source?: 'timeline' | 'animatic';
      loudness?: LoudnessTarget;
      stems?: boolean;
      language?: string;
      dubbed?: boolean;
      captions?: 'burn' | 'sidecar';
    } & Omit<DeliveryInput, 'loudness' | 'captions' | 'stems'>,
  ) => request<{ export: Export; job: Job }>('POST', `${p(id)}/exports`, body),
  // Storyboard and animatic (docs/design/storyboard.md#surfaces)
  generateStoryboard: (id: string) => request<Job>('POST', `${p(id)}/storyboard/generate`, {}),
  generateBoard: (id: string, clipId: string, shotId: string) =>
    request<Job>('POST', `${p(id)}/clips/${clipId}/shots/${shotId}/board/generate`, {}),
  approveBoard: (id: string, clipId: string, shotId: string, approved: boolean) =>
    request<Clip>('POST', `${p(id)}/clips/${clipId}/shots/${shotId}/board/approve`, { approved }),
  approveAllBoards: (id: string) =>
    request<{ approved: number }>('POST', `${p(id)}/storyboard/approve-all`, {}),
  reorderShots: (id: string, clipId: string, shotIds: string[]) =>
    request<Clip>('POST', `${p(id)}/clips/${clipId}/shots/reorder`, { shotIds }),
  buildAnimatic: (id: string, body: { musicResourceId?: string; captions?: boolean }) =>
    request<{ animatic: Timeline }>('POST', `${p(id)}/storyboard/animatic`, body),
  /** Fountain, Final Draft (.fdx) or PDF (docs/design/storyboard.md#screenplay-import). */
  importScreenplay: (id: string, file: File, replace: boolean) => {
    const form = new FormData();
    form.set('replace', String(replace));
    form.set('file', file, file.name);
    return request<{
      title: string;
      scenes: number;
      characters: number;
      elements: number;
      durationSec: number;
    }>('POST', `${p(id)}/screenplay/import`, form);
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
  // Editor jobs (docs/api/rest.md#editor-jobs)
  editorClaim: (sessionId: string, projectId: string, kinds?: EditorJobKind[]) =>
    request<{ job: Job | null }>('POST', '/editor/claim', {
      sessionId,
      projectId,
      ...(kinds ? { kinds } : {}),
    }),
  editorJob: (jobId: string) => request<Job>('GET', `/editor/jobs/${jobId}`),
  editorHeartbeat: (jobId: string, sessionId: string, progress?: Job['progress']) =>
    request<{ cancelled: boolean; leaseExpiresAt: string | null }>(
      'POST',
      `/editor/jobs/${jobId}/heartbeat`,
      {
        sessionId,
        ...(progress ? { progress } : {}),
      },
    ),
  editorUpload: (jobId: string, sessionId: string, name: string, data: Blob) =>
    request<{ name: string; size: number }>(
      'PUT',
      `/editor/jobs/${jobId}/files/${name}?sessionId=${encodeURIComponent(sessionId)}`,
      data,
    ),
  editorComplete: (jobId: string, sessionId: string, result: unknown) =>
    request<Job>('POST', `/editor/jobs/${jobId}/complete`, { sessionId, result }),
  editorFail: (jobId: string, sessionId: string, error: { code: string; message: string }) =>
    request<Job>('POST', `/editor/jobs/${jobId}/fail`, { sessionId, error }),
  detectMedia: (projectId: string, mediaPath: string) =>
    request<WatermarkDetection>('POST', '/watermark/detect', { projectId, mediaPath }),
  detectWatermark: (file: File) => {
    const form = new FormData();
    form.set('file', file, file.name);
    return request<WatermarkDetection>('POST', '/watermark/detect', form);
  },
  // Review and approvals (docs/design/review.md#surfaces)
  createComment: (id: string, body: CommentInput) =>
    request<CommentThread>('POST', `${p(id)}/comments`, body),
  replyComment: (id: string, commentId: string, body: string) =>
    request<CommentThread>('POST', `${p(id)}/comments/${commentId}/replies`, { body }),
  setCommentStatus: (id: string, commentId: string, status: 'open' | 'resolved') =>
    request<CommentThread>('PATCH', `${p(id)}/comments/${commentId}`, { status }),
  createReview: (
    id: string,
    body: {
      title: string;
      target: ReviewTarget;
      gate?: string | null;
      required?: number;
      link?: { expiresInDays?: number } | null;
    },
  ) => request<{ review: Review; url: string | null }>('POST', `${p(id)}/reviews`, body),
  decideReview: (id: string, reviewId: string, decision: 'approve' | 'changes', note?: string) =>
    request<Review>('POST', `${p(id)}/reviews/${reviewId}/decisions`, { decision, note }),
  revokeReviewLink: (id: string, reviewId: string) =>
    request<Review>('DELETE', `${p(id)}/reviews/${reviewId}/link`),
  notifications: (limit = 50) =>
    request<{ notifications: Notification[]; unread: number }>('GET', `/notifications?limit=${limit}`),
  markNotificationsRead: (ids?: string[]) =>
    request<{ unread: number }>('POST', '/notifications/read', ids ? { ids } : {}),
  // Guests of a share link: the token is the access
  guestReview: (token: string) => request<GuestReview>('GET', `/review/${token}`),
  guestComment: (token: string, name: string, body: CommentInput) =>
    request<CommentThread>('POST', `/review/${token}/comments`, { ...body, name }),
  guestReply: (token: string, name: string, commentId: string, body: string) =>
    request<CommentThread>('POST', `/review/${token}/comments/${commentId}/replies`, { name, body }),
  guestDecide: (token: string, name: string, decision: 'approve' | 'changes', note?: string) =>
    request<GuestReview['review']>('POST', `/review/${token}/decisions`, { name, decision, note }),
};

export interface CommentInput {
  target: CommentTarget;
  at?: number | null;
  annotation?: Annotation | null;
  body: string;
}

/** What a share link shows (docs/design/review.md#reviews-and-share-links). */
export interface GuestReview {
  projectId: string;
  project: { title: string };
  review: Omit<Review, 'link'>;
  items: ReviewItem[];
  comments: CommentThread[];
}

export function guestMediaUrl(token: string, path: string): string {
  return `/api/review/${token}/media/${path}`;
}

export interface WatermarkDetection {
  found: boolean;
  id?: string;
  corrected?: number;
  confidence: number;
  meanMargin: number;
  framesAnalyzed: number;
  /** Public callers (no token) get the brand, asset kind and creation time only. */
  provenance?: {
    id?: string;
    brand: { name: string; owner: string; url: string };
    projectId?: string;
    asset: { kind: string; id?: string; clipId?: string; shotId?: string };
    createdAt: string;
  } | null;
  metadata: { comment?: string; copyright?: string; description?: string };
  /** C2PA Content Credentials read from the file (docs/design/provenance.md#verification). */
  contentCredentials?: ContentCredentials;
}

export interface ContentCredentials {
  present: boolean;
  state?: 'invalid' | 'valid' | 'trusted';
  issues?: string[];
  signer?: { commonName?: string; issuer?: string };
  signedByThisStudio?: boolean;
  claimGenerator?: string;
  title?: string;
  aiGenerated?: boolean;
  digitalSourceType?: string;
  actions?: string[];
  ingredients?: number;
  watermarkId?: string | null;
  bound?: boolean;
  disclosure?: { label: boolean; text?: string; reason?: string | null } | null;
}
