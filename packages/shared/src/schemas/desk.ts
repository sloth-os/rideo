import { z } from 'zod';

/**
 * The desk embed protocol, version 1 (docs/design/director-desk.md#the-protocol): the messages rideo and the
 * 3D-Editor's director's desk exchange, as the 3D-Editor's contract defines them. Rideo keeps its own copy of the
 * contract's fixtures (packages/shared/test/fixtures/desk-protocol/) and tests these schemas against them.
 */

export const DESK_PROTOCOL = '3d-desk' as const;
/** The protocol versions this studio speaks. */
export const DESK_PROTOCOL_VERSIONS: readonly number[] = [1];
export const DESK_STATE_FORMAT = '3d-editor.desk-state' as const;
export const DESK_STATE_VERSION = 1 as const;
/** The largest desk state the protocol allows, and the largest rideo stores (docs/design/director-desk.md#the-routes). */
export const DESK_STATE_MAX_BYTES = 64 * 1024 * 1024;

/** The protocol's ids (scenes, shots, cast, elements): rideo's own ids fit as they are. */
export const DeskIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$/, 'invalid desk id');
/** A request's id, chosen by its sender; the reply carries it. */
export const DeskRequestIdSchema = z.string().min(1).max(64);

export const DESK_MODES = ['motion', 'pose', 'camera'] as const;
export const DeskModeSchema = z.enum(DESK_MODES);
export type DeskMode = z.infer<typeof DeskModeSchema>;

/** The named moves of the protocol: the same 20 as rideo's move library (docs/design/directing.md#move-library). */
export const DESK_MOVES = [
  'locked_off',
  'push_in',
  'pull_out',
  'dolly_left',
  'dolly_right',
  'pan_left',
  'pan_right',
  'tilt_up',
  'tilt_down',
  'tracking_follow',
  'steadicam_walk',
  'orbit_left',
  'orbit_right',
  'crane_up',
  'crane_down',
  'whip_pan',
  'handheld',
  'dolly_zoom',
  'drone_flyover',
  'rack_focus',
] as const;
export const DeskMoveSchema = z.enum(DESK_MOVES);
export type DeskMove = z.infer<typeof DeskMoveSchema>;

export const DESK_TIMES_OF_DAY = [
  'dawn',
  'morning',
  'noon',
  'afternoon',
  'golden_hour',
  'dusk',
  'night',
] as const;
export const DeskTimeOfDaySchema = z.enum(DESK_TIMES_OF_DAY);
export type DeskTimeOfDay = z.infer<typeof DeskTimeOfDaySchema>;

const FramingSchema = z.enum([
  'extreme_wide',
  'wide',
  'medium',
  'medium_close',
  'close_up',
  'extreme_close_up',
  'over_shoulder',
  'pov',
  'insert',
]);

/** Even sizes only: the desk's clips are H.264 4:2:0. */
const EvenSizeSchema = z
  .number()
  .int()
  .min(16)
  .max(4096)
  .refine((n) => n % 2 === 0, 'an even number');
const FpsSchema = z.number().int().min(1).max(120);

/** Bytes, transferred (not copied) between the windows. */
export const ArrayBufferSchema = z.custom<ArrayBuffer>(
  (v) => v instanceof ArrayBuffer || Object.prototype.toString.call(v) === '[object ArrayBuffer]',
  'an ArrayBuffer',
);

/** What rideo tells the desk about a scene (docs/design/director-desk.md#the-brief). */
export const DeskBriefSchema = z
  .object({
    id: DeskIdSchema,
    name: z.string().min(1).max(200),
    fps: FpsSchema,
    width: EvenSizeSchema,
    height: EvenSizeSchema,
    set: z.object({
      description: z.string().max(4000),
      interior: z.boolean().nullable(),
      timeOfDay: DeskTimeOfDaySchema.nullable(),
    }),
    cast: z
      .array(
        z.object({
          id: DeskIdSchema,
          name: z.string().min(1).max(120),
          description: z.string().max(4000),
          kind: z.string().max(60).nullable(),
          heightM: z.number().min(0.1).max(4).nullable(),
        }),
      )
      .max(16),
    elements: z
      .array(
        z.object({
          id: DeskIdSchema,
          name: z.string().min(1).max(120),
          description: z.string().max(2000),
          kind: z.enum(['location', 'prop', 'other']),
        }),
      )
      .max(64),
    shots: z
      .array(
        z.object({
          id: DeskIdSchema,
          index: z.number().int().nonnegative(),
          durationSec: z.number().positive().max(600),
          description: z.string().max(4000),
          action: z.string().max(4000),
          castIds: z.array(DeskIdSchema),
          elementIds: z.array(DeskIdSchema),
          framing: FramingSchema.nullable(),
          movement: z.string().max(60).nullable(),
          move: DeskMoveSchema.nullable(),
          lensMm: z.number().int().min(8).max(800).nullable(),
          continuity: z.enum(['cut', 'continuous']),
          layout: z
            .array(
              z.object({
                castId: DeskIdSchema,
                side: z.enum(['left', 'centre', 'right']),
                facing: z.enum(['left', 'right', 'camera', 'away']),
              }),
            )
            .max(8),
        }),
      )
      .min(1)
      .max(200),
  })
  .superRefine((brief, ctx) => {
    const cast = new Set(brief.cast.map((c) => c.id));
    const elements = new Set(brief.elements.map((e) => e.id));
    brief.shots.forEach((shot, i) => {
      const before = brief.shots[i - 1];
      if (before && shot.index <= before.index)
        ctx.addIssue({ code: 'custom', path: ['shots', i, 'index'], message: 'indexes strictly increase' });
      shot.castIds.forEach((id, j) => {
        if (!cast.has(id))
          ctx.addIssue({
            code: 'custom',
            path: ['shots', i, 'castIds', j],
            message: `${id} is not in the cast`,
          });
      });
      shot.elementIds.forEach((id, j) => {
        if (!elements.has(id))
          ctx.addIssue({
            code: 'custom',
            path: ['shots', i, 'elementIds', j],
            message: `${id} is not an element`,
          });
      });
    });
  });
