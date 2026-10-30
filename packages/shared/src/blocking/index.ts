import type { CameraMoveId } from '../directing';
import {
  type BlockingActor,
  type BlockingCamera,
  type BlockingIssue,
  type BlockingLandmark,
  type BlockingMark,
  type BlockingPose,
  type BlockingShot,
  type CameraAngle,
  type CameraPlacement,
  type CameraSpec,
  type LandmarkShape,
  type SceneBlocking,
  SceneBlockingSchema,
} from '../schemas/blocking';
import type { Camera } from '../schemas/clip';
import { fnv1a32 } from '../util/hash';

/**
 * The 3D director's desk (docs/design/director-desk.md): projection through a shot's camera, the camera solver, the
 * 180° rule, normalization, the scene's checks and the blocking line of the prompts. Pure functions shared by the
 * server, the studio and agents, so the same blocking gives the same cameras, words and pixels everywhere (R3).
 */

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export type Framing = Camera['framing'];

/** What the desk needs of a shot. */
export interface BlockingShotInput {
  id: string;
  index: number;
  characterIds: string[];
  elementIds?: string[];
  camera: Pick<Camera, 'framing'> & { lensMm?: number | null };
  continuity?: 'cut' | 'continuous';
}

/** The desk palette, in cast order; the prompt names each colour. */
export const BLOCKING_PALETTE = [
  { color: '#ff8a3d', name: 'orange' },
  { color: '#3d8bff', name: 'blue' },
  { color: '#3dbe6b', name: 'green' },
  { color: '#a35bff', name: 'purple' },
  { color: '#f2c230', name: 'yellow' },
  { color: '#ff5fa2', name: 'pink' },
  { color: '#2ec4c4', name: 'teal' },
  { color: '#e5484d', name: 'red' },
] as const;

export function colorName(color: string): string {
  return BLOCKING_PALETTE.find((p) => p.color === color.toLowerCase())?.name ?? 'grey';
}

/** The sensor the lenses refer to: full frame, 36 mm wide. */
export const SENSOR_WIDTH_MM = 36;
/** Frame height at the subjects for a 1.7 m figure, by framing (docs/design/director-desk.md#the-solver). */
export const FRAMING_COVERAGE: Record<Framing, number> = {
  extreme_wide: 10,
  wide: 4.2,
  medium: 1.25,
  medium_close: 0.85,
  close_up: 0.45,
  extreme_close_up: 0.22,
  over_shoulder: 1.1,
  pov: 2.5,
  insert: 0.35,
};
/** The lens a framing gets when the shot has none. */
export const FRAMING_LENS: Record<Framing, number> = {
  extreme_wide: 18,
  wide: 24,
  medium: 35,
  medium_close: 50,
  close_up: 85,
  extreme_close_up: 100,
  over_shoulder: 50,
  pov: 28,
  insert: 85,
};
/** Where the camera looks on the figure, as a share of its height. */
const FRAMING_LOOK: Record<Framing, number> = {
  extreme_wide: 0.5,
  wide: 0.5,
  medium: 0.72,
  medium_close: 0.8,
  close_up: 0.92,
  extreme_close_up: 0.93,
  over_shoulder: 0.88,
  pov: 0.9,
  insert: 0.55,
};
/** How tall a figure is in each pose, as a share of its standing height. */
export const POSE_HEIGHT: Record<BlockingPose, number> = {
  stand: 1,
  walk: 1,
  run: 0.97,
  sit: 0.72,
  crouch: 0.62,
  kneel: 0.74,
  lie: 0.22,
  reach: 1,
  point: 1,
  wave: 1,
};
const ANGLE_DEG: Record<Exclude<CameraAngle, 'over_shoulder' | 'pov'>, number> = {
  front: 0,
  three_quarter_left: 35,
  three_quarter_right: -35,
  profile_left: 90,
  profile_right: -90,
  back: 180,
};
/** Two characters closer than this overlap. */
export const OVERLAP_M = 0.35;

const UP: Vec3 = { x: 0, y: 1, z: 0 };
const v3 = (x: number, y: number, z: number): Vec3 => ({ x, y, z });
const add = (a: Vec3, b: Vec3): Vec3 => v3(a.x + b.x, a.y + b.y, a.z + b.z);
const sub = (a: Vec3, b: Vec3): Vec3 => v3(a.x - b.x, a.y - b.y, a.z - b.z);
const mul = (a: Vec3, k: number): Vec3 => v3(a.x * k, a.y * k, a.z * k);
const dot = (a: Vec3, b: Vec3) => a.x * b.x + a.y * b.y + a.z * b.z;
const cross = (a: Vec3, b: Vec3): Vec3 =>
  v3(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
const len = (a: Vec3) => Math.hypot(a.x, a.y, a.z);
const norm = (a: Vec3): Vec3 => {
  const l = len(a);
  return l > 1e-9 ? mul(a, 1 / l) : v3(0, 0, 1);
};
const flat = (a: Vec3): Vec3 => v3(a.x, 0, a.z);
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const round3 = (n: number) => Math.round(n * 1000) / 1000;
const rad = (deg: number) => (deg * Math.PI) / 180;

/** The floor direction of a facing: 0° the front (+z), 90° the right (+x). */
export function facingVector(deg: number): Vec3 {
  return v3(Math.sin(rad(deg)), 0, Math.cos(rad(deg)));
}

/** The facing (degrees, 0–360) of a floor direction. */
export function facingOf(dir: Pick<Vec3, 'x' | 'z'>): number {
  const deg = (Math.atan2(dir.x, dir.z) * 180) / Math.PI;
  return Math.round(((deg % 360) + 360) % 360);
}

/** A direction turned towards the left of someone facing it (seen from above). */
function turnLeft(dir: Vec3, deg: number): Vec3 {
  const left = cross(UP, dir);
  return norm(add(mul(dir, Math.cos(rad(deg))), mul(left, Math.sin(rad(deg)))));
}

/** The direction towards the sun. */
export function sunVector(sun: SceneBlocking['set']['sun']): Vec3 {
  const az = rad(sun.azimuthDeg);
  const el = rad(sun.elevationDeg);
  return v3(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el));
}

