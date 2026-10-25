import { z } from 'zod';
import { ActorSchema, IsoDateSchema } from './common';
import { JobSchema } from './job';
import { NotificationSchema } from './review';
import { CommitSummarySchema } from './vcs';

export const VIEWS = [
  'overview',
  'story',
  'cast',
  'elements',
  'resources',
  'storyboard',
  'clips',
  'editor',
  'analysis',
  'history',
  'exports',
  'search',
] as const;
export const ViewSchema = z.enum(VIEWS);
export type View = z.infer<typeof ViewSchema>;

export const FOCUS_KINDS = [
  'scene',
  'beat',
  'character',
  'element',
  'clip',
  'shot',
  'take',
  'timeline-item',
  'commit',
  'job',
  'resource',
  'suggestion',
  'export',
] as const;
export const FocusKindSchema = z.enum(FOCUS_KINDS);
export type FocusKind = z.infer<typeof FocusKindSchema>;

export const ProjectEventSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('commit'),
    commit: CommitSummarySchema,
    docs: z.record(z.string(), z.unknown()).nullable(),
  }),
  z.object({ kind: z.literal('job'), job: JobSchema }),
  z.object({
    kind: z.literal('activity'),
    actor: ActorSchema,
    action: z.string(),
    summary: z.string(),
    at: IsoDateSchema,
  }),
  z.object({ kind: z.literal('head'), branch: z.string(), commit: z.string().nullable() }),
  z.object({ kind: z.literal('sync-issue'), path: z.string(), error: z.string() }),
]);
export type ProjectEvent = z.infer<typeof ProjectEventSchema>;

export const UiCommandSchema = z.object({
  id: z.string(),
  issuedBy: ActorSchema,
  projectId: z.string().optional(),
  sessionId: z.string().optional(),
  action: z.enum(['navigate', 'focus', 'notify', 'player']),
  params: z.object({
    view: ViewSchema.optional(),
    params: z.record(z.string(), z.string()).optional(),
    target: z.object({ kind: FocusKindSchema, id: z.string() }).optional(),
    message: z.string().max(2000).optional(),
    level: z.enum(['info', 'success', 'warning', 'error']).optional(),
    playerAction: z.enum(['play', 'pause', 'seek']).optional(),
    time: z.number().nonnegative().optional(),
  }),
});
export type UiCommand = z.infer<typeof UiCommandSchema>;

/** A browser's project store (docs/design/browser-storage.md#workspaces). */
export const WorkspaceIdSchema = z
  .string()
  .regex(/^ws_[0-9a-z]{26}$/, 'a workspace id (ws_ and 26 characters)');
export type WorkspaceId = z.infer<typeof WorkspaceIdSchema>;

/** Payloads up to this size travel inside the socket's messages; larger ones over HTTP transfers. */
export const STORAGE_INLINE_MAX = 256 * 1024;

/** A path inside a workspace: relative to the studio's root, absolute-looking, no `.` or `..` segments. */
export const WorkspacePathSchema = z
  .string()
  .min(1)
  .max(1024)
  .refine((p) => p.startsWith('/') && !p.split('/').some((s) => s === '.' || s === '..'), 'a workspace path');

export const STORAGE_OPS = ['read', 'stat', 'list', 'write', 'delete', 'move'] as const;
export type StorageOp = (typeof STORAGE_OPS)[number];

/** A storage operation the server asks a workspace's tab to perform (docs/design/browser-storage.md#the-protocol). */
export const StorageRequestSchema = z.object({
  type: z.literal('storage'),
  id: z.string().min(1).max(64),
  op: z.enum(STORAGE_OPS),
  path: WorkspacePathSchema,
  /** `move`: the destination. */
  to: WorkspacePathSchema.optional(),
  /** `read`: a byte range (inclusive). */
  range: z
    .object({ start: z.number().int().nonnegative(), end: z.number().int().nonnegative().optional() })
    .optional(),
  /** `write`: the bytes (base64), up to STORAGE_INLINE_MAX. */
  data: z.string().optional(),
  /** `write`: fetch the bytes from `GET /api/workspace/transfers/<transfer>`. */
  transfer: z.string().min(1).max(64).optional(),
  size: z.number().int().nonnegative().optional(),
  ifMatch: z.string().max(200).optional(),
  ifNoneMatch: z.literal('*').optional(),
  contentType: z.string().max(200).optional(),
});
export type StorageRequest = z.infer<typeof StorageRequestSchema>;