export type DeskBrief = z.infer<typeof DeskBriefSchema>;

/** The desk's opaque save of a staged scene: rideo stores it as it is given and never reads `data`. */
export const DeskStateSchema = z.object({
  format: z.literal(DESK_STATE_FORMAT),
  version: z.literal(DESK_STATE_VERSION),
  data: ArrayBufferSchema.refine((b) => b.byteLength <= DESK_STATE_MAX_BYTES, 'at most 64 MiB'),
});
export type DeskState = z.infer<typeof DeskStateSchema>;

export const DeskOpenOptionsSchema = z.object({
  hostName: z.string().max(40).optional(),
  modes: z.array(DeskModeSchema).optional(),
  defaultMode: DeskModeSchema.optional(),
  readOnly: z.boolean().optional(),
});
export type DeskOpenOptions = z.infer<typeof DeskOpenOptionsSchema>;

/** How the brief differs from the scene the state was staged from. */
export const DeskBriefChangesSchema = z.object({
  added: z.array(DeskIdSchema),
  removed: z.array(DeskIdSchema),
  retimed: z.array(DeskIdSchema),
  recast: z.array(DeskIdSchema),
  cast: z.object({ added: z.array(DeskIdSchema), removed: z.array(DeskIdSchema) }),
});
export type DeskBriefChanges = z.infer<typeof DeskBriefChangesSchema>;

/**
 * The bounds rideo puts on a result (docs/design/director-desk.md#the-result): at most as many shots as a brief has,
 * four files per shot (three clips and a still), names of a shot id and a suffix.
 */
export const DESK_RESULT_LIMITS = { shots: 200, files: 800, name: 200 } as const;

/** A file of a result, by its name. */
const DeskFileNameSchema = z.string().min(1).max(DESK_RESULT_LIMITS.name);

/** One shot of a result (docs/design/director-desk.md#the-result). */
export const DeskShotResultSchema = z.object({
  shotId: DeskIdSchema,
  /** max(1, round(durationSec × fps)): every file of the shot has exactly these. */
  frames: z.number().int().min(1),
  durationSec: z.number().positive(),
  references: z.object({
    motion: DeskFileNameSchema.optional(),
    pose: DeskFileNameSchema.optional(),
    camera: DeskFileNameSchema.optional(),
  }),
  still: DeskFileNameSchema.nullable(),
  camera: z.object({ lensMm: z.number().int().min(8).max(800), move: DeskMoveSchema.nullable() }),
  line: z.string(),
  moves: z.string().nullable(),
  planAgrees: z.boolean().nullable(),
  issues: z.array(
    z.object({ code: z.string(), severity: z.enum(['error', 'warning']), message: z.string() }),
  ),
});
export type DeskShotResult = z.infer<typeof DeskShotResultSchema>;

/** A file of a result: `<shotId>.<mode>.mp4` clips and `<shotId>.still.png` stills. */
export const DeskResultFileSchema = z.object({
  name: DeskFileNameSchema,
  mime: z.enum(['video/mp4', 'image/png']),
  data: ArrayBufferSchema,
});
export type DeskResultFile = z.infer<typeof DeskResultFileSchema>;

export const DESK_ERROR_CODES = [
  'bad_message',
  'unsupported_version',
  'invalid_scene',
  'busy',
  'export_unavailable',
  'export_failed',
  'out_of_memory',
  'cancelled',
  'not_open',
  'state_unreadable',
] as const;
export const DeskErrorCodeSchema = z.enum(DESK_ERROR_CODES);
export type DeskErrorCode = z.infer<typeof DeskErrorCodeSchema>;

// The handshake, posted on the window (the only messages that are)

/** The desk's first message, to its parent: the protocol versions it speaks. */
export const DeskHelloSchema = z.object({
  protocol: z.literal(DESK_PROTOCOL),
  type: z.literal('hello'),
  versions: z.array(z.number().int().positive()).min(1),
});
export type DeskHello = z.infer<typeof DeskHelloSchema>;

/** The host's answer, with the port every later message travels on. */
export const DeskConnectSchema = z.object({
  protocol: z.literal(DESK_PROTOCOL),
  type: z.literal('connect'),
  version: z.number().int().positive(),
});
export type DeskConnect = z.infer<typeof DeskConnectSchema>;

