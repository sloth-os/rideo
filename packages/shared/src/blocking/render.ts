import type { BlockingActor, BlockingMark, BlockingPose, SceneBlocking } from '../schemas/blocking';
import {
  type BlockingShotInput,
  cameraBasis,
  facingVector,
  markFor,
  shotActors,
  sunVector,
  type Vec3,
} from './index';

/**
 * The camera view of a shot (docs/design/director-desk.md#what-the-image-and-video-models-get): flat-shaded mannequins
 * in their colours, the set, its landmarks and props, lit from the sun, through the shot's camera. A small software
 * rasterizer (z-buffer, near-plane clipping), so the server and the browser draw the same pixels.
 */

export interface RgbaImage {
  width: number;
  height: number;
  /** RGBA, row by row from the top. */
  data: Uint8ClampedArray<ArrayBuffer>;
}

type Rgb = [number, number, number];

interface Tri {
  a: Vec3;
  b: Vec3;
  c: Vec3;
  n: Vec3;
  color: Rgb;
  /** Drawn only from the side its normal faces (the walls of a room: the fourth wall disappears). */
  cull?: boolean;
  unlit?: boolean;
}

const v3 = (x: number, y: number, z: number): Vec3 => ({ x, y, z });
const add = (a: Vec3, b: Vec3): Vec3 => v3(a.x + b.x, a.y + b.y, a.z + b.z);
const sub = (a: Vec3, b: Vec3): Vec3 => v3(a.x - b.x, a.y - b.y, a.z - b.z);
const mul = (a: Vec3, k: number): Vec3 => v3(a.x * k, a.y * k, a.z * k);
const dot = (a: Vec3, b: Vec3) => a.x * b.x + a.y * b.y + a.z * b.z;
const cross = (a: Vec3, b: Vec3): Vec3 =>
  v3(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
const norm = (a: Vec3): Vec3 => {
  const l = Math.hypot(a.x, a.y, a.z);
  return l > 1e-9 ? mul(a, 1 / l) : v3(0, 1, 0);
};
const UP = v3(0, 1, 0);
const rad = (deg: number) => (deg * Math.PI) / 180;

export function hexColor(hex: string): Rgb {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  const n = m ? Number.parseInt(m[1]!, 16) : 0x8a8f98;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const shade = (c: Rgb, k: number): Rgb => [c[0] * k, c[1] * k, c[2] * k];

/** The ground's colour from its word (sand, snow, grass, …). */
export function groundColor(ground: string, interior: boolean): Rgb {
  const g = ground.toLowerCase();
  const table: [RegExp, string][] = [
    [/snow/, '#eef2f6'],
    [/ice/, '#d6ecf5'],
    [/sand|beach|dune/, '#d9c49a'],
    [/grass|lawn|meadow|field|park/, '#7fae5a'],
    [/water|sea|lake|pool/, '#4f8fc9'],
    [/wood|plank|deck|parquet/, '#a07850'],
    [/carpet|rug/, '#8a6f6a'],
    [/dirt|soil|mud|earth|trail|path/, '#8b6b4a'],
    [/stone|rock|concrete|asphalt|road|street|tile|pavement|marble/, '#8d9096'],
  ];
  for (const [re, hex] of table) if (re.test(g)) return hexColor(hex);
  return hexColor(interior ? '#9c968c' : '#a3a7ad');
}

function quad(tris: Tri[], p: Vec3[], n: Vec3, color: Rgb, extra: Partial<Tri> = {}) {
  tris.push({ a: p[0]!, b: p[1]!, c: p[2]!, n, color, ...extra });
  tris.push({ a: p[0]!, b: p[2]!, c: p[3]!, n, color, ...extra });
}

/** A box from its centre, half sizes along its own axes, and the axes. */
function box(tris: Tri[], c: Vec3, axes: [Vec3, Vec3, Vec3], half: [number, number, number], color: Rgb) {
  const [ax, ay, az] = axes;
  const corner = (sx: number, sy: number, sz: number) =>
    add(add(add(c, mul(ax, sx * half[0])), mul(ay, sy * half[1])), mul(az, sz * half[2]));
  const faces: [Vec3, [number, number, number][]][] = [
    [
      ax,
      [
        [1, -1, -1],
        [1, 1, -1],
        [1, 1, 1],
        [1, -1, 1],
      ],
    ],
    [
      mul(ax, -1),
      [
        [-1, -1, 1],
        [-1, 1, 1],
        [-1, 1, -1],
        [-1, -1, -1],
      ],
    ],
    [
      ay,
      [
        [-1, 1, -1],
        [-1, 1, 1],
        [1, 1, 1],
        [1, 1, -1],
      ],
    ],
    [
      mul(ay, -1),
      [
        [-1, -1, 1],
        [-1, -1, -1],
        [1, -1, -1],
        [1, -1, 1],
      ],
    ],
    [
      az,
      [
        [-1, -1, 1],
        [1, -1, 1],
        [1, 1, 1],
        [-1, 1, 1],
      ],
    ],
    [
      mul(az, -1),
      [
        [1, -1, -1],
        [-1, -1, -1],
        [-1, 1, -1],
        [1, 1, -1],
      ],
    ],
  ];
  for (const [n, pts] of faces)
    quad(
      tris,
      pts.map(([x, y, z]) => corner(x, y, z)),
      n,
      color,
      { cull: true },
    );
}

/** A box along a segment (a limb). */
function segment(tris: Tri[], p0: Vec3, p1: Vec3, thickness: number, color: Rgb) {
  const axis = sub(p1, p0);
  const length = Math.hypot(axis.x, axis.y, axis.z);
  if (length < 1e-6) return;
  const u = mul(axis, 1 / length);
  const ref = Math.abs(u.y) < 0.9 ? UP : v3(1, 0, 0);
  const a = norm(cross(u, ref));
  const b = cross(a, u);
  box(tris, mul(add(p0, p1), 0.5), [a, u, b], [thickness / 2, length / 2, thickness / 2], color);
}

function cylinder(tris: Tri[], base: Vec3, rx: number, rz: number, height: number, color: Rgb, rotDeg = 0) {
  const n = 14;
  const r = rad(rotDeg);
  const at = (i: number, y: number) => {
    const t = (i / n) * Math.PI * 2;
    const lx = Math.cos(t) * rx;
    const lz = Math.sin(t) * rz;
    return v3(base.x + lx * Math.cos(r) + lz * Math.sin(r), y, base.z - lx * Math.sin(r) + lz * Math.cos(r));
  };
  for (let i = 0; i < n; i++) {
    const p0 = at(i, base.y);
    const p1 = at(i + 1, base.y);
    const q1 = at(i + 1, base.y + height);
    const q0 = at(i, base.y + height);
    const mid = mul(add(p0, p1), 0.5);
    const outward = norm(v3(mid.x - base.x, 0, mid.z - base.z));
    quad(tris, [p0, p1, q1, q0], outward, color, { cull: true });
    tris.push({ a: v3(base.x, base.y + height, base.z), b: q0, c: q1, n: UP, color, cull: true });
  }
}

function sphere(tris: Tri[], c: Vec3, r: number, color: Rgb) {
  const lat = 6;
  const lon = 10;
  const at = (i: number, j: number) => {
    const t = (i / lat) * Math.PI;
    const p = (j / lon) * Math.PI * 2;
    return v3(
      c.x + r * Math.sin(t) * Math.cos(p),
      c.y + r * Math.cos(t),
      c.z + r * Math.sin(t) * Math.sin(p),
    );
  };
  for (let i = 0; i < lat; i++)
    for (let j = 0; j < lon; j++) {
      const p = [at(i, j), at(i + 1, j), at(i + 1, j + 1), at(i, j + 1)];
      const mid = mul(add(add(p[0]!, p[1]!), add(p[2]!, p[3]!)), 0.25);
      quad(tris, p, norm(sub(mid, c)), color, { cull: true });
    }
}

interface PoseParams {
  hip: [number, number];
  knee: [number, number];
  arm: [number, number];
  armOut: [number, number];
  elbow: [number, number];
  lean: number;
  seat?: boolean;
}

/** Joint angles in degrees, [left, right]: hips forward, knees bend back, arms forward and out, elbows bend. */
const POSES: Record<BlockingPose, PoseParams> = {
  stand: { hip: [0, 0], knee: [0, 0], arm: [0, 0], armOut: [8, 8], elbow: [8, 8], lean: 0 },
  walk: { hip: [24, -20], knee: [6, 24], arm: [-20, 22], armOut: [6, 6], elbow: [15, 15], lean: 3 },
  run: { hip: [48, -30], knee: [25, 80], arm: [-45, 50], armOut: [8, 8], elbow: [85, 85], lean: 14 },
  sit: { hip: [90, 90], knee: [90, 90], arm: [25, 25], armOut: [8, 8], elbow: [45, 45], lean: 2, seat: true },
  crouch: { hip: [75, 75], knee: [140, 140], arm: [35, 35], armOut: [12, 12], elbow: [40, 40], lean: 32 },
  kneel: { hip: [0, 90], knee: [90, 90], arm: [10, 10], armOut: [8, 8], elbow: [20, 20], lean: 4 },
  lie: { hip: [0, 0], knee: [0, 0], arm: [0, 0], armOut: [12, 12], elbow: [5, 5], lean: 0 },
  reach: { hip: [0, 0], knee: [0, 0], arm: [0, 85], armOut: [8, 4], elbow: [8, 5], lean: 6 },
  point: { hip: [0, 0], knee: [0, 0], arm: [0, 80], armOut: [8, 18], elbow: [8, 0], lean: 0 },
  wave: { hip: [0, 0], knee: [0, 0], arm: [0, 160], armOut: [8, 25], elbow: [8, 30], lean: 0 },
};

/** A mannequin on its mark: legs, torso, arms, a head with a light visor where its face is. */
function mannequin(tris: Tri[], actor: BlockingActor, mark: BlockingMark, color: Rgb) {
  const h = actor.heightM;
  const pose = POSES[mark.pose];
  const f = facingVector(mark.facingDeg);
  const right = mul(cross(UP, f), -1);
  // Local (x right, y up, z forward) to the floor around the mark; a lying figure has its head behind its mark
  const lying = mark.pose === 'lie';
  const origin = v3(mark.x, 0, mark.z);
  const world = (p: Vec3): Vec3 =>
    lying
      ? add(add(add(origin, mul(right, p.x)), mul(f, -p.y + h / 2)), mul(UP, p.z + 0.07 * h))
      : add(add(add(origin, mul(right, p.x)), mul(UP, p.y)), mul(f, p.z));
  const dir = (pitch: number) => v3(0, -Math.cos(rad(pitch)), Math.sin(rad(pitch)));
  const thigh = 0.245 * h;
  const shin = 0.245 * h;
  const legs = [-1, 1].map((side, i) => {
    const hipJoint = v3(side * 0.075 * h, 0, 0);
    const knee = add(hipJoint, mul(dir(pose.hip[i]!), thigh));
    const foot = add(knee, mul(dir(pose.hip[i]! - pose.knee[i]!), shin));
    return { hipJoint, knee, foot };
  });
  // Grounded: the lowest foot or knee on the floor
  const lowest = Math.min(...legs.flatMap((l) => [l.knee.y, l.foot.y]));
  const pelvis = -lowest + 0.025 * h;
  const lift = (p: Vec3) => v3(p.x, p.y + pelvis, p.z);
  const legColor = shade(color, 0.78);
  for (const l of legs) {
    segment(tris, world(lift(l.hipJoint)), world(lift(l.knee)), 0.09 * h, legColor);
    segment(tris, world(lift(l.knee)), world(lift(l.foot)), 0.075 * h, legColor);
  }
  if (pose.seat) {
    const seatH = pelvis - 0.03 * h;
    box(
      tris,
      world(v3(0, seatH / 2, -0.04 * h)),
      [right, UP, f],
      [0.16 * h, seatH / 2, 0.14 * h],
      [120, 124, 132],
    );
  }
  const lean = rad(pose.lean);
  const spine = v3(0, Math.cos(lean), Math.sin(lean));
  const hipC = v3(0, pelvis, 0);
  const neck = add(hipC, mul(spine, 0.3 * h));
  const torsoC = mul(add(hipC, neck), 0.5);
  const spineW = norm(sub(world(neck), world(hipC)));
  const across = norm(sub(world(v3(1, pelvis, 0)), world(v3(0, pelvis, 0))));
  const front = norm(cross(across, spineW));
  box(tris, world(torsoC), [across, spineW, mul(front, -1)], [0.125 * h, 0.155 * h, 0.065 * h], color);
  const headC = add(neck, mul(spine, 0.085 * h));
  sphere(tris, world(headC), 0.068 * h, color);
  // The visor: where the face looks
  const faceAt = add(headC, v3(0, 0.005 * h, 0.06 * h));
  box(
    tris,
    world(faceAt),
    [across, spineW, mul(front, -1)],
    [0.045 * h, 0.018 * h, 0.012 * h],
    [245, 245, 240],
  );
  for (const [i, side] of [-1, 1].entries()) {
    const shoulder = add(neck, add(v3(side * 0.15 * h, 0, 0), mul(spine, -0.035 * h)));
    const out = rad(pose.armOut[i]!) * side;
    const pitch = rad(pose.arm[i]!);
    const upper = v3(Math.sin(out) * Math.cos(pitch), -Math.cos(out) * Math.cos(pitch), Math.sin(pitch));
    const elbow = add(shoulder, mul(norm(upper), 0.17 * h));
    const pitch2 = rad(pose.arm[i]! + pose.elbow[i]!);
    const lower = v3(Math.sin(out) * Math.cos(pitch2), -Math.cos(out) * Math.cos(pitch2), Math.sin(pitch2));
    const hand = add(elbow, mul(norm(lower), 0.16 * h));
    segment(tris, world(shoulder), world(elbow), 0.062 * h, color);
    segment(tris, world(elbow), world(hand), 0.055 * h, color);
  }
}

/** Where a held prop is: at the holder's right hand. */
function heldAt(blocking: SceneBlocking, shotId: string, characterId: string): Vec3 | null {
  const actor = blocking.actors.find((a) => a.characterId === characterId);
  const mark = markFor(blocking, shotId, characterId);
  if (!actor || !mark) return null;
  const f = facingVector(mark.facingDeg);
  const right = mul(cross(UP, f), -1);
  return add(
    add(v3(mark.x, 0.5 * actor.heightM, mark.z), mul(f, 0.22 * actor.heightM)),
    mul(right, 0.17 * actor.heightM),
  );
}

/** The scene as triangles: the ground, the set, its landmarks and props, and the shot's characters. */
export function blockingTriangles(
  blocking: SceneBlocking,
  shot: Pick<BlockingShotInput, 'id' | 'characterIds'>,
) {
  const tris: Tri[] = [];
  const set = blocking.set;
  const ground = groundColor(set.ground, set.interior);
  // The world beyond the set, then the set's tiles
  const far = Math.max(set.width, set.depth) * 6 + 60;
  quad(
    tris,
    [v3(-far, -0.02, -far), v3(-far, -0.02, far), v3(far, -0.02, far), v3(far, -0.02, -far)],
    UP,
    shade(ground, 0.86),
  );
  const tile = Math.max(set.width, set.depth) > 30 ? 2 : 1;
  const nx = Math.ceil(set.width / tile);
  const nz = Math.ceil(set.depth / tile);
  for (let i = 0; i < nx; i++)
    for (let j = 0; j < nz; j++) {
      const x0 = -set.width / 2 + i * tile;
      const z0 = -set.depth / 2 + j * tile;
      const x1 = Math.min(set.width / 2, x0 + tile);
      const z1 = Math.min(set.depth / 2, z0 + tile);
      quad(
        tris,
        [v3(x0, 0, z0), v3(x0, 0, z1), v3(x1, 0, z1), v3(x1, 0, z0)],
        UP,
        shade(ground, (i + j) % 2 ? 0.93 : 1),
      );
    }
  if (set.interior) {
    const wall: Rgb = [201, 198, 191];
    const w = set.width / 2;
    const d = set.depth / 2;
    const hgt = 3.2;
    // Walls seen from inside only: the camera outside a wall sees through it
    quad(tris, [v3(-w, 0, -d), v3(w, 0, -d), v3(w, hgt, -d), v3(-w, hgt, -d)], v3(0, 0, 1), wall, {
      cull: true,
    });
    quad(tris, [v3(w, 0, d), v3(-w, 0, d), v3(-w, hgt, d), v3(w, hgt, d)], v3(0, 0, -1), wall, {
      cull: true,
    });
    quad(
      tris,
      [v3(-w, 0, d), v3(-w, 0, -d), v3(-w, hgt, -d), v3(-w, hgt, d)],
      v3(1, 0, 0),
      shade(wall, 0.95),
      { cull: true },
    );
    quad(tris, [v3(w, 0, -d), v3(w, 0, d), v3(w, hgt, d), v3(w, hgt, -d)], v3(-1, 0, 0), shade(wall, 0.95), {
      cull: true,
    });
  }
  for (const l of set.landmarks) {
    const color = hexColor(l.color);
    const r = rad(l.rotationDeg);
    const ax = v3(Math.cos(r), 0, -Math.sin(r));
    const az = v3(Math.sin(r), 0, Math.cos(r));
    if (l.shape === 'cylinder')
      cylinder(tris, v3(l.x, 0, l.z), l.width / 2, l.depth / 2, l.height, color, l.rotationDeg);
    else if (l.shape === 'water')
      box(
        tris,
        v3(l.x, Math.max(0.02, l.height) / 2, l.z),
        [ax, UP, az],
        [l.width / 2, Math.max(0.02, l.height) / 2, l.depth / 2],
        color,
      );
    else box(tris, v3(l.x, l.height / 2, l.z), [ax, UP, az], [l.width / 2, l.height / 2, l.depth / 2], color);
  }
  for (const p of blocking.props) {
    const at = p.heldBy && shot.characterIds.includes(p.heldBy) ? heldAt(blocking, shot.id, p.heldBy) : null;
    if (p.heldBy && !at) continue;
    const c = at ?? v3(p.x, p.size / 2, p.z);
    box(tris, c, [v3(1, 0, 0), UP, v3(0, 0, 1)], [p.size / 2, p.size / 2, p.size / 2], hexColor(p.color));
  }
  for (const { actor, mark } of shotActors(blocking, shot))
    mannequin(tris, actor, mark, hexColor(actor.color));
  return tris;
}

/**
 * Draws a shot's camera view, at the start of the shot (or where its camera move ends). Only the shot's characters
 * are drawn: a mannequin in the picture is a person in the frame.
 */
export function renderShotView(
  blocking: SceneBlocking,
  shot: Pick<BlockingShotInput, 'id' | 'characterIds'>,
  size: { width: number; height: number },
  opts: { at?: 'start' | 'end' } = {},
): RgbaImage {
  const width = Math.max(16, Math.round(size.width));
  const height = Math.max(16, Math.round(size.height));
  const data = new Uint8ClampedArray(width * height * 4);
  const entry = blocking.shots[shot.id];
  const set = blocking.set;
  // The sky (or the room's darkness)
  const top: Rgb = set.interior ? [58, 61, 68] : [126, 176, 226];
  const bottom: Rgb = set.interior ? [92, 96, 104] : [222, 236, 248];
  for (let y = 0; y < height; y++) {
    const t = y / Math.max(1, height - 1);
    const r = top[0] + (bottom[0] - top[0]) * t;
    const g = top[1] + (bottom[1] - top[1]) * t;
    const b = top[2] + (bottom[2] - top[2]) * t;
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = 255;
    }
  }
  if (!entry) return { width, height, data };
  const cam = opts.at === 'end' && entry.camera.end ? { ...entry.camera, ...entry.camera.end } : entry.camera;
  const basis = cameraBasis(cam, width / height);
  const sun = sunVector(set.sun);
  const ambient = set.interior ? 0.62 : 0.5;
  const diffuse = 1 - ambient;
  const depthBuf = new Float32Array(width * height);
  const near = 0.05;
  const toCam = (p: Vec3) => {
    const d = sub(p, basis.pos);
    return v3(dot(d, basis.right), dot(d, basis.up), dot(d, basis.forward));
  };
  const haze: Rgb = bottom;
  for (const t of blockingTriangles(blocking, shot)) {
    // A face turned away from the camera is not seen (closed shapes, and the walls of a room from outside)
    if (t.cull && dot(t.n, sub(basis.pos, t.a)) <= 0) continue;
    let poly = [toCam(t.a), toCam(t.b), toCam(t.c)];
    if (poly.every((p) => p.z < near)) continue;
    // Clipped at the near plane
    if (poly.some((p) => p.z < near)) {
      const out: Vec3[] = [];
      for (let i = 0; i < poly.length; i++) {
        const p = poly[i]!;
        const q = poly[(i + 1) % poly.length]!;
        if (p.z >= near) out.push(p);
        if (p.z >= near !== q.z >= near) {
          const k = (near - p.z) / (q.z - p.z);
          out.push(v3(p.x + (q.x - p.x) * k, p.y + (q.y - p.y) * k, near));
        }
      }
      poly = out;
    }
    if (poly.length < 3) continue;
    const light = t.unlit ? 1 : ambient + diffuse * Math.max(0, dot(t.n, sun));
    const meanZ = poly.reduce((n, p) => n + p.z, 0) / poly.length;
    const fog = set.interior ? 0 : Math.min(0.55, meanZ / 450);
    const color: Rgb = [
      Math.min(255, t.color[0] * light) * (1 - fog) + haze[0] * fog,
      Math.min(255, t.color[1] * light) * (1 - fog) + haze[1] * fog,
      Math.min(255, t.color[2] * light) * (1 - fog) + haze[2] * fog,
    ];
    const screen = poly.map((p) => ({
      x: ((p.x / (p.z * basis.tanH) + 1) / 2) * width,
      y: ((1 - p.y / (p.z * basis.tanV)) / 2) * height,
      w: 1 / p.z,
    }));
    for (let k = 1; k + 1 < screen.length; k++) raster(screen[0]!, screen[k]!, screen[k + 1]!, color);
  }
  return { width, height, data };

  function raster(a: { x: number; y: number; w: number }, b: typeof a, c: typeof a, color: Rgb) {
    const area = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
    if (Math.abs(area) < 1e-9) return;
    const minX = Math.max(0, Math.floor(Math.min(a.x, b.x, c.x)));
    const maxX = Math.min(width - 1, Math.ceil(Math.max(a.x, b.x, c.x)));
    const minY = Math.max(0, Math.floor(Math.min(a.y, b.y, c.y)));
    const maxY = Math.min(height - 1, Math.ceil(Math.max(a.y, b.y, c.y)));
    if (minX > maxX || minY > maxY) return;
    const inv = 1 / area;
    for (let y = minY; y <= maxY; y++) {
      const py = y + 0.5;
      for (let x = minX; x <= maxX; x++) {
        const px = x + 0.5;
        const w0 = ((b.x - px) * (c.y - py) - (b.y - py) * (c.x - px)) * inv;
        const w1 = ((c.x - px) * (a.y - py) - (c.y - py) * (a.x - px)) * inv;
        const w2 = 1 - w0 - w1;
        if (w0 < 0 || w1 < 0 || w2 < 0) continue;
        const w = w0 * a.w + w1 * b.w + w2 * c.w;
        const i = y * width + x;
        if (w <= depthBuf[i]!) continue;
        depthBuf[i] = w;
        data[i * 4] = color[0];
        data[i * 4 + 1] = color[1];
        data[i * 4 + 2] = color[2];
        data[i * 4 + 3] = 255;
      }
    }
  }
}