export interface CameraBasis {
  pos: Vec3;
  forward: Vec3;
  right: Vec3;
  up: Vec3;
  /** tan of half the horizontal and the vertical field of view. */
  tanH: number;
  tanV: number;
}

export function lensTangents(lensMm: number, aspect: number): { tanH: number; tanV: number } {
  const tanH = SENSOR_WIDTH_MM / 2 / Math.max(1, lensMm);
  return { tanH, tanV: tanH / Math.max(0.1, aspect) };
}

/** The camera's frame of reference: it looks from its position at its target, with no roll. */
export function cameraBasis(cam: CameraPlacement & { lensMm: number }, aspect: number): CameraBasis {
  const pos = v3(cam.x, cam.y, cam.z);
  const forward = norm(sub(v3(cam.targetX, cam.targetY, cam.targetZ), pos));
  // Looking straight down or up: the top of the frame is the back of the set
  const right = Math.abs(forward.y) > 0.999 ? v3(1, 0, 0) : norm(cross(forward, UP));
  const up = cross(right, forward);
  return { pos, forward, right, up, ...lensTangents(cam.lensMm, aspect) };
}

/** A point through the camera: x to the right and y up in [-1, 1] when it is in the picture; depth along the view. */
export function projectPoint(b: CameraBasis, p: Vec3): { x: number; y: number; depth: number } {
  const d = sub(p, b.pos);
  const depth = dot(d, b.forward);
  if (depth <= 0.05) return { x: Number.NaN, y: Number.NaN, depth };
  return { x: dot(d, b.right) / (depth * b.tanH), y: dot(d, b.up) / (depth * b.tanV), depth };
}

const inPicture = (p: { x: number; y: number }, margin = 1) =>
  Number.isFinite(p.x) && Math.abs(p.x) <= margin && Math.abs(p.y) <= margin;

/** A character's mark in a shot: its own, or the scene's opening mark. */
export function markFor(blocking: SceneBlocking, shotId: string, characterId: string): BlockingMark | null {
  const own = blocking.shots[shotId]?.marks[characterId];
  if (own) return own;
  const actor = blocking.actors.find((a) => a.characterId === characterId);
  return actor
    ? { x: actor.x, z: actor.z, facingDeg: actor.facingDeg, pose: actor.pose, toX: null, toZ: null }
    : null;
}

function actorOf(blocking: SceneBlocking, characterId: string): BlockingActor | undefined {
  return blocking.actors.find((a) => a.characterId === characterId);
}

/** Points of a figure on its mark: feet, eyes, chest, the top of the head. */
export function figurePoints(mark: Pick<BlockingMark, 'x' | 'z' | 'pose'>, heightM: number) {
  const h = heightM * POSE_HEIGHT[mark.pose];
  const at = (k: number) => v3(mark.x, h * k, mark.z);
  return { feet: v3(mark.x, 0, mark.z), eyes: at(0.93), chest: at(0.72), head: at(1), height: h };
}

/** The floor position of the main pair's line in a shot, and on which side of it a point is (+1, -1, or 0 on it). */
function lineSide(a: Vec3, b: Vec3, p: Vec3): number {
  const u = sub(b, a);
  const w = sub(p, a);
  const c = u.x * w.z - u.z * w.x;
  const scale = Math.max(0.05, Math.hypot(u.x, u.z)) * 0.05;
  return Math.abs(c) < scale ? 0 : Math.sign(c);
}

/** A floor point mirrored across the line through a and b. */
function mirror(a: Vec3, b: Vec3, p: Vec3): Vec3 {
  const u = norm(flat(sub(b, a)));
  const w = flat(sub(p, a));
  const along = mul(u, dot(w, u));
  const m = sub(mul(along, 2), w);
  return v3(a.x + m.x, p.y, a.z + m.z);
}

/** The two characters who share the most shots (docs/design/director-desk.md#the-solver), or null. */
export function mainPair(shots: BlockingShotInput[]): [string, string] | null {
  const order: string[] = [];
  const together = new Map<string, number>();
  const alone = new Map<string, number>();
  for (const s of [...shots].sort((a, b) => a.index - b.index)) {
    for (const id of s.characterIds) {
      if (!order.includes(id)) order.push(id);
      alone.set(id, (alone.get(id) ?? 0) + 1);
    }
    for (let i = 0; i < s.characterIds.length; i++)
      for (let j = i + 1; j < s.characterIds.length; j++) {
        const [x, y] = [s.characterIds[i]!, s.characterIds[j]!];
        const key = order.indexOf(x) <= order.indexOf(y) ? `${x}|${y}` : `${y}|${x}`;
        together.set(key, (together.get(key) ?? 0) + 1);
      }
  }
  let best: [string, string] | null = null;
  let bestCount = 0;
  for (const [key, n] of together) {
    if (n > bestCount) {
      bestCount = n;
      best = key.split('|') as [string, string];
    }
  }
  if (best) return best;
  // Singles only: the two characters seen most
  const seen = order.sort((a, b) => (alone.get(b) ?? 0) - (alone.get(a) ?? 0) || 0);
  return seen.length >= 2 ? [seen[0]!, seen[1]!] : null;
}

export interface LineOfAction {
  a: string;
  b: string;
  /** The side the scene's cameras stay on. */
  side: 1 | -1;
}

function pairPoints(blocking: SceneBlocking, shotId: string, pair: [string, string]) {
  const ma = markFor(blocking, shotId, pair[0]);
  const mb = markFor(blocking, shotId, pair[1]);
  return ma && mb ? { a: v3(ma.x, 0, ma.z), b: v3(mb.x, 0, mb.z) } : null;
}

/**
 * The scene's line: its main pair, and the side of the first shot that frames them both (else the first that frames
 * either; else the side facing the front of the set).
 */
