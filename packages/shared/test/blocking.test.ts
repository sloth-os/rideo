import { describe, expect, it } from 'vitest';
import {
  type BlockingShotInput,
  blockingFromPlan,
  blockingHash,
  blockingIssues,
  blockingLine,
  blockingMoves,
  blockingShotOf,
  blockingState,
  blockingView,
  boardPromptHash,
  cameraBasis,
  cameraMoveOf,
  compileShotPrompt,
  emptyBlocking,
  enforceLine,
  facingOf,
  figureLegend,
  figurePoints,
  heightFromIdentity,
  lineOfAction,
  mainPair,
  markFor,
  moveEnd,
  normalizeBlocking,
  ProjectSettingsSchema,
  projectPoint,
  renderShotView,
  type SceneBlocking,
  SceneBlockingSchema,
  SceneBlockOutputSchema,
  shotContextOf,
  shotLayout,
} from '../src';
import * as f from '../src/testing/fixtures';
import { fnv1a32 } from '../src/util/hash';

const at = '2026-10-29T00:00:00.000Z';
const ROSIE = 'chr_0000000000aaaaaa';
const SAMMY = 'chr_0000000000bbbbbb';
const names = { [ROSIE]: 'Rosie', [SAMMY]: 'Sammy' };
const ASPECT = 16 / 9;

const shot = (
  index: number,
  characterIds: string[],
  framing: BlockingShotInput['camera']['framing'],
): BlockingShotInput => ({
  id: `sht_00000000000${index}aaaa`,
  index,
  characterIds,
  camera: { framing },
  continuity: 'cut',
});

const SHOTS = [
  shot(0, [ROSIE, SAMMY], 'wide'),
  shot(1, [ROSIE], 'close_up'),
  shot(2, [SAMMY], 'medium'),
  shot(3, [ROSIE, SAMMY], 'over_shoulder'),
];

/** Rosie on the left facing Sammy on the right, the sea behind them. */
function beach(): SceneBlocking {
  return SceneBlockingSchema.parse({
    updatedAt: at,
    source: 'ai',
    set: {
      width: 14,
      depth: 10,
      ground: 'sand',
      sun: { azimuthDeg: 210, elevationDeg: 35 },
      landmarks: [
        { id: 'sea', label: 'the sea', shape: 'water', x: 0, z: -8, width: 40, depth: 6, height: 0.05 },
        { id: 'hut', label: 'a beach hut', shape: 'box', x: 5, z: -3, width: 2, depth: 2, height: 2.6 },
      ],
    },
    actors: [
      { id: 'a1', characterId: ROSIE, color: '#ff8a3d', x: -0.9, z: 0, facingDeg: 90, heightM: 1.2 },
      { id: 'a2', characterId: SAMMY, color: '#3d8bff', x: 0.9, z: 0, facingDeg: 270, heightM: 1.25 },
    ],
  });
}

const ctx = { shots: SHOTS, characterIds: [ROSIE, SAMMY], aspect: ASPECT };
const solved = () => normalizeBlocking(beach(), ctx, { line: true }).blocking;

function inFrame(b: SceneBlocking, shotId: string, characterId: string) {
  const actor = b.actors.find((a) => a.characterId === characterId)!;
  const p = projectPoint(
    cameraBasis(b.shots[shotId]!.camera, ASPECT),
    figurePoints(markFor(b, shotId, characterId)!, actor.heightM).eyes,
  );
  return Number.isFinite(p.x) && Math.abs(p.x) <= 1 && Math.abs(p.y) <= 1;
}

