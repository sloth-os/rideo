import { z } from 'zod';
import { ActorSchema, IsoDateSchema } from './common';
import { JobSchema } from './job';
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
  z.object({ type: z.literal('error'), message: z.string() }),
]);
export type ServerMessage = z.infer<typeof ServerMessageSchema>;

/** A tab's editor engine, reported with its presence (docs/design/realtime-sync.md#presence). */
export const EngineStateSchema = z.object({
  ffmpeg: z.enum(['unloaded', 'loading', 'ready', 'failed']),
  webcodecs: z.object({ video: z.string().max(20).nullable(), audio: z.string().max(20).nullable() }),
  busyJobId: z.string().max(100).nullable(),
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