export function lineOfAction(blocking: SceneBlocking, shots: BlockingShotInput[]): LineOfAction | null {
  const pair = mainPair(shots);
  if (!pair || !actorOf(blocking, pair[0]) || !actorOf(blocking, pair[1])) return null;
  const ordered = [...shots].sort((a, b) => a.index - b.index);
  const both = ordered.filter((s) => pair.every((id) => s.characterIds.includes(id)));
  const either = ordered.filter((s) => pair.some((id) => s.characterIds.includes(id)));
  for (const s of [...both, ...either]) {
    const cam = blocking.shots[s.id]?.camera;
    const pts = pairPoints(blocking, s.id, pair);
    if (!cam || !pts) continue;
    const side = lineSide(pts.a, pts.b, v3(cam.x, 0, cam.z));
    if (side !== 0) return { a: pair[0], b: pair[1], side: side as 1 | -1 };
  }
  const pts = pairPoints(blocking, ordered[0]?.id ?? '', pair);
  const front = pts ? lineSide(pts.a, pts.b, v3((pts.a.x + pts.b.x) / 2, 0, 1000)) : 1;
  return { a: pair[0], b: pair[1], side: (front || 1) as 1 | -1 };
}

/** The lens of a shot on the desk: its own, else its framing's. */
export function shotLens(shot: Pick<BlockingShotInput, 'camera'>): number {
  return shot.camera.lensMm ?? FRAMING_LENS[shot.camera.framing];
}

/** The described camera of a shot when nobody described it: its framing's angle, eye level, no move. */
export function defaultCameraSpec(shot: BlockingShotInput): CameraSpec {
  const angle: CameraAngle =
    shot.camera.framing === 'over_shoulder' && shot.characterIds.length >= 2
      ? 'over_shoulder'
      : shot.camera.framing === 'pov' && shot.characterIds.length >= 1
        ? 'pov'
        : shot.characterIds.length === 1
          ? shot.index % 2 === 0
            ? 'three_quarter_left'
            : 'three_quarter_right'
          : 'front';
  return { subjects: [], angle, height: 'eye', move: 'none' };
}

function insideLandmark(l: BlockingLandmark, p: Vec3): boolean {
  if (l.shape === 'water') return false;
  const a = -rad(l.rotationDeg);
  const dx = p.x - l.x;
  const dz = p.z - l.z;
  const lx = dx * Math.cos(a) + dz * Math.sin(a);
  const lz = -dx * Math.sin(a) + dz * Math.cos(a);
  if (p.y > l.height) return false;
  if (l.shape === 'cylinder') return Math.hypot(lx / (l.width / 2), lz / (l.depth / 2)) <= 1;
  return Math.abs(lx) <= l.width / 2 && Math.abs(lz) <= l.depth / 2;
}

/** The landmark a camera stands inside, if any. */
export function landmarkAt(blocking: SceneBlocking, p: Vec3): BlockingLandmark | undefined {
  return blocking.set.landmarks.find((l) => insideLandmark(l, p));
}

function placement(p: Vec3, t: Vec3): CameraPlacement {
  return {
    x: round3(p.x),
    y: round3(clamp(p.y, 0.05, 200)),
    z: round3(p.z),
    targetX: round3(t.x),
    targetY: round3(clamp(t.y, -10, 200)),
    targetZ: round3(t.z),
  };
}

/** Colours of AI landmarks by what their label names, the first match winning (docs/design/director-desk.md#the-document). */
const LANDMARK_COLORS: [RegExp, string][] = [
  [/water|sea|lake|pond|river|pool|stream/, '#3f7fc0'],
  [/hay|straw|bale/, '#d8b54a'],
  [/barn/, '#b5413a'],
  [/fence|gate|rail|picket|post/, '#eceae4'],
  [/tree|bush|hedge|forest|shrub/, '#4f7a3a'],
  [/hill|grass|lawn|meadow|field|paddock|pasture/, '#7fae5a'],
  [/lane|path|road|track|gravel|trail|drive/, '#cdb58c'],
  [/sand|beach|dune/, '#d9c49a'],
  [/rock|stone|boulder|cliff|wall/, '#8d9096'],
  [/house|stable|shed|cottage|lodge|building|cabin|hut/, '#d8cbb0'],
];

/** A landmark's colour from its label, else from its shape: AI blocking names landmarks but gives no colours. */
export function landmarkColor(label: string, shape: LandmarkShape): string {
  const l = label.toLowerCase();
  for (const [re, hex] of LANDMARK_COLORS) if (re.test(l)) return hex;
  return shape === 'water' ? '#3f7fc0' : shape === 'cylinder' ? '#5e7f4a' : '#8a8f98';
}

/** Room kept beside each subject of a group (metres, for a 1.7 m figure) and the margin on the angle it needs. */
const GROUP_PAD_M = 0.25;
const GROUP_MARGIN = 1.1;

/**
 * Places a shot's camera from its description, framing and lens (docs/design/director-desk.md#the-solver). With the
 * scene's line, a camera that would stand on the other side is turned back to the scene's side.
 */
