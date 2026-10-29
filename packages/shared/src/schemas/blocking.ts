import { z } from 'zod';
import { IdSchema, IsoDateSchema } from './common';

/**
 * A scene blocked in 3D (docs/design/director-desk.md#the-document): the set, the characters' marks, the props and a
 * camera per shot. Metres; the floor is y = 0, x runs to the right and z towards the front of the set.
 */

export const BLOCKING_POSES = [
  'stand',
  'walk',
  'run',
  'sit',
  'crouch',
  'kneel',
  'lie',
  'reach',
  'point',
  'wave',
] as const;
export const BlockingPoseSchema = z.enum(BLOCKING_POSES);
export type BlockingPose = z.infer<typeof BlockingPoseSchema>;

/** Where a described camera stands around its subjects (docs/design/director-desk.md#the-solver). */
export const CAMERA_ANGLES = [
  'front',
  'three_quarter_left',
  'three_quarter_right',
  'profile_left',
  'profile_right',
  'back',
  'over_shoulder',
  'pov',
] as const;
export const CameraAngleSchema = z.enum(CAMERA_ANGLES);
export type CameraAngle = z.infer<typeof CameraAngleSchema>;

export const CAMERA_HEIGHTS = ['eye', 'low', 'high', 'overhead'] as const;
export const CameraHeightSchema = z.enum(CAMERA_HEIGHTS);
export type CameraHeight = z.infer<typeof CameraHeightSchema>;

export const BLOCKING_MOVES = [
  'none',
  'push_in',
  'pull_out',
  'dolly_left',
  'dolly_right',
  'orbit_left',
  'orbit_right',
  'crane_up',
] as const;
export const BlockingMoveSchema = z.enum(BLOCKING_MOVES);
export type BlockingMove = z.infer<typeof BlockingMoveSchema>;

export const LANDMARK_SHAPES = ['box', 'cylinder', 'water', 'wall'] as const;
export const LandmarkShapeSchema = z.enum(LANDMARK_SHAPES);
export type LandmarkShape = z.infer<typeof LandmarkShapeSchema>;

const Coord = z.number().min(-500).max(500);
const Height = z.number().min(-10).max(200);
const Color = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'a #rrggbb colour');

/** How a camera was described: the solver places it from this and the shot's framing and lens. */
export const CameraSpecSchema = z.object({
  /** Character ids it frames (the shot's cast when empty). */
  subjects: z.array(IdSchema).max(8).default([]),
  angle: CameraAngleSchema.default('front'),
  height: CameraHeightSchema.default('eye'),
  move: BlockingMoveSchema.default('none'),
});
export type CameraSpec = z.infer<typeof CameraSpecSchema>;

export const CameraPlacementSchema = z.object({
  x: Coord,
  y: Height,
  z: Coord,
  targetX: Coord,
  targetY: Height,
  targetZ: Coord,
});
export type CameraPlacement = z.infer<typeof CameraPlacementSchema>;

export const BlockingCameraSchema = CameraPlacementSchema.extend({
  lensMm: z.number().min(8).max(800),
  /** Where a camera move ends (null: the camera holds). */
  end: CameraPlacementSchema.nullable().default(null),
});
export type BlockingCamera = z.infer<typeof BlockingCameraSchema>;

export const BlockingMarkSchema = z.object({
  x: Coord,
  z: Coord,
  facingDeg: z.number().min(-3600).max(3600).default(0),
  pose: BlockingPoseSchema.default('stand'),
  /** Where the character walks to during the shot. */
  toX: Coord.nullable().default(null),
  toZ: Coord.nullable().default(null),
});
export type BlockingMark = z.infer<typeof BlockingMarkSchema>;

export const BlockingShotSchema = z.object({
  /** Marks of the characters of this shot (by character id); the others keep their opening marks. */
  marks: z.record(z.string(), BlockingMarkSchema).default({}),
  camera: BlockingCameraSchema,
  spec: CameraSpecSchema.nullable().default(null),
});
export type BlockingShot = z.infer<typeof BlockingShotSchema>;