// Host to desk, on the port

export const DeskOpenMessageSchema = z.object({
  type: z.literal('open'),
  scene: DeskBriefSchema,
  state: DeskStateSchema.nullable(),
  options: DeskOpenOptionsSchema.optional(),
});
export const DeskExportMessageSchema = z.object({
  type: z.literal('export'),
  id: DeskRequestIdSchema,
  shots: z.array(DeskIdSchema).optional(),
  modes: z.array(DeskModeSchema).optional(),
  still: z.boolean().optional(),
});
export const DeskCancelMessageSchema = z.object({ type: z.literal('cancel'), id: DeskRequestIdSchema });
export const DeskSaveMessageSchema = z.object({ type: z.literal('save'), id: DeskRequestIdSchema });
export const DeskResultAckMessageSchema = z.object({
  type: z.literal('result-ack'),
  id: DeskRequestIdSchema,
  ok: z.boolean(),
  message: z.string().optional(),
  shots: z
    .array(z.object({ shotId: DeskIdSchema, ok: z.boolean(), error: z.string().optional() }))
    .optional(),
});

export const HostToDeskMessageSchema = z.discriminatedUnion('type', [
  DeskOpenMessageSchema,
  DeskExportMessageSchema,
  DeskCancelMessageSchema,
  DeskSaveMessageSchema,
  DeskResultAckMessageSchema,
]);
export type HostToDeskMessage = z.infer<typeof HostToDeskMessageSchema>;

// Desk to host, on the port

export const DeskReadyMessageSchema = z.object({
  type: z.literal('ready'),
  deskVersion: z.string(),
  protocol: z.literal(1),
  capabilities: z.object({
    export: z.object({
      available: z.boolean(),
      reason: z.string().nullable(),
      container: z.literal('mp4'),
      videoCodec: z.literal('avc1'),
      modes: z.array(DeskModeSchema),
    }),
    offline: z.boolean(),
  }),
});
export const DeskOpenedMessageSchema = z.object({
  type: z.literal('opened'),
  sceneId: DeskIdSchema,
  source: z.enum(['state', 'local', 'brief']),
  changes: DeskBriefChangesSchema.nullable(),
});
export const DeskStateMessageSchema = z.object({
  type: z.literal('state'),
  id: DeskRequestIdSchema.optional(),
  sceneId: DeskIdSchema,
  state: DeskStateSchema,
  shots: z.number().int().nonnegative(),
});
export const DeskProgressMessageSchema = z.object({
  type: z.literal('progress'),
  id: DeskRequestIdSchema,
  phase: z.enum(['prepare', 'render', 'encode', 'finish']),
  done: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  shotId: DeskIdSchema.optional(),
});
export const DeskResultMessageSchema = z.object({
  type: z.literal('result'),
  id: DeskRequestIdSchema,
  sceneId: DeskIdSchema,
  fps: FpsSchema,
  width: EvenSizeSchema,
  height: EvenSizeSchema,
  shots: z.array(DeskShotResultSchema).max(DESK_RESULT_LIMITS.shots),
  files: z.array(DeskResultFileSchema).max(DESK_RESULT_LIMITS.files),
});
export type DeskResultMessage = z.infer<typeof DeskResultMessageSchema>;
export const DeskErrorMessageSchema = z.object({
  type: z.literal('error'),
  id: DeskRequestIdSchema.optional(),
  code: DeskErrorCodeSchema,
  message: z.string(),
});
export const DeskCloseMessageSchema = z.object({
  type: z.literal('close'),
  reason: z.enum(['done', 'cancel']),
});

export const DeskToHostMessageSchema = z.discriminatedUnion('type', [
  DeskReadyMessageSchema,
  DeskOpenedMessageSchema,
  DeskStateMessageSchema,
  DeskProgressMessageSchema,
  DeskResultMessageSchema,
  DeskErrorMessageSchema,
  DeskCloseMessageSchema,
]);
export type DeskToHostMessage = z.infer<typeof DeskToHostMessageSchema>;

/** Every message of the protocol: the handshake on the window and both directions on the port. */
export const DeskProtocolMessageSchema = z.discriminatedUnion('type', [
  DeskHelloSchema,
  DeskConnectSchema,
  DeskOpenMessageSchema,
  DeskExportMessageSchema,
  DeskCancelMessageSchema,
  DeskSaveMessageSchema,
  DeskResultAckMessageSchema,
  DeskReadyMessageSchema,
  DeskOpenedMessageSchema,
  DeskStateMessageSchema,
  DeskProgressMessageSchema,
  DeskResultMessageSchema,
  DeskErrorMessageSchema,
  DeskCloseMessageSchema,
]);
export type DeskProtocolMessage = z.infer<typeof DeskProtocolMessageSchema>;

/** The types of a direction's messages, to tell an unknown type (ignored) from a known one that fails (bad_message). */
export const DESK_TO_HOST_TYPES: readonly string[] = [
  'ready',
  'opened',
  'state',
  'progress',
  'result',
  'error',
  'close',
];