export function solveCamera(
  blocking: SceneBlocking,
  shot: BlockingShotInput,
  spec: CameraSpec,
  aspect: number,
  line?: LineOfAction | null,
): BlockingCamera {
  const framing = shot.camera.framing;
  const lensMm = clamp(Math.round(shotLens(shot)), 8, 800);
  const { tanH, tanV } = lensTangents(lensMm, aspect);
  const ids = (spec.subjects.length ? spec.subjects : shot.characterIds).filter((id) =>
    actorOf(blocking, id),
  );
  const subjects = ids.map((id) => {
    const mark = markFor(blocking, shot.id, id)!;
    return { id, mark, ...figurePoints(mark, actorOf(blocking, id)!.heightM) };
  });
  const tallest = Math.max(0.3, ...subjects.map((s) => s.height));
  const scale = clamp(tallest / 1.7, 0.3, 3);
  const linePts = line ? pairPoints(blocking, shot.id, [line.a, line.b]) : null;
  const onSide = (dir: Vec3, from: Vec3) => {
    if (!line || !linePts) return dir;
    const side = lineSide(linePts.a, linePts.b, add(from, mul(dir, 3)));
    if (side === line.side) return dir;
    const u = norm(flat(sub(linePts.b, linePts.a)));
    if (side === 0) {
      // On the line: turned about 20° towards the scene's side, so the screen sides stay as they were
      let n = turnLeft(u, 90);
      if (lineSide(linePts.a, linePts.b, add(linePts.a, n)) !== line.side) n = mul(n, -1);
      return norm(add(dir, mul(n, 0.36)));
    }
    // Reflect the direction across the line
    return norm(sub(mul(u, 2 * dot(dir, u)), dir));
  };
  const finish = (pos: Vec3, target: Vec3): BlockingCamera => {
    let p = pos;
    // Out of a landmark it would stand in, backwards along its view
    const back = norm(sub(p, target));
    for (let i = 0; i < 40 && landmarkAt(blocking, p); i++) p = add(p, mul(back, 0.5));
    const start = placement(p, target);
    return { ...start, lensMm, end: moveEnd(start, lensMm, aspect, spec.move) };
  };

  // POV: from the first subject's eyes, where they look (at the second subject when there is one)
  if (spec.angle === 'pov' && subjects[0]) {
    const s = subjects[0];
    const f = facingVector(s.mark.facingDeg);
    const eyes = add(s.eyes, mul(f, 0.12));
    const target = subjects[1] ? subjects[1].eyes : add(eyes, mul(f, 4));
    return finish(eyes, target);
  }
  // Over the shoulder: behind the first subject's shoulder on the scene's side, at the second subject
  if (spec.angle === 'over_shoulder' && subjects.length >= 2) {
    const [fg, bg] = subjects as [(typeof subjects)[0], (typeof subjects)[0]];
    const away = norm(flat(sub(fg.feet, bg.feet)));
    const side = onSide(turnLeft(away, 90), fg.feet);
    const pos = add(add(fg.feet, mul(away, 0.55 * scale)), mul(side, 0.32 * scale));
    return finish(v3(pos.x, fg.height * 0.86, pos.z), bg.eyes);
  }

  // The target: the subjects' centre at the height the framing looks at (a prop for an insert)
  let target: Vec3;
  if (!subjects.length) {
    const prop = blocking.props.find((p) => p.elementId && shot.elementIds?.includes(p.elementId));
    target = prop ? v3(prop.x, prop.size / 2, prop.z) : v3(0, 1, 0);
  } else {
    const cx = subjects.reduce((n, s) => n + s.mark.x, 0) / subjects.length;
    const cz = subjects.reduce((n, s) => n + s.mark.z, 0) / subjects.length;
    const prop =
      framing === 'insert'
        ? blocking.props.find((p) => p.elementId && shot.elementIds?.includes(p.elementId))
        : undefined;
    target = prop ? v3(prop.x, prop.size / 2, prop.z) : v3(cx, tallest * FRAMING_LOOK[framing], cz);
  }

  // The direction from the target to the camera
  let dir: Vec3;
  const angle = spec.angle === 'over_shoulder' || spec.angle === 'pov' ? 'three_quarter_left' : spec.angle;
  if (subjects.length >= 2) {
    const a = subjects[0]!.feet;
    const b = subjects[1]!.feet;
    let n = turnLeft(norm(flat(sub(b, a))), 90);
    if (line && linePts) {
      if (lineSide(linePts.a, linePts.b, add(target, mul(n, 3))) !== line.side) n = mul(n, -1);
    } else if (n.z < 0 || (Math.abs(n.z) < 1e-6 && n.x < 0)) n = mul(n, -1);
    dir = turnLeft(n, ANGLE_DEG[angle]);
  } else if (subjects.length === 1) {
    dir = onSide(turnLeft(facingVector(subjects[0]!.mark.facingDeg), ANGLE_DEG[angle]), target);
  } else {
    dir = line && linePts ? onSide(v3(0, 0, 1), target) : v3(0, 0, 1);
  }

  // The distance: the framing's coverage, and every subject of a group inside the frame's width by angle (one nearer
  // the camera than the group's centre covers a wider angle, docs/design/director-desk.md#the-solver)
  const right = norm(cross(mul(dir, -1), UP));
  const groupFit =
    subjects.length > 1
      ? Math.max(
          ...subjects.map((s) => {
            const rel = sub(s.feet, flat(target));
            return dot(rel, dir) + ((Math.abs(dot(rel, right)) + GROUP_PAD_M * scale) / tanH) * GROUP_MARGIN;
          }),
        )
      : 0;
  const coverage = FRAMING_COVERAGE[framing] * scale;
  const distance = Math.max(coverage / 2 / tanV, groupFit, 0.3);
  const eyes = subjects.length ? Math.max(...subjects.map((s) => s.eyes.y)) : 1.5;
  const head = subjects.length ? Math.max(...subjects.map((s) => s.head.y)) : 1.7;
  const y =
    spec.height === 'low'
      ? 0.4 * Math.max(0.6, scale)
      : spec.height === 'high'
        ? head + 1.2
        : spec.height === 'overhead'
          ? head + 4
          : framing === 'wide' || framing === 'extreme_wide'
            ? Math.max(eyes, 1.5)
            : Math.max(0.3, eyes);
  const rise = y - target.y;
  const along = Math.sqrt(Math.max(distance * distance - rise * rise, (0.3 * distance) ** 2));
  const pos = add(flat(target), mul(dir, along));
  return finish(v3(pos.x, y, pos.z), target);
}

/** Where a camera move ends (docs/design/director-desk.md#the-solver), or null for none. */
export function moveEnd(
  start: CameraPlacement,
  lensMm: number,
  aspect: number,
  move: CameraSpec['move'],
): CameraPlacement | null {
  if (move === 'none') return null;
  const p = v3(start.x, start.y, start.z);
  const t = v3(start.targetX, start.targetY, start.targetZ);
  const b = cameraBasis({ ...start, lensMm }, aspect);
  const toT = sub(t, p);
  switch (move) {
    case 'push_in':
      return placement(add(p, mul(toT, 0.35)), t);
    case 'pull_out':
      return placement(sub(p, mul(toT, 0.35)), t);
    case 'dolly_left':
      return placement(sub(p, mul(b.right, 1.5)), sub(t, mul(b.right, 1.5)));
    case 'dolly_right':
      return placement(add(p, mul(b.right, 1.5)), add(t, mul(b.right, 1.5)));
    case 'orbit_left':
    case 'orbit_right': {
      const v = flat(sub(p, t));
      const r = len(v);
      const k = move === 'orbit_left' ? -1 : 1;
      const turned = add(mul(v, Math.cos(rad(30))), mul(b.right, k * r * Math.sin(rad(30))));
      return placement(v3(t.x + turned.x, p.y, t.z + turned.z), t);
    }
    case 'crane_up':
      return placement(add(p, v3(0, 2, 0)), t);
  }
}

