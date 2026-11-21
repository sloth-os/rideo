import { z } from 'zod';
import { DESK_UNIT_FORMAT, DeskUnitMetaSchema } from './library';
import { Sha256HexSchema } from './library-link';

/**
 * The desk embed protocol, version 1 (docs/design/director-desk.md#the-protocol): the messages rideo and the
 * 3D-Editor's director's desk exchange, as the 3D-Editor's contract defines them, with its additive library units
 * (docs/design/director-desk.md#library-units). Rideo keeps its own copy of the contract's fixtures
 * (packages/shared/test/fixtures/desk-protocol/) and tests these schemas against them.
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

// Library units (docs/design/director-desk.md#library-units): additive to version 1, exchanged only when the desk
// announced `ready.capabilities.units` and rideo's `open` carried `options.units`. A version of a library unit is
// `{ref, version, sha256}`: the library item's id, its version and the sha256 of the unit file's bytes.

/** The unit file's format version the desk reads (the 3D-Editor's `UNIT_DATA_VERSION`). */
export const DESK_UNIT_DATA_VERSION = 1 as const;
/** What a unit is, as its file says: a scene's set, a prop, a cast member's figure. */
export const DESK_UNIT_FILE_KINDS = ['set', 'prop', 'figure'] as const;
export const DeskUnitFileKindSchema = z.enum(DESK_UNIT_FILE_KINDS);
export type DeskUnitFileKind = z.infer<typeof DeskUnitFileKindSchema>;

/** The contract's bounds on library units (docs/design/director-desk.md#library-units). */
export const DESK_UNIT_LIMITS = {
  /** One unit file: the desk's `capabilities.units.maxBytes`. */
  unitBytes: 32 * 1024 * 1024,
  /** All the units of one `open`. */
  openBytes: 48 * 1024 * 1024,
  /** Units in one `open`: the set, 16 cast members and 64 elements. */
  openUnits: 81,
  /** A published unit's PNG thumbnail. */
  thumbnailBytes: 64 * 1024,
  /** A published unit's `meta`, as JSON in UTF-8. */
  metaBytes: 16 * 1024,
  /** Rows of `state.units`, and of `X-Desk-State-Units`. */
  stateUnits: 128,
  /** The `X-Desk-State-Units` header. */
  headerBytes: 8 * 1024,
} as const;

/** The codes of a refused `unit-publish` (`unit-ack` `code`). */
export const DESK_PUBLISH_REFUSALS = [
  'refused',
  'conflict',
  'too_large',
  'invalid',
  'unavailable',
  'failed',
] as const;
export type DeskPublishRefusal = (typeof DESK_PUBLISH_REFUSALS)[number];

/** What a slot's pin is staged as: its unit, or the brief's words while it waits or after it was refused. */
export const DESK_UNIT_STAGED = ['unit', 'pending', 'refused'] as const;
export type DeskUnitStaged = (typeof DESK_UNIT_STAGED)[number];
/** Why a pin waits (`pending`, tried again at the next open). */
export const DESK_UNIT_PENDING_REASONS = ['missing', 'mismatch', 'unavailable'] as const;
/** Why a pin was refused (`refused`, tried again only when the pin changes). */
export const DESK_UNIT_REFUSED_REASONS = [
  'unreadable',
  'too_new',
  'too_large',
  'wrong_kind',
  'figure_kind',
  'figure_rig',
  'over_budget',
  'set_ground',
] as const;

/** A version of a library item: an integer from 1, the library's. */
export const DeskUnitVersionSchema = z.number().int().min(1).max(1_000_000_000);

/** A pin as the brief carries it: the library item (`ref`), its version and its unit file's sha256. */
export const DeskBriefPinSchema = z.object({
  ref: DeskIdSchema,
  version: DeskUnitVersionSchema,
  sha256: Sha256HexSchema,
});
export type DeskBriefPin = z.infer<typeof DeskBriefPinSchema>;

/**
 * `ready.capabilities.units` as rideo reads it: leniently. Kinds rideo does not know are dropped; a capability that
 * lists no version 1 or no kind left is refused here, and the `ready` message reads it as absent ("no units").
 */
export const DeskUnitsCapabilitySchema = z
  .object({
    versions: z.array(z.number().int().positive()).min(1),
    kinds: z
      .array(z.string())
      .transform((kinds) =>
        kinds.filter((k): k is DeskUnitFileKind => (DESK_UNIT_FILE_KINDS as readonly string[]).includes(k)),
      ),
    maxBytes: z.number().int().positive(),
    publish: z.boolean(),
  })
  .refine((c) => c.versions.includes(1) && c.kinds.length > 0, 'no units this studio takes');
export type DeskUnitsCapability = z.infer<typeof DeskUnitsCapabilitySchema>;