describe('the camera solver (docs/design/director-desk.md#the-solver)', () => {
  it('frames the shot by its framing and lens, from the front side of the line', () => {
    const b = solved();
    const wide = b.shots[SHOTS[0]!.id]!.camera;
    expect(wide.lensMm).toBe(24);
    expect(wide.z).toBeGreaterThan(0);
    expect(inFrame(b, SHOTS[0]!.id, ROSIE) && inFrame(b, SHOTS[0]!.id, SAMMY)).toBe(true);
    // The close-up looks at Rosie's eyes, at 85 mm, much closer than the wide shot
    const close = b.shots[SHOTS[1]!.id]!.camera;
    expect(close.lensMm).toBe(85);
    expect(Math.hypot(close.x - close.targetX, close.z - close.targetZ)).toBeLessThan(
      Math.hypot(wide.x - wide.targetX, wide.z - wide.targetZ),
    );
    expect(close.targetY).toBeCloseTo(1.2 * 0.92, 2);
    expect(inFrame(b, SHOTS[1]!.id, ROSIE)).toBe(true);
  });

  it('keeps every camera on the side of the line the first two-shot sets', () => {
    const b = solved();
    const line = lineOfAction(b, SHOTS)!;
    expect(line).toMatchObject({ a: ROSIE, b: SAMMY });
    for (const s of SHOTS) expect(b.shots[s.id]!.camera.z).toBeGreaterThan(-0.05);
    expect(blockingIssues(b, SHOTS, names, ASPECT)).toEqual([]);
  });

  it('places an over-the-shoulder camera behind the first subject, at the second', () => {
    const b = solved();
    const ots = b.shots[SHOTS[3]!.id]!.camera;
    expect(ots.x).toBeLessThan(-0.9);
    expect(ots.targetX).toBeCloseTo(0.9, 2);
    const layout = shotLayout(b, SHOTS[3]!, names, ASPECT)!;
    expect(blockingLine(layout)).toContain("Rosie's shoulder in the left foreground");
  });

  it('places the end of a camera move and names it', () => {
    const b = solved();
    const cam = b.shots[SHOTS[0]!.id]!.camera;
    for (const move of [
      'push_in',
      'pull_out',
      'dolly_left',
      'dolly_right',
      'orbit_left',
      'orbit_right',
      'crane_up',
    ] as const) {
      const end = moveEnd(cam, cam.lensMm, ASPECT, move);
      expect(cameraMoveOf({ ...cam, end }, ASPECT)).toBe(move);
    }
    expect(cameraMoveOf({ ...cam, end: null }, ASPECT)).toBeNull();
  });
});

describe('the 180° rule', () => {
  it('mirrors back a cut whose camera crossed the line, and reports it before', () => {
    const b = solved();
    const crossed = structuredClone(b);
    const c = crossed.shots[SHOTS[2]!.id]!.camera;
    Object.assign(c, { z: -c.z, targetZ: -c.targetZ });
    expect(blockingIssues(crossed, SHOTS, names, ASPECT).map((i) => i.code)).toContain('line_crossed');
    const { blocking, fixed } = enforceLine(crossed, SHOTS);
    expect(fixed).toEqual([SHOTS[2]!.id]);
    expect(blocking.shots[SHOTS[2]!.id]!.camera.z).toBeCloseTo(b.shots[SHOTS[2]!.id]!.camera.z, 3);
    expect(blockingIssues(blocking, SHOTS, names, ASPECT).map((i) => i.code)).not.toContain('line_crossed');
  });

  it('keeps an orbit, which crosses the line by design', () => {
    const b = solved();
    const orbit = structuredClone(b);
    const entry = orbit.shots[SHOTS[2]!.id]!;
    entry.spec = { subjects: [], angle: 'front', height: 'eye', move: 'orbit_left' };
    Object.assign(entry.camera, { z: -entry.camera.z, targetZ: -entry.camera.targetZ });
    expect(enforceLine(orbit, SHOTS).fixed).toEqual([]);
  });

  it('finds the main pair: the two who share the most shots', () => {
    expect(mainPair(SHOTS)).toEqual([ROSIE, SAMMY]);
    expect(mainPair([shot(0, [ROSIE], 'close_up')])).toBeNull();
  });
});

