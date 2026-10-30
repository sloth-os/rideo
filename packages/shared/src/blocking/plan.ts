import type { SceneBlocking } from '../schemas/blocking';
import { SceneBlockingSchema } from '../schemas/blocking';
import type { SceneBlockOutput } from '../schemas/llm';
import {
  type BlockingContext,
  defaultCameraSpec,
  landmarkColor,
  lineOfAction,
  normalizeBlocking,
  solveCamera,
} from './index';

/**
 * The text model's floor plan as a blocking (docs/design/director-desk.md#jobs): names become ids, every described
 * camera is placed by the solver in shot order (so the first shot that frames the main pair sets the line), and the
 * whole is normalized with the line kept.
 */
export function blockingFromPlan(
  out: SceneBlockOutput,
  ctx: BlockingContext & {
    /** The scene's cast with their names. */
    cast: { id: string; name: string }[];
    /** The scene's places and props with their names. */
    elements?: { id: string; name: string; kind: string }[];
  },
  now = new Date().toISOString(),
): { blocking: SceneBlocking; solved: string[]; fixed: string[] } {
  const idOf = (name: string | undefined) => {
    const n = (name ?? '').trim().toLowerCase();
    return (
      ctx.cast.find((c) => c.name.toLowerCase() === n)?.id ??
      ctx.cast.find((c) => n && c.name.toLowerCase().startsWith(n))?.id
    );
  };
  const elementOf = (name: string, kinds: string[]) => {
    const n = name.trim().toLowerCase();
    return (
      ctx.elements?.find(
        (e) => kinds.includes(e.kind) && (e.name.toLowerCase() === n || n.includes(e.name.toLowerCase())),
      )?.id ?? null
    );
  };
  const raw = SceneBlockingSchema.parse({
    updatedAt: now,
    source: 'ai',
    set: {
      width: out.set.width,
      depth: out.set.depth,
      ground: out.set.ground || 'ground',
      interior: out.set.interior,
      sun: out.set.sun,
      landmarks: out.set.landmarks.map((l, i) => ({
        id: `l${i + 1}`,
        label: l.label,
        shape: l.shape,
        x: l.x,
        z: l.z,
        width: l.width,
        depth: l.depth,
        height: l.height,
        rotationDeg: l.rotationDeg,
        color: landmarkColor(l.label, l.shape),
        elementId: elementOf(l.label, ['location', 'prop']),
      })),
    },
    actors: out.actors.flatMap((a, i) => {
      const characterId = idOf(a.name);
      return characterId
        ? [
            {
              id: `a${i + 1}`,
              characterId,
              color: '#8a8f98',
              x: a.x,
              z: a.z,
              facingDeg: a.facingDeg,
              pose: a.pose,
            },
          ]
        : [];
    }),
    props: out.props.map((p, i) => ({
      id: `p${i + 1}`,
      elementId: elementOf(p.name, ['prop']),
      label: p.name,
      x: p.x,
      z: p.z,
      size: p.size,
      heldBy: idOf(p.heldBy) ?? null,
    })),
  });
  // Actors and marks first (the solver frames the marks), then every camera in shot order
  let b: SceneBlocking = normalizeBlocking(raw, { ...ctx, shots: [] }).blocking;
  const ordered = [...ctx.shots].sort((a, c) => a.index - c.index);
  const plans = new Map(out.shots.map((s) => [s.index, s]));
  const solved: string[] = [];
  for (const s of ordered) {
    const plan = plans.get(s.index);
    const marks: SceneBlocking['shots'][string]['marks'] = {};
    for (const m of plan?.marks ?? []) {
      const id = idOf(m.name);
      if (!id || !s.characterIds.includes(id)) continue;
      marks[id] = {
        x: m.x,
        z: m.z,
        facingDeg: m.facingDeg,
        pose: m.pose,
        toX: m.toX ?? null,
        toZ: m.toZ ?? null,
      };
    }
    const subjects = (plan?.camera.subjects ?? []).map((n) => idOf(n)).filter((id): id is string => !!id);
    const spec = plan
      ? { subjects, angle: plan.camera.angle, height: plan.camera.height, move: plan.camera.move }
      : defaultCameraSpec(s);
    // The side of the line is set by the shots already placed; the camera frames this shot's marks
    const line = solved.length ? lineOfAction(b, ordered) : null;
    const placeholder = { x: 0, y: 1.5, z: 10, targetX: 0, targetY: 1, targetZ: 0, lensMm: 35, end: null };
    const withMarks = { ...b, shots: { ...b.shots, [s.id]: { marks, camera: placeholder, spec } } };
    const camera = solveCamera(withMarks, s, spec, ctx.aspect, line);
    b = { ...b, shots: { ...b.shots, [s.id]: { marks, camera, spec } } };
    solved.push(s.id);
  }
  const norm = normalizeBlocking(b, ctx, { line: true });
  return { blocking: norm.blocking, solved, fixed: norm.fixed };
}