/** The move of the library a blocked camera makes (docs/design/director-desk.md#what-the-image-and-video-models-get). */
export function cameraMoveOf(cam: BlockingCamera, aspect = 16 / 9): CameraMoveId | null {
  const end = cam.end;
  if (!end) return null;
  const b = cameraBasis(cam, aspect);
  const dp = v3(end.x - cam.x, end.y - cam.y, end.z - cam.z);
  const dt = v3(end.targetX - cam.targetX, end.targetY - cam.targetY, end.targetZ - cam.targetZ);
  const lateral = dot(dp, b.right);
  const forward = dot(flat(dp), norm(flat(b.forward)));
  if (Math.abs(dp.y) > 0.3 && Math.abs(dp.y) >= Math.max(Math.abs(lateral), Math.abs(forward)))
    return dp.y > 0 ? 'crane_up' : 'crane_down';
  if (len(dt) > 0.5 * Math.max(0.01, len(dp)) && Math.abs(lateral) > Math.abs(forward))
    return lateral > 0 ? 'dolly_right' : 'dolly_left';
  if (Math.abs(lateral) > 0.2 && Math.abs(lateral) > Math.abs(forward))
    return lateral > 0 ? 'orbit_right' : 'orbit_left';
  if (Math.abs(forward) > 0.15) return forward > 0 ? 'push_in' : 'pull_out';
  return null;
}

/** Moves around the scene that may cross its line during the shot (motivated): orbits. */
const crossesByDesign = (s: BlockingShot | undefined) =>
  s?.spec?.move === 'orbit_left' || s?.spec?.move === 'orbit_right';

/** Mirrors back over the line the cameras of cuts that stand on the other side; returns how many were. */
export function enforceLine(
  blocking: SceneBlocking,
  shots: BlockingShotInput[],
): { blocking: SceneBlocking; fixed: string[] } {
  const line = lineOfAction(blocking, shots);
  if (!line) return { blocking, fixed: [] };
  const out = structuredClone(blocking);
  const fixed: string[] = [];
  for (const s of [...shots].sort((a, b) => a.index - b.index)) {
    const entry = out.shots[s.id];
    if (!entry || crossesByDesign(entry)) continue;
    if (!s.characterIds.includes(line.a) && !s.characterIds.includes(line.b)) continue;
    const pts = pairPoints(out, s.id, [line.a, line.b]);
    if (!pts) continue;
    const cam = entry.camera;
    const side = lineSide(pts.a, pts.b, v3(cam.x, 0, cam.z));
    if (side === 0 || side === line.side) continue;
    const flip = (c: CameraPlacement): CameraPlacement => {
      const p = mirror(pts.a, pts.b, v3(c.x, c.y, c.z));
      const t = mirror(pts.a, pts.b, v3(c.targetX, c.targetY, c.targetZ));
      return placement(p, t);
    };
    entry.camera = { ...cam, ...flip(cam), end: cam.end ? flip(cam.end) : null };
    fixed.push(s.id);
  }
  return { blocking: out, fixed };
}

export interface BlockingContext {
  /** The clip's shots. */
  shots: BlockingShotInput[];
  /** The characters of the scene, in cast order (the palette follows it). */
  characterIds: string[];
  /** Standing heights in metres by character id (1.7 when unknown). */
  heights?: Record<string, number>;
  /** Width over height of the project's frames. */
  aspect: number;
}

/** A character's standing height from the identity's `height` ("170 cm", "1.2 m"), else 1.7 m. */
export function heightFromIdentity(text: string | undefined): number {
  const t = (text ?? '').toLowerCase();
  const cm = /(\d{2,3}(?:\.\d+)?)\s*cm/.exec(t);
  if (cm) return clamp(Number(cm[1]) / 100, 0.3, 4);
  const m = /(\d(?:\.\d+)?)\s*m\b/.exec(t);
  if (m) return clamp(Number(m[1]), 0.3, 4);
  return 1.7;
}

/** An empty blocking for a scene: its cast in a row across the set, facing the front. */
export function emptyBlocking(ctx: BlockingContext, now = new Date().toISOString()): SceneBlocking {
  return normalizeBlocking(SceneBlockingSchema.parse({ updatedAt: now, source: 'user' }), ctx).blocking;
}

/**
 * Makes a blocking safe to render (docs/design/director-desk.md#the-solver): the scene's cast as actors (others
 * dropped), positions in the set, characters apart, a solved camera for every shot that has none, and with `line` the
 * cameras of cuts kept on the scene's side of the line.
 */