describe('the blocking line (docs/design/director-desk.md#what-the-image-and-video-models-get)', () => {
  it('says where everyone stands and faces, what is behind them and where the light comes from', () => {
    const b = solved();
    expect(blockingLine(shotLayout(b, SHOTS[0]!, names, ASPECT))).toBe(
      'Blocking: Rosie is left of frame, facing right; Sammy is right of frame, facing left. Behind them: a beach hut and the sea. Light: the sun is ahead of the camera, behind the scene.',
    );
  });

  it('says who walks where in the video prompt', () => {
    const b = solved();
    b.shots[SHOTS[0]!.id]!.marks[ROSIE] = { x: -2.5, z: 0, facingDeg: 90, pose: 'walk', toX: 0, toZ: 0 };
    expect(blockingMoves(shotLayout(b, SHOTS[0]!, names, ASPECT))).toBe(
      'Rosie walks from left of frame to the centre.',
    );
  });

  it('names the camera view’s figures by colour', () => {
    expect(figureLegend(solved(), SHOTS[0]!, names)).toBe('orange figure = Rosie, blue figure = Sammy');
  });
});

describe('normalization', () => {
  it('casts the scene, keeps marks in the set and characters apart, and solves missing cameras', () => {
    const raw = SceneBlockingSchema.parse({
      updatedAt: at,
      set: { width: 6, depth: 6 },
      actors: [
        { id: 'x', characterId: 'chr_0000000000zzzzzz', color: '#000000', x: 0, z: 0 },
        { id: 'a1', characterId: ROSIE, color: '#000000', x: 40, z: 0 },
        { id: 'a2', characterId: SAMMY, color: '#000000', x: 3, z: 0.05 },
      ],
    });
    const { blocking, solved: cams } = normalizeBlocking(raw, ctx);
    expect(blocking.actors.map((a) => a.characterId)).toEqual([ROSIE, SAMMY]);
    expect(blocking.actors.map((a) => a.color)).toEqual(['#ff8a3d', '#3d8bff']);
    const [r, s] = blocking.actors;
    expect(Math.abs(r!.x)).toBeLessThanOrEqual(3);
    expect(Math.hypot(r!.x - s!.x, r!.z - s!.z)).toBeGreaterThanOrEqual(0.35);
    expect(cams).toHaveLength(SHOTS.length);
    expect(blockingState(blocking, SHOTS)).toBe('ready');
    expect(blockingState(null, SHOTS)).toBe('missing');
    const { shots: _drop, ...rest } = blocking;
    expect(blockingState({ ...rest, shots: {} }, SHOTS)).toBe('incomplete');
  });

  it('starts an empty scene with its cast in a row facing the front', () => {
    const b = emptyBlocking(ctx, at);
    expect(b.actors.map((a) => [a.characterId, a.facingDeg])).toEqual([
      [ROSIE, 0],
      [SAMMY, 0],
    ]);
    expect(Object.keys(b.shots)).toHaveLength(SHOTS.length);
  });

  it('hashes the geometry, not who saved it when', () => {
    const b = solved();
    expect(blockingHash({ ...b, updatedAt: '2030-01-01T00:00:00.000Z', source: 'user' })).toBe(
      blockingHash(b),
    );
    expect(blockingHash({ ...b, set: { ...b.set, width: 15 } })).not.toBe(blockingHash(b));
  });

  it('reads heights from identities', () => {
    expect(heightFromIdentity('170 cm')).toBe(1.7);
    expect(heightFromIdentity('about 1.2 m tall')).toBe(1.2);
    expect(heightFromIdentity('tall')).toBe(1.7);
    expect(facingOf({ x: 1, z: 0 })).toBe(90);
  });
});