/** A workspace's answer to a storage operation. */
export const StorageResultSchema = z.object({
  type: z.literal('storage-result'),
  id: z.string().min(1).max(64),
  ok: z.boolean(),
  /** `stat`: Stat | null; `list`: Entry[]; `read`: {size, start, end} | null; `write`: {etag}. */
  result: z.unknown().optional(),
  /** `read`: the bytes (base64), when they fit. */
  data: z
    .string()
    .max(Math.ceil((STORAGE_INLINE_MAX * 4) / 3) + 8)
    .optional(),
  error: z.object({ code: z.string().max(64), message: z.string().max(2000) }).optional(),
});
export type StorageResult = z.infer<typeof StorageResultSchema>;

export const ServerMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('hello'),
    sessionId: z.string(),
    instanceId: z.string(),
    serverTime: z.string(),
  }),
  z.object({
    type: z.literal('event'),
    projectId: z.string(),
    seq: z.number().int(),
    event: ProjectEventSchema,
  }),
  z.object({ type: z.literal('resync'), projectId: z.string(), reason: z.string() }),
  z.object({ type: z.literal('ui'), command: UiCommandSchema }),
  z.object({ type: z.literal('pong') }),
  /** The answer to a `job-heartbeat` (docs/design/editor.md#editor-jobs). */
  z.object({
    type: z.literal('job-heartbeat'),
    jobId: z.string().max(100),
    /** False: the job is not leased to this session any more. */
    leased: z.boolean(),
    cancelled: z.boolean(),
    leaseExpiresAt: z.string().nullable(),
  }),
  z.object({ type: z.literal('error'), message: z.string() }),
  /** For the signed-in person (docs/design/review.md#notifications). */
  z.object({ type: z.literal('notification'), notification: NotificationSchema }),
  /** Browser storage (docs/design/browser-storage.md#the-protocol). */
  StorageRequestSchema,
  /** The server has listed the workspace's projects: it serves them now. */
  z.object({
    type: z.literal('workspace-ready'),
    workspaceId: WorkspaceIdSchema,
    projects: z.number().int(),
  }),
]);
export type ServerMessage = z.infer<typeof ServerMessageSchema>;

/** A tab's editor engine, reported with its presence (docs/design/realtime-sync.md#presence). */
export const EngineStateSchema = z.object({
  ffmpeg: z.enum(['unloaded', 'loading', 'ready', 'failed']),
  webcodecs: z.object({ video: z.string().max(20).nullable(), audio: z.string().max(20).nullable() }),
  busyJobId: z.string().max(100).nullable(),
  /** docs/design/engine-performance.md: the ffmpeg.wasm core's threads, the compositor, a hidden tab. */
  threads: z.number().int().min(1).max(64).optional(),
  compositor: z.enum(['webgpu', 'canvas']).nullable().optional(),
  hidden: z.boolean().optional(),
});
export type EngineState = z.infer<typeof EngineStateSchema>;

export const PresenceSchema = z.object({
  projectId: z.string().nullable(),
  route: z.string().max(500),
  selection: z.object({ kind: FocusKindSchema, id: z.string() }).nullable().optional(),
  viewport: z.object({ width: z.number(), height: z.number() }).optional(),
  engine: EngineStateSchema.optional(),
});
export type Presence = z.infer<typeof PresenceSchema>;

export const ClientMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('subscribe'), projectId: z.string(), lastSeq: z.number().int().optional() }),
  z.object({ type: z.literal('unsubscribe'), projectId: z.string() }),
  PresenceSchema.extend({ type: z.literal('presence') }),
  z.object({
    type: z.literal('ui-ack'),
    commandId: z.string(),
    ok: z.boolean(),
    error: z.string().optional(),
  }),
  z.object({ type: z.literal('ping') }),
  /** An editor job's heartbeat from the tab holding its lease (docs/design/editor.md#editor-jobs). */
  z.object({
    type: z.literal('job-heartbeat'),
    jobId: z.string().max(100),
    progress: z
      .object({
        done: z.number().nonnegative(),
        total: z.number().nonnegative(),
        message: z.string().max(300).optional(),
      })
      .optional(),
  }),
  /**
   * This tab serves a browser workspace (docs/design/browser-storage.md#the-protocol); `changed` names projects the
   * browser changed by itself (an import), so the server reads them afresh.
   */
  z.object({
    type: z.literal('workspace'),
    workspaceId: WorkspaceIdSchema,
    changed: z
      .array(z.string().regex(/^prj_[0-9a-z]{10,32}$/))
      .max(100)
      .optional(),
  }),
  StorageResultSchema,
]);
export type ClientMessage = z.infer<typeof ClientMessageSchema>;

export const SessionInfoSchema = z.object({
  sessionId: z.string(),
  projectIds: z.array(z.string()),
  presence: PresenceSchema.nullable(),
  connectedAt: z.string(),
  lastSeen: z.string(),
});
export type SessionInfo = z.infer<typeof SessionInfoSchema>;