export function normalizeBlocking(
  raw: SceneBlocking,
  ctx: BlockingContext,
  opts: { line?: boolean } = {},
): { blocking: SceneBlocking; solved: string[]; fixed: string[] } {
  const b = structuredClone(raw);
  const halfW = b.set.width / 2;
  const halfD = b.set.depth / 2;
  const inSet = (x: number, z: number) => ({
    x: round3(clamp(x, -halfW, halfW)),
    z: round3(clamp(z, -halfD, halfD)),
  });
  const cast = ctx.characterIds;
  // Actors: one per character of the scene, in cast order, with the palette's colour
  const byCharacter = new Map<string, BlockingActor>();
  for (const a of b.actors)
    if (cast.includes(a.characterId) && !byCharacter.has(a.characterId)) byCharacter.set(a.characterId, a);
  b.actors = cast.map((id, i) => {
    const a = byCharacter.get(id);
    const color = BLOCKING_PALETTE[i % BLOCKING_PALETTE.length]!.color;
    const heightM = ctx.heights?.[id] ?? a?.heightM ?? 1.7;
    const spot = a ? inSet(a.x, a.z) : inSet((i - (cast.length - 1) / 2) * 1.2, 0);
    return {
      id: a?.id ?? `a${i + 1}`,
      characterId: id,
      color,
      heightM,
      x: spot.x,
      z: spot.z,
      facingDeg: a ? a.facingDeg : 0,
      pose: a?.pose ?? 'stand',
    };
  });
  // Apart: characters closer than OVERLAP_M are pushed apart along the line between them
  for (let pass = 0; pass < 4; pass++)
    for (let i = 0; i < b.actors.length; i++)
      for (let j = i + 1; j < b.actors.length; j++) {
        const p = b.actors[i]!;
        const q = b.actors[j]!;
        const d = Math.hypot(q.x - p.x, q.z - p.z);
        if (d >= OVERLAP_M) continue;
        const ux = d > 1e-6 ? (q.x - p.x) / d : 1;
        const uz = d > 1e-6 ? (q.z - p.z) / d : 0;
        const push = (OVERLAP_M - d) / 2 + 0.01;
        Object.assign(p, inSet(p.x - ux * push, p.z - uz * push));
        Object.assign(q, inSet(q.x + ux * push, q.z + uz * push));
      }
  b.props = b.props.map((p) => ({ ...p, ...inSet(p.x, p.z) }));
  b.set.landmarks = b.set.landmarks.map((l) => ({
    ...l,
    x: round3(clamp(l.x, -b.set.width * 1.5, b.set.width * 1.5)),
    z: round3(clamp(l.z, -b.set.depth * 1.5, b.set.depth * 1.5)),
  }));
  // Shots: only the clip's, marks only of their cast and inside the set
  const shotIds = new Set(ctx.shots.map((s) => s.id));
  for (const id of Object.keys(b.shots)) if (!shotIds.has(id)) delete b.shots[id];
  for (const s of ctx.shots) {
    const entry = b.shots[s.id];
    if (!entry) continue;
    const marks: BlockingShot['marks'] = {};
    for (const [cid, m] of Object.entries(entry.marks)) {
      if (!s.characterIds.includes(cid) || !cast.includes(cid)) continue;
      const spot = inSet(m.x, m.z);
      const to = m.toX !== null && m.toZ !== null ? inSet(m.toX, m.toZ) : null;
      marks[cid] = { ...m, ...spot, toX: to?.x ?? null, toZ: to?.z ?? null };
    }
    entry.marks = marks;
    entry.camera.lensMm = clamp(entry.camera.lensMm, 8, 800);
  }
  // A camera for every shot without one, in shot order so the line is set by the first
  const solved: string[] = [];
  const ordered = [...ctx.shots].sort((a, b) => a.index - b.index);
  for (const s of ordered) {
    if (b.shots[s.id]) continue;
    const spec = defaultCameraSpec(s);
    const line = lineOfAction(
      b,
      ordered.filter((x) => b.shots[x.id] || x.id === s.id),
    );
    b.shots[s.id] = { marks: {}, camera: solveCamera(b, s, spec, ctx.aspect, line), spec };
    solved.push(s.id);
  }
  if (!opts.line) return { blocking: b, solved, fixed: [] };
  const { blocking, fixed } = enforceLine(b, ctx.shots);
  return { blocking, solved, fixed };
}

/** `missing`, `incomplete` (a shot or a character of the clip has no place on the desk) or `ready`. */
export function blockingState(
  blocking: SceneBlocking | null | undefined,
  shots: BlockingShotInput[],
): 'missing' | 'incomplete' | 'ready' {
  if (!blocking) return 'missing';
  const cast = new Set(shots.flatMap((s) => s.characterIds));
  if (shots.some((s) => !blocking.shots[s.id])) return 'incomplete';
  if ([...cast].some((id) => !actorOf(blocking, id))) return 'incomplete';
  return 'ready';
}

/** The cast of a clip in order of first appearance (the desk's cast order). */
export function blockingCast(shots: Pick<BlockingShotInput, 'index' | 'characterIds'>[]): string[] {
  const out: string[] = [];
  for (const s of [...shots].sort((a, b) => a.index - b.index))
    for (const id of s.characterIds) if (!out.includes(id)) out.push(id);
  return out;
}

/** Hash of a blocking's geometry (what the prompts and the pictures are made from). */
export function blockingHash(blocking: SceneBlocking | null | undefined): string {
  if (!blocking) return '';
  const { updatedAt: _u, source: _s, ...geometry } = blocking;
  return fnv1a32(JSON.stringify(geometry)).toString(16);
}

export interface LaidOutCharacter {
  characterId: string;
  name: string;
  /** In the picture: x to the right, y up, in [-1, 1]. */
  x: number;
  y: number;
  depth: number;
  inFrame: boolean;
  third: 'left' | 'centre' | 'right';
  depthLabel: 'foreground' | 'background' | null;
  facing: 'camera' | 'away' | 'left' | 'right' | 'camera_left' | 'camera_right';
  /** Where a character who moves during the shot ends up. */
  to: { third: 'left' | 'centre' | 'right'; toward: 'camera' | 'away' | null } | null;
  /** Out of frame but at its edge in the foreground (an over-the-shoulder shot's shoulder). */
  edge: 'left' | 'right' | null;
}

export interface ShotLayout {
  characters: LaidOutCharacter[];
  /** Labels of landmarks in the picture behind the subjects, nearest first. */
  behind: string[];
  light: 'behind' | 'ahead' | 'left' | 'right';
  /** With `behind`: the side it comes from too. */
  lightSide: 'left' | 'right' | null;
  interior: boolean;
}

const thirdOf = (x: number): LaidOutCharacter['third'] =>
  x < -0.33 ? 'left' : x > 0.33 ? 'right' : 'centre';