describe('the AI floor plan (blockingFromPlan)', () => {
  it('turns names into ids and solves each described camera, bringing back one across the line', () => {
    const out = SceneBlockOutputSchema.parse({
      set: {
        width: 12,
        depth: 10,
        ground: 'sand',
        landmarks: [{ label: 'the sea', shape: 'water', x: 0, z: -7, width: 30, depth: 4, height: 0.05 }],
      },
      actors: [
        { name: 'Rosie', x: -1, z: 0, facingDeg: 90 },
        { name: 'sammy', x: 1, z: 0, facingDeg: 270 },
        { name: 'Nobody', x: 0, z: 3 },
      ],
      shots: [
        { index: 0, camera: { subjects: ['Rosie', 'Sammy'], angle: 'front' } },
        { index: 1, camera: { subjects: ['Rosie'], angle: 'three_quarter_left' } },
        { index: 2, camera: { subjects: ['Sammy'], angle: 'back' } },
      ],
    });
    const shots = SHOTS.slice(0, 3);
    const { blocking } = blockingFromPlan(
      out,
      {
        shots,
        characterIds: [ROSIE, SAMMY],
        aspect: ASPECT,
        cast: [
          { id: ROSIE, name: 'Rosie' },
          { id: SAMMY, name: 'Sammy' },
        ],
      },
      at,
    );
    expect(blocking.actors.map((a) => a.characterId)).toEqual([ROSIE, SAMMY]);
    expect(blocking.set.landmarks[0]).toMatchObject({ label: 'the sea', shape: 'water' });
    for (const s of shots) expect(blocking.shots[s.id]!.camera.z).toBeGreaterThan(0);
    expect(blockingIssues(blocking, shots, names, ASPECT).filter((i) => i.code === 'line_crossed')).toEqual(
      [],
    );
  });
});

describe('checks', () => {
  it('reports a character out of frame, a camera in a wall and someone in a frame not theirs', () => {
    const b = solved();
    const away = structuredClone(b);
    const c = away.shots[SHOTS[1]!.id]!.camera;
    Object.assign(c, { targetX: c.x + (c.x - c.targetX), targetZ: c.z + (c.z - c.targetZ) });
    expect(blockingIssues(away, SHOTS, names, ASPECT).map((i) => i.code)).toContain('subject_out_of_frame');
    const wall = structuredClone(b);
    wall.set.landmarks.push({
      id: 'w',
      label: 'the wall',
      shape: 'wall',
      x: wall.shots[SHOTS[0]!.id]!.camera.x,
      z: wall.shots[SHOTS[0]!.id]!.camera.z,
      width: 2,
      depth: 2,
      height: 3,
      rotationDeg: 0,
      color: '#888888',
      elementId: null,
    });
    expect(blockingIssues(wall, SHOTS, names, ASPECT).map((i) => i.code)).toContain('camera_inside');
    // A single of Rosie whose wide lens shows Sammy too
    const wideSingle = shot(1, [ROSIE], 'wide');
    const extra = normalizeBlocking(beach(), { ...ctx, shots: [SHOTS[0]!, wideSingle] }).blocking;
    expect(blockingIssues(extra, [SHOTS[0]!, wideSingle], names, ASPECT).map((i) => i.code)).toContain(
      'absent_in_frame',
    );
  });
});