export const BlockingLandmarkSchema = z.object({
  id: z.string().min(1).max(40),
  label: z.string().max(80).default(''),
  shape: LandmarkShapeSchema.default('box'),
  x: Coord,
  z: Coord,
  width: z.number().min(0.05).max(500),
  depth: z.number().min(0.05).max(500),
  height: z.number().min(0.01).max(200),
  rotationDeg: z.number().min(-3600).max(3600).default(0),
  color: Color.default('#8a8f98'),
  elementId: IdSchema.nullable().default(null),
});
export type BlockingLandmark = z.infer<typeof BlockingLandmarkSchema>;

export const BlockingActorSchema = z.object({
  id: z.string().min(1).max(40),
  characterId: IdSchema,
  color: Color,
  heightM: z.number().min(0.3).max(4).default(1.7),
  x: Coord,
  z: Coord,
  facingDeg: z.number().min(-3600).max(3600).default(0),
  pose: BlockingPoseSchema.default('stand'),
});
export type BlockingActor = z.infer<typeof BlockingActorSchema>;

export const BlockingPropSchema = z.object({
  id: z.string().min(1).max(40),
  elementId: IdSchema.nullable().default(null),
  label: z.string().max(80).default(''),
  x: Coord,
  z: Coord,
  size: z.number().min(0.05).max(20).default(0.4),
  color: Color.default('#c9a227'),
  /** A character carrying it: it is drawn at their hand. */
  heldBy: IdSchema.nullable().default(null),
});
export type BlockingProp = z.infer<typeof BlockingPropSchema>;

export const BlockingSetSchema = z.object({
  width: z.number().min(2).max(200).default(12),
  depth: z.number().min(2).max(200).default(10),
  ground: z.string().max(80).default('ground'),
  interior: z.boolean().default(false),
  /** Where the key light comes from: 0° the front, 90° the right, 180° the back; and how high. */
  sun: z
    .object({
      azimuthDeg: z.number().min(-3600).max(3600).default(135),
      elevationDeg: z.number().min(2).max(90).default(40),
    })
    .default({ azimuthDeg: 135, elevationDeg: 40 }),
  landmarks: z.array(BlockingLandmarkSchema).max(24).default([]),
});
export type BlockingSet = z.infer<typeof BlockingSetSchema>;

export const SceneBlockingSchema = z.object({
  version: z.literal(1).default(1),
  /** Who placed it last: the AI (`scene.block`) or a person on the desk. */
  source: z.enum(['ai', 'user']).default('user'),
  updatedAt: IsoDateSchema,
  set: BlockingSetSchema.default({
    width: 12,
    depth: 10,
    ground: 'ground',
    interior: false,
    sun: { azimuthDeg: 135, elevationDeg: 40 },
    landmarks: [],
  }),
  actors: z.array(BlockingActorSchema).max(8).default([]),
  props: z.array(BlockingPropSchema).max(16).default([]),
  /** By shot id. */
  shots: z.record(z.string(), BlockingShotSchema).default({}),
});
export type SceneBlocking = z.infer<typeof SceneBlockingSchema>;

/** `settings.blocking` (docs/design/director-desk.md#jobs): off in the schema, on for new projects. */
export const BlockingSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  /** Send each shot's camera view to the image model as a layout reference. */
  layoutImage: z.boolean().default(true),
});
export type BlockingSettings = z.infer<typeof BlockingSettingsSchema>;

export const BLOCKING_ISSUE_CODES = [
  'line_crossed',
  'subject_out_of_frame',
  'camera_inside',
  'screen_direction',
  'absent_in_frame',
  'actors_overlap',
  'outside_set',
] as const;
export const BlockingIssueCodeSchema = z.enum(BLOCKING_ISSUE_CODES);
export type BlockingIssueCode = z.infer<typeof BlockingIssueCodeSchema>;

export const BlockingIssueSchema = z.object({
  code: BlockingIssueCodeSchema,
  severity: z.enum(['error', 'warning']),
  shotId: z.string().nullable().default(null),
  characterId: z.string().nullable().default(null),
  message: z.string().max(500),
});
export type BlockingIssue = z.infer<typeof BlockingIssueSchema>;