/** Where everyone of a shot is in its camera's picture (docs/design/director-desk.md#what-the-image-and-video-models-get). */
export function shotLayout(
  blocking: SceneBlocking,
  shot: BlockingShotInput,
  names: Record<string, string>,
  aspect: number,
): ShotLayout | null {
  const entry = blocking.shots[shot.id];
  if (!entry) return null;
  const basis = cameraBasis(entry.camera, aspect);
  const laid: LaidOutCharacter[] = [];
  for (const id of shot.characterIds) {
    const actor = actorOf(blocking, id);
    const mark = markFor(blocking, shot.id, id);
    if (!actor || !mark) continue;
    const pts = figurePoints(mark, actor.heightM);
    // The head in a close shot, the body in a wider one: whichever of them the picture shows
    const chest = projectPoint(basis, pts.chest);
    const eyes = projectPoint(basis, pts.eyes);
    const p = inPicture(chest, 1.05) || !inPicture(eyes, 1.05) ? chest : eyes;
    const toCam = norm(flat(sub(basis.pos, pts.feet)));
    const f = facingVector(mark.facingDeg);
    const c = dot(f, toCam);
    const side = dot(f, basis.right) >= 0 ? 'right' : 'left';
    const facing: LaidOutCharacter['facing'] =
      c > Math.cos(rad(35))
        ? 'camera'
        : c < -Math.cos(rad(35))
          ? 'away'
          : c > Math.cos(rad(70))
            ? side === 'right'
              ? 'camera_right'
              : 'camera_left'
            : side;
    let to: LaidOutCharacter['to'] = null;
    if (mark.toX !== null && mark.toZ !== null) {
      const end = projectPoint(
        basis,
        figurePoints({ ...mark, x: mark.toX, z: mark.toZ }, actor.heightM).chest,
      );
      const dd = Number.isFinite(end.x) ? end.depth - p.depth : 0;
      to = {
        third: Number.isFinite(end.x) ? thirdOf(end.x) : thirdOf(p.x),
        toward: Math.abs(dd) > 0.8 ? (dd < 0 ? 'camera' : 'away') : null,
      };
    }
    laid.push({
      characterId: id,
      name: names[id] ?? 'Someone',
      x: p.x,
      y: p.y,
      depth: p.depth,
      inFrame: inPicture(p, 1.05),
      third: Number.isFinite(p.x) ? thirdOf(p.x) : 'centre',
      depthLabel: null,
      facing,
      to,
      edge: null,
    });
  }
  const visible = laid.filter((c) => c.inFrame);
  const nearest = Math.min(Number.POSITIVE_INFINITY, ...visible.map((c) => c.depth));
  for (const c of laid)
    if (!c.inFrame && Number.isFinite(c.x) && Math.abs(c.x) < 1.9 && c.depth < 0.7 * nearest)
      c.edge = c.x < 0 ? 'left' : 'right';
  if (visible.length >= 2) {
    const depths = visible.map((c) => c.depth).sort((a, b) => a - b);
    const median = depths[Math.floor(depths.length / 2)]!;
    for (const c of visible)
      c.depthLabel = c.depth < 0.72 * median ? 'foreground' : c.depth > 1.4 * median ? 'background' : null;
  }
  const far = Math.max(0, ...visible.map((c) => c.depth));
  const behind = blocking.set.landmarks
    .map((l) => ({ l, p: projectPoint(basis, v3(l.x, Math.min(l.height, 2) / 2, l.z)) }))
    .filter(({ l, p }) => l.label && inPicture(p, 1.1) && p.depth > far + 0.5)
    .sort((a, b) => a.p.depth - b.p.depth)
    .slice(0, 3)
    .map(({ l }) => l.label);
  const s = norm(flat(sunVector(blocking.set.sun)));
  const fwd = norm(flat(basis.forward));
  const ahead = dot(fwd, s);
  const lateral = dot(basis.right, s);
  const light: ShotLayout['light'] =
    ahead > 0.5 ? 'ahead' : ahead < -0.5 ? 'behind' : lateral >= 0 ? 'right' : 'left';
  return {
    characters: laid,
    behind,
    light,
    lightSide: light === 'behind' && Math.abs(lateral) > 0.3 ? (lateral > 0 ? 'right' : 'left') : null,
    interior: blocking.set.interior,
  };
}

const WHERE: Record<LaidOutCharacter['third'], string> = {
  left: 'left of frame',
  centre: 'in the centre',
  right: 'right of frame',
};
const FACING: Record<LaidOutCharacter['facing'], string> = {
  camera: 'facing the camera',
  away: 'with their back to the camera',
  left: 'facing left',
  right: 'facing right',
  camera_left: 'turned three-quarters to the left',
  camera_right: 'turned three-quarters to the right',
};

function listOf(items: string[]): string {
  return items.length < 3 ? items.join(' and ') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}

/**
 * The blocking line of a keyframe prompt: where everyone stands and faces, what is behind them and where the light
 * comes from (docs/design/director-desk.md#what-the-image-and-video-models-get). Null without characters in frame and
 * landmarks behind.
 */
export function blockingLine(layout: ShotLayout | null): string | null {
  if (!layout) return null;
  const parts: string[] = [];
  const people = layout.characters.filter((c) => c.inFrame);
  const said = people.map(
    (c) =>
      `${c.name} is ${WHERE[c.third]}${c.depthLabel ? ` in the ${c.depthLabel}` : ''}, ${FACING[c.facing]}`,
  );
  const edges = layout.characters
    .filter((c) => c.edge)
    .map((c) => `${c.name}'s shoulder in the ${c.edge} foreground`);
  if (said.length) parts.push(`Blocking: ${said.join('; ')}${edges.length ? `, ${listOf(edges)}` : ''}.`);
  if (layout.behind.length)
    parts.push(`Behind ${people.length ? 'them' : 'the frame'}: ${listOf(layout.behind)}.`);
  const source = layout.interior ? 'the key light' : 'the sun';
  const light =
    layout.light === 'behind'
      ? `${source} is behind the camera${layout.lightSide ? `, on the ${layout.lightSide}` : ''}`
      : layout.light === 'ahead'
        ? `${source} is ahead of the camera, behind the scene`
        : `${source} comes from the ${layout.light}`;
  if (!parts.length) return null;
  parts.push(`Light: ${light}.`);
  return parts.join(' ');
}

/** The moves of a shot's characters for its video prompt: `Rosie walks from left of frame to the centre.` */
export function blockingMoves(layout: ShotLayout | null): string | null {
  if (!layout) return null;
  const moves = layout.characters
    .filter((c) => c.inFrame && c.to)
    .map((c) => {
      const to = c.to!;
      if (to.toward) return `${c.name} walks ${to.toward === 'camera' ? 'towards' : 'away from'} the camera.`;
      if (to.third === c.third) return null;
      return `${c.name} walks from ${WHERE[c.third]} to ${to.third === 'centre' ? 'the centre' : WHERE[to.third]}.`;
    })
    .filter((m): m is string => !!m);
  return moves.length ? moves.join(' ') : null;
}

/** The figures of a shot's camera view, named by colour for the image model: `orange figure = Rosie`. */
export function figureLegend(
  blocking: SceneBlocking,
  shot: BlockingShotInput,
  names: Record<string, string>,
): string {
  return shot.characterIds
    .map((id) => actorOf(blocking, id))
    .filter((a): a is BlockingActor => !!a)
    .map((a) => `${colorName(a.color)} figure = ${names[a.characterId] ?? 'someone'}`)
    .join(', ');
}