/** `open.options.units`: library units on for this open; `publish` false: the desk offers no Save to library. */
export const DeskUnitsOptionSchema = z.object({ version: z.literal(1), publish: z.boolean() });
export type DeskUnitsOption = z.infer<typeof DeskUnitsOptionSchema>;

const unitBytesInRange = (b: ArrayBuffer) => b.byteLength >= 1 && b.byteLength <= DESK_UNIT_LIMITS.unitBytes;

/** One entry of `open.units`: the unit file of a pinned version (transferred). */
export const DeskOpenUnitSchema = z.object({
  ref: DeskIdSchema,
  version: DeskUnitVersionSchema,
  sha256: Sha256HexSchema,
  unit: z.object({
    format: z.string().min(1).max(64),
    version: z.number().int().positive(),
    data: ArrayBufferSchema.refine(unitBytesInRange, '1 byte to 32 MiB'),
  }),
});
export type DeskOpenUnit = z.infer<typeof DeskOpenUnitSchema>;

/** The brief slot a published unit came from: exactly one of a cast member, an element and the set. */
export const DeskUnitFromSchema = z
  .object({ castId: DeskIdSchema.nullable(), elementId: DeskIdSchema.nullable(), set: z.boolean() })
  .refine(
    (f) => [f.castId !== null, f.elementId !== null, f.set].filter(Boolean).length === 1,
    'exactly one of castId, elementId, set',
  );
export type DeskUnitFrom = z.infer<typeof DeskUnitFromSchema>;

/** A slot of the brief: its set, a cast member (`cast:<id>`) or an element (`el:<id>`). */
export const DESK_UNIT_SLOT_PATTERN = /^(set|cast:[A-Za-z0-9_.:-]{1,100}|el:[A-Za-z0-9_.:-]{1,100})$/;
export const DeskUnitSlotSchema = z.string().regex(DESK_UNIT_SLOT_PATTERN, "'set', 'cast:<id>' or 'el:<id>'");

/** Why a pin waits or was refused: a reason code, never `local` (what `X-Desk-State-Units` can carry). */
const DeskUnitWhySchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_-]{0,39}$/, 'a reason code')
  .refine((why) => why !== 'local', 'a reason code');

/** A row of `state.units`: a brief slot whose record has a pin, and what the scene holds for it. */
export const DeskStateUnitSchema = z.object({
  slot: DeskUnitSlotSchema,
  ref: DeskIdSchema,
  version: DeskUnitVersionSchema,
  sha256: Sha256HexSchema,
  staged: z.enum(DESK_UNIT_STAGED),
  /** Staged `unit`, but the slot no longer holds a linked instance (made local in the desk). */
  local: z.boolean(),
  why: DeskUnitWhySchema.optional(),
});
export type DeskStateUnit = z.infer<typeof DeskStateUnitSchema>;

/**
 * What a stored state uses for a slot, as rideo records it (`clip.deskState.units`, the `X-Desk-State-Units` header's
 * rows): a `state.units` row without its sha256 (a library version's file never changes).
 */