describe('the camera view (renderShotView)', () => {
  it('draws the same pixels for the same blocking, the shot’s figures in their colours', () => {
    const b = solved();
    const a = renderShotView(b, SHOTS[0]!, { width: 160, height: 90 });
    const again = renderShotView(b, SHOTS[0]!, { width: 160, height: 90 });
    expect(a.data.length).toBe(160 * 90 * 4);
    expect(fnv1a32(Buffer.from(a.data).toString('base64'))).toBe(
      fnv1a32(Buffer.from(again.data).toString('base64')),
    );
    // Orange (Rosie) shows on the left half, blue (Sammy) on the right
    const share = (pred: (r: number, g: number, b: number) => boolean, x0: number, x1: number) => {
      let n = 0;
      for (let y = 0; y < 90; y++)
        for (let x = x0; x < x1; x++) {
          const i = (y * 160 + x) * 4;
          if (pred(a.data[i]!, a.data[i + 1]!, a.data[i + 2]!)) n++;
        }
      return n;
    };
    const orange = (r: number, g: number, bl: number) => r > 1.6 * bl && r > g * 1.3 && r > 60;
    const blue = (r: number, g: number, bl: number) => bl > 1.5 * r && bl > g && bl > 60 && r < 120;
    expect(share(orange, 0, 80)).toBeGreaterThan(share(orange, 80, 160));
    expect(share(blue, 80, 160)).toBeGreaterThan(share(blue, 0, 80));
    // Only the shot's characters: the close-up of Rosie draws no blue figure
    const close = renderShotView(b, SHOTS[1]!, { width: 160, height: 90 });
    let blues = 0;
    for (let i = 0; i < close.data.length; i += 4)
      if (blue(close.data[i]!, close.data[i + 1]!, close.data[i + 2]!) && close.data[i + 2]! > 150) blues++;
    expect(blues).toBeLessThan(20);
  });
});

describe('prompts with a blocking (prompt version 2)', () => {
  it('adds the blocking line to the keyframe and the camera view to its references, and outdates frames when it moves', () => {
    const rosie = f.character({ id: ROSIE, name: 'Rosie' });
    const sammy = f.character({ id: SAMMY, name: 'Sammy' });
    const s0 = f.shot({
      id: SHOTS[0]!.id,
      index: 0,
      characterIds: [ROSIE, SAMMY],
      camera: { framing: 'wide', movement: 'static' },
    });
    const clip = f.clip({
      shots: [s0],
      blocking: normalizeBlocking(beach(), {
        shots: [blockingShotOf(s0)],
        characterIds: [ROSIE, SAMMY],
        aspect: ASPECT,
      }).blocking,
    });
    const settings = ProjectSettingsSchema.parse({
      generation: { promptVersion: 2 },
      blocking: { enabled: true },
    });
    const docs = f.docs({
      project: f.project({ settings }),
      characters: { [ROSIE]: rosie, [SAMMY]: sammy },
      clips: { [clip.id]: clip },
    });
    const sctx = shotContextOf(s0, docs, clip);
    expect(sctx.blocking?.line).toContain('Rosie is left of frame');
    const prompt = compileShotPrompt({ ...sctx, blockingImage: true }, 'keyframe');
    expect(prompt).toContain('Blocking: Rosie is left of frame');
    expect(prompt).toContain('never the mannequins');
    // The camera view does not change the board's hash; the blocking does
    const hash = boardPromptHash(sctx);
    expect(boardPromptHash({ ...sctx, blockingImage: true })).toBe(hash);
    const moved = structuredClone(clip);
    moved.blocking!.actors[0]!.x = 1.5;
    moved.blocking!.actors[1]!.x = -1.5;
    const flipped = shotContextOf(s0, { ...docs, clips: { [clip.id]: moved } }, moved);
    expect(boardPromptHash(flipped)).not.toBe(hash);
    // A small move of the shot's camera keeps the words but changes the camera view: outdated too
    const nudged = structuredClone(clip);
    nudged.blocking!.shots[s0.id]!.camera.y += 0.05;
    expect(shotContextOf(s0, { ...docs, clips: { [clip.id]: nudged } }, nudged).blocking?.line).toBe(
      sctx.blocking?.line,
    );
    expect(boardPromptHash(shotContextOf(s0, { ...docs, clips: { [clip.id]: nudged } }, nudged))).not.toBe(
      hash,
    );
    // Off for the project: no blocking in the prompts
    const off = shotContextOf(
      s0,
      {
        ...docs,
        project: f.project({ settings: ProjectSettingsSchema.parse({ generation: { promptVersion: 2 } }) }),
      },
      clip,
    );
    expect(off.blocking).toBeNull();
    expect(blockingView(docs, clip).state).toBe('ready');
  });
});