/** What breaks the scene on the desk (docs/design/director-desk.md#checks). */
export function blockingIssues(
  blocking: SceneBlocking,
  shots: BlockingShotInput[],
  names: Record<string, string>,
  aspect: number,
): BlockingIssue[] {
  const issues: BlockingIssue[] = [];
  const name = (id: string) => names[id] ?? 'A character';
  const label = (s: BlockingShotInput) => `shot ${s.index + 1}`;
  const ordered = [...shots].sort((a, b) => a.index - b.index);
  const line = lineOfAction(blocking, ordered);
  const halfW = blocking.set.width / 2 + 0.01;
  const halfD = blocking.set.depth / 2 + 0.01;
  for (const s of ordered) {
    const entry = blocking.shots[s.id];
    if (!entry) continue;
    const cam = entry.camera;
    const basis = cameraBasis(cam, aspect);
    if (
      line &&
      !crossesByDesign(entry) &&
      (s.characterIds.includes(line.a) || s.characterIds.includes(line.b))
    ) {
      const pts = pairPoints(blocking, s.id, [line.a, line.b]);
      const side = pts ? lineSide(pts.a, pts.b, v3(cam.x, 0, cam.z)) : 0;
      if (side !== 0 && side !== line.side)
        issues.push({
          code: 'line_crossed',
          severity: 'error',
          shotId: s.id,
          characterId: null,
          message: `The camera of ${label(s)} crossed the line between ${name(line.a)} and ${name(line.b)}: they swap sides on the cut`,
        });
    }
    // Over the shoulder, the first subject is the shoulder at the edge of the frame
    const shoulder =
      entry.spec?.angle === 'over_shoulder' ? (entry.spec.subjects[0] ?? s.characterIds[0]) : null;
    for (const id of s.characterIds) {
      const actor = actorOf(blocking, id);
      const mark = markFor(blocking, s.id, id);
      if (!actor || !mark || id === shoulder) continue;
      const p = projectPoint(basis, figurePoints(mark, actor.heightM).eyes);
      if (!(Number.isFinite(p.x) && Math.abs(p.x) <= 1 && p.y >= -1 && p.y <= 1.15))
        issues.push({
          code: 'subject_out_of_frame',
          severity: 'error',
          shotId: s.id,
          characterId: id,
          message: `${name(id)} is not in the frame of ${label(s)}`,
        });
      if (Math.abs(mark.x) > halfW || Math.abs(mark.z) > halfD)
        issues.push({
          code: 'outside_set',
          severity: 'warning',
          shotId: s.id,
          characterId: id,
          message: `${name(id)} stands outside the set in ${label(s)}`,
        });
    }
    const inside = landmarkAt(blocking, v3(cam.x, cam.y, cam.z));
    if (inside)
      issues.push({
        code: 'camera_inside',
        severity: 'error',
        shotId: s.id,
        characterId: null,
        message: `The camera of ${label(s)} stands inside ${inside.label || 'a landmark'}`,
      });
    for (const actor of blocking.actors) {
      if (s.characterIds.includes(actor.characterId)) continue;
      const mark = markFor(blocking, s.id, actor.characterId)!;
      const p = projectPoint(basis, figurePoints(mark, actor.heightM).chest);
      if (inPicture(p, 0.9))
        issues.push({
          code: 'absent_in_frame',
          severity: 'warning',
          shotId: s.id,
          characterId: actor.characterId,
          message: `${name(actor.characterId)} is not in ${label(s)} but stands in its frame`,
        });
    }
    const here = s.characterIds
      .map((id) => ({ id, m: markFor(blocking, s.id, id) }))
      .filter((x): x is { id: string; m: BlockingMark } => !!x.m);
    for (let i = 0; i < here.length; i++)
      for (let j = i + 1; j < here.length; j++)
        if (Math.hypot(here[i]!.m.x - here[j]!.m.x, here[i]!.m.z - here[j]!.m.z) < OVERLAP_M)
          issues.push({
            code: 'actors_overlap',
            severity: 'warning',
            shotId: s.id,
            characterId: here[i]!.id,
            message: `${name(here[i]!.id)} and ${name(here[j]!.id)} stand in the same place in ${label(s)}`,
          });
  }
  // Screen direction: a character crossing the frame one way, then the other way on the next cut
  for (let i = 1; i < ordered.length; i++) {
    const prev = ordered[i - 1]!;
    const s = ordered[i]!;
    if (s.continuity === 'continuous') continue;
    for (const id of s.characterIds.filter((c) => prev.characterIds.includes(c))) {
      const dir = (shot: BlockingShotInput) => {
        const entry = blocking.shots[shot.id];
        const mark = markFor(blocking, shot.id, id);
        const actor = actorOf(blocking, id);
        if (!entry || !mark || !actor || mark.toX === null || mark.toZ === null) return 0;
        const basis = cameraBasis(entry.camera, aspect);
        const a = projectPoint(basis, figurePoints(mark, actor.heightM).chest);
        const b = projectPoint(
          basis,
          figurePoints({ ...mark, x: mark.toX, z: mark.toZ }, actor.heightM).chest,
        );
        return Number.isFinite(a.x) && Number.isFinite(b.x) && Math.abs(b.x - a.x) > 0.15
          ? Math.sign(b.x - a.x)
          : 0;
      };
      const a = dir(prev);
      const b = dir(s);
      if (a !== 0 && b !== 0 && a !== b)
        issues.push({
          code: 'screen_direction',
          severity: 'warning',
          shotId: s.id,
          characterId: id,
          message: `${name(id)} crosses the frame the other way in ${label(s)} than in ${label(prev)}`,
        });
    }
  }
  return issues;
}

/** The camera views a blocking draws: each shot's characters only (a mannequin in a picture is a person in the frame). */
export function shotActors(blocking: SceneBlocking, shot: Pick<BlockingShotInput, 'id' | 'characterIds'>) {
  return shot.characterIds.flatMap((id) => {
    const actor = actorOf(blocking, id);
    const mark = markFor(blocking, shot.id, id);
    return actor && mark ? [{ actor, mark }] : [];
  });
}