export const DeskStateUnitUseSchema = DeskStateUnitSchema.omit({ sha256: true });
export type DeskStateUnitUse = z.infer<typeof DeskStateUnitUseSchema>;

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
      /** The scene's place's 3D set (library units only). */
      unit: DeskBriefPinSchema.optional(),
    }),
    cast: z
      .array(
        z.object({
          id: DeskIdSchema,
          name: z.string().min(1).max(120),
          description: z.string().max(4000),
          kind: z.string().max(60).nullable(),
          heightM: z.number().min(0.1).max(4).nullable(),
          /** The character's 3D figure (library units only). */
          unit: DeskBriefPinSchema.optional(),
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
          /** A prop's 3D prop (library units only; a desk ignores one on a location, with a warning). */
          unit: DeskBriefPinSchema.optional(),
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
  /** Library units on for this open: only to a desk that announced them. */
  units: DeskUnitsOptionSchema.optional(),
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
  /**
   * The unit files of the brief's pins (transferred), only with `options.units`: in slot order, each `ref@version`
   * once, at most 48 MiB in all.
   */
  units: z
    .array(DeskOpenUnitSchema)
    .max(DESK_UNIT_LIMITS.openUnits)
    .superRefine((units, ctx) => {
      const seen = new Set<string>();
      let bytes = 0;
      units.forEach((u, i) => {
        const key = `${u.ref}@${u.version}`;
        if (seen.has(key)) ctx.addIssue({ code: 'custom', path: [i, 'ref'], message: `${key} is sent once` });
        seen.add(key);
        bytes += u.unit.data.byteLength;
      });
      if (bytes > DESK_UNIT_LIMITS.openBytes)
        ctx.addIssue({ code: 'custom', message: 'the units of an open are at most 48 MiB in all' });
    })
    .optional(),
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

/**
 * The answer to a `unit-publish`, with its `id` (docs/design/director-desk.md#publishing-and-linking): `ok` with the
 * item (`ref`), the version and whether it was `linked` to the entity the publish came from; else a `code`
 * (`DESK_PUBLISH_REFUSALS`) and a `message`.
 */
export const DeskUnitAckMessageSchema = z
  .object({
    type: z.literal('unit-ack'),
    id: DeskRequestIdSchema,
    ok: z.boolean(),
    ref: DeskIdSchema.optional(),
    version: DeskUnitVersionSchema.optional(),
    linked: z.boolean().optional(),
    code: z.string().min(1).max(40).optional(),
    message: z.string().max(2000).optional(),
  })
  .superRefine((m, ctx) => {
    if (!m.ok) return;
    for (const key of ['ref', 'version', 'linked'] as const)
      if (m[key] === undefined)
        ctx.addIssue({ code: 'custom', path: [key], message: 'required when ok is true' });
  });
export type DeskUnitAckMessage = z.infer<typeof DeskUnitAckMessageSchema>;

export const HostToDeskMessageSchema = z.discriminatedUnion('type', [
  DeskOpenMessageSchema,
  DeskExportMessageSchema,
  DeskCancelMessageSchema,
  DeskSaveMessageSchema,
  DeskResultAckMessageSchema,
  DeskUnitAckMessageSchema,
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
    /** Library units, read leniently: one rideo cannot use reads as absent, and `ready` is never refused for it. */
    units: DeskUnitsCapabilitySchema.optional().catch(undefined),
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
  /**
   * After an open with library units: what the state uses, one row per brief slot whose record has a pin, each slot
   * once. Read leniently: rows that do not validate, name a slot twice (no `X-Desk-State-Units` could carry them) or
   * are more than 128 read as unknown (absent) and the state is kept.
   */
  units: z
    .array(DeskStateUnitSchema)
    .max(DESK_UNIT_LIMITS.stateUnits)
    .superRefine((rows, ctx) => {
      const slots = new Set<string>();
      rows.forEach((row, i) => {
        if (slots.has(row.slot))
          ctx.addIssue({ code: 'custom', path: [i, 'slot'], message: `${row.slot} is named twice` });
        slots.add(row.slot);
      });
    })
    .optional()
    .catch(undefined),
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

/**
 * The desk's Save to library (docs/design/director-desk.md#publishing-and-linking), only after an open whose
 * `options.units.publish` was true: a unit file for the library, a new item or a new version of `newVersionOf` (the
 * version it was made from), from the brief slot `from` names. `unit.data` and `thumbnail.data` are transferred.
 */
export const DeskUnitPublishMessageSchema = z.object({
  type: z.literal('unit-publish'),
  id: DeskRequestIdSchema,
  kind: DeskUnitFileKindSchema,
  name: z.string().min(1).max(120),
  description: z.string().max(2000).optional(),
  newVersionOf: z.object({ ref: DeskIdSchema, version: DeskUnitVersionSchema }).optional(),
  from: DeskUnitFromSchema.optional(),
  unit: z.object({
    format: z.literal(DESK_UNIT_FORMAT),
    version: z.literal(DESK_UNIT_DATA_VERSION),
    data: ArrayBufferSchema.refine(unitBytesInRange, '1 byte to 32 MiB'),
  }),
  /** The sha256 of `unit.data`. */
  sha256: Sha256HexSchema,
  thumbnail: z
    .object({
      mime: z.literal('image/png'),
      data: ArrayBufferSchema.refine(
        (b) => b.byteLength >= 1 && b.byteLength <= DESK_UNIT_LIMITS.thumbnailBytes,
        '1 byte to 64 KiB',
      ),
    })
    .nullable(),
  /** The unit's facts, at most 16 KiB of JSON (the library keeps them with the version). */
  meta: DeskUnitMetaSchema,
});
export type DeskUnitPublishMessage = z.infer<typeof DeskUnitPublishMessageSchema>;

export const DeskToHostMessageSchema = z.discriminatedUnion('type', [
  DeskReadyMessageSchema,
  DeskOpenedMessageSchema,
  DeskStateMessageSchema,
  DeskProgressMessageSchema,
  DeskResultMessageSchema,
  DeskErrorMessageSchema,
  DeskCloseMessageSchema,
  DeskUnitPublishMessageSchema,
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
  DeskUnitAckMessageSchema,
  DeskReadyMessageSchema,
  DeskOpenedMessageSchema,
  DeskStateMessageSchema,
  DeskProgressMessageSchema,
  DeskResultMessageSchema,
  DeskErrorMessageSchema,
  DeskCloseMessageSchema,
  DeskUnitPublishMessageSchema,
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
  'unit-publish',
];
