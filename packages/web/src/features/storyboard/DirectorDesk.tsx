import {
  BLOCKING_MOVES,
  BLOCKING_POSES,
  type BlockingMark,
  type BlockingMove,
  type BlockingPose,
  type BlockingShotInput,
  blockingContextFor,
  blockingHash,
  blockingView,
  type Clip,
  cameraBasis,
  defaultCameraSpec,
  facingOf,
  facingVector,
  figurePoints,
  isTerminalJob,
  lensTangents,
  lineOfAction,
  markFor,
  moveEnd,
  projectPoint,
  renderShotView,
  type SceneBlocking,
  solveCamera,
} from '@rideo/shared';
import { Bot, Camera, Check, RefreshCw, Save, Users, Wand2, X } from 'lucide-react';
import { type PointerEvent as ReactPointerEvent, useEffect, useMemo, useRef, useState } from 'react';
import { Badge, Button, Card, cx, Field, Input, PRESSED, Select } from '../../components/ui';
import { api } from '../../lib/api';
import { useProject } from '../../store/project';
import { reportError, useUi } from '../../store/ui';

/**
 * The 3D director's desk (docs/design/director-desk.md#the-desk): the scene's floor plan (the director's view) with its
 * characters, props, landmarks and a camera per shot to drag and turn, the selected shot's camera view (the picture the
 * image model gets), an inspector, and the checks.
 */

type Selection =
  | { kind: 'actor'; id: string }
  | { kind: 'camera'; id: string }
  | { kind: 'prop'; id: string }
  | { kind: 'landmark'; id: string }
  | { kind: 'set' };

type Drag =
  | { kind: 'actor'; id: string }
  | { kind: 'facing'; id: string }
  | { kind: 'camera'; id: string }
  | { kind: 'aim'; id: string }
  | { kind: 'prop'; id: string };

const snap = (n: number) => Math.round(n * 20) / 20;
const POSE_LABEL: Record<BlockingPose, string> = {
  stand: 'Standing',
  walk: 'Walking',
  run: 'Running',
  sit: 'Sitting',
  crouch: 'Crouching',
  kneel: 'Kneeling',
  lie: 'Lying',
  reach: 'Reaching',
  point: 'Pointing',
  wave: 'Waving',
};
const MOVE_LABEL: Record<BlockingMove, string> = {
  none: 'Holds',
  push_in: 'Push in',
  pull_out: 'Pull out',
  dolly_left: 'Dolly left',
  dolly_right: 'Dolly right',
  orbit_left: 'Orbit left',
  orbit_right: 'Orbit right',
  crane_up: 'Crane up',
};

/** The move a camera's end makes, from the moves the desk offers. */
function moveOf(blocking: SceneBlocking, shotId: string): BlockingMove {
  return blocking.shots[shotId]?.spec?.move ?? 'none';
}

export function DirectorDesk({ clip, onClose }: { clip: Clip; onClose: () => void }) {
  const { docs, projectId, jobs } = useProject();
  const shots = useMemo(() => [...clip.shots].sort((a, b) => a.index - b.index), [clip.shots]);
  const ctx = useMemo(() => (docs ? blockingContextFor(docs, clip) : null), [docs, clip]);
  const stored = useMemo(() => (docs ? blockingView(docs, clip) : null), [docs, clip]);
  const [draft, setDraft] = useState<SceneBlocking | null>(stored?.draft ?? null);
  const [dirty, setDirty] = useState(false);
  const [shotId, setShotId] = useState(shots[0]?.id ?? '');
  const [selected, setSelected] = useState<Selection | null>(null);
  const [allShots, setAllShots] = useState(false);
  const [busy, setBusy] = useState<'save' | 'fix' | 'ai' | 'redraw' | null>(null);
  // A blocking saved elsewhere (the AI, another person) replaces an unedited draft
  const storedHash = blockingHash(clip.blocking);
  useEffect(() => {
    if (!dirty && stored) setDraft(stored.draft);
  }, [storedHash, shots.length]);
  if (!docs || !projectId || !ctx || !draft || !stored) return null;
  const names = Object.fromEntries(Object.values(docs.characters).map((c) => [c.id, c.name]));
  const view = blockingView(docs, clip, draft);
  const shot = shots.find((s) => s.id === shotId) ?? shots[0];
  const input = ctx.shots.find((s) => s.id === shot?.id);
  const blocking = Object.values(jobs).find(
    (j) => !isTerminalJob(j) && j.kind === 'scene.block' && j.params.clipId === clip.id,
  );

  const edit = (fn: (b: SceneBlocking) => void) => {
    const next = structuredClone(draft);
    fn(next);
    setDraft(next);
    setDirty(true);
  };
  /** The mark to edit: the shot's own (created from the opening mark), or the opening mark with All shots. */
  const editMark = (b: SceneBlocking, characterId: string, fn: (m: BlockingMark) => void) => {
    const actor = b.actors.find((a) => a.characterId === characterId);
    if (!actor) return;
    const inShot = !!input?.characterIds.includes(characterId);
    if (allShots || !inShot || !shot) {
      const m = {
        x: actor.x,
        z: actor.z,
        facingDeg: actor.facingDeg,
        pose: actor.pose,
        toX: null,
        toZ: null,
      };
      fn(m);
      Object.assign(actor, { x: m.x, z: m.z, facingDeg: m.facingDeg, pose: m.pose });
      return;
    }
    const entry = b.shots[shot.id];
    if (!entry) return;
    const m = structuredClone(markFor(b, shot.id, characterId)!);
    fn(m);
    entry.marks[characterId] = m;
  };
  const save = async (fix: boolean) => {
    setBusy(fix ? 'fix' : 'save');
    try {
      const v = await api.setBlocking(projectId, clip.id, draft, fix);
      setDraft(v.draft);
      setDirty(false);
      useUi
        .getState()
        .toast(
          v.issues.length ? `Blocking saved · ${v.issues.length} issue(s) to look at` : 'Blocking saved',
          v.issues.length ? 'info' : 'success',
        );
    } catch (err) {
      reportError(err);
    } finally {
      setBusy(null);
    }
  };
  const run = async (what: 'ai' | 'redraw') => {
    setBusy(what);
    try {
      if (what === 'ai') {
        await api.generateBlocking(projectId, clip.id);
        setDirty(false);
      } else if (clip.sceneId) {
        const staged = docs.screenplay?.scenes
          .slice()
          .sort((a, b) => a.index - b.index)
          .slice(0, docs.project.settings.storyboard.scenes)
          .some((s) => s.id === clip.sceneId);
        if (staged) await api.generateStoryboard(projectId, [clip.sceneId]);
        else await api.storyboardClip(projectId, clip.id);
        useUi.getState().toast('Drawing the frames the blocking changed', 'success');
      }
    } catch (err) {
      reportError(err);
    } finally {
      setBusy(null);
    }
  };
  const autoCamera = () => {
    if (!input || !shot) return;
    edit((b) => {
      const spec = b.shots[shot.id]?.spec ?? defaultCameraSpec(input);
      const others = ctx.shots.filter((s) => s.id !== shot.id);
      const line = lineOfAction(b, others.length ? others : ctx.shots);
      const marks = b.shots[shot.id]?.marks ?? {};
      b.shots[shot.id] = { marks, camera: solveCamera(b, input, spec, ctx.aspect, line), spec };
    });
  };
  const camera = shot ? draft.shots[shot.id]?.camera : undefined;
  const selectedActor =
    selected?.kind === 'actor' ? draft.actors.find((a) => a.characterId === selected.id) : undefined;
  const selectedMark =
    selectedActor && shot ? markFor(draft, allShots ? '' : shot.id, selectedActor.characterId) : null;
  const shotIssues = (id: string) => view.issues.filter((i) => i.shotId === id).length;

  return (
    <Card className="space-y-3 p-3 sm:p-4" data-testid="director-desk" data-dirty={dirty ? 'true' : 'false'}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <h3 className="flex items-center gap-1.5 text-[15px] font-semibold">
            <Camera className="size-4" /> Director's desk · scene {clip.index + 1}
          </h3>
          <p className="text-[12px] text-muted" data-testid="desk-state">
            {stored.state === 'missing'
              ? 'Not blocked yet: place the cast and the cameras, or block it with AI.'
              : `${stored.blocking?.source === 'ai' ? 'Blocked by the AI' : 'Blocked by hand'}${dirty ? ' · unsaved changes' : ''}`}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            icon={<Bot className="size-3.5" />}
            loading={busy === 'ai' || !!blocking}
            disabled={!!busy || !!blocking}
            onClick={() => run('ai')}
            data-testid="desk-ai"
          >
            Block with AI
          </Button>
          <Button
            size="sm"
            icon={<Wand2 className="size-3.5" />}
            loading={busy === 'fix'}
            disabled={!!busy}
            onClick={() => save(true)}
            data-testid="desk-fix"
          >
            Fix the blocking
          </Button>
          <Button
            size="sm"
            variant="primary"
            icon={<Save className="size-3.5" />}
            loading={busy === 'save'}
            disabled={!!busy || !dirty}
            onClick={() => save(false)}
            data-testid="desk-save"
          >
            Save
          </Button>
          <Button
            size="sm"
            icon={<RefreshCw className="size-3.5" />}
            loading={busy === 'redraw'}
            disabled={!!busy || dirty || !clip.blocking}
            onClick={() => run('redraw')}
            data-testid="desk-redraw"
          >
            Redraw frames
          </Button>
          <Button
            size="sm"
            variant="ghost"
            icon={<X className="size-3.5" />}
            onClick={onClose}
            data-testid="desk-close"
          >
            Close
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Shots" data-testid="desk-shots">
        {shots.map((s) => (
          <button
            key={s.id}
            type="button"
            role="tab"
            aria-selected={s.id === shot?.id}
            className={cx(
              'rounded-[var(--radius-control)] border border-border px-2 py-1 text-[12px]',
              s.id === shot?.id && PRESSED,
            )}
            onClick={() => {
              setShotId(s.id);
              setSelected({ kind: 'camera', id: s.id });
            }}
            data-testid={`desk-shot-${s.index + 1}`}
          >
            S{s.index + 1} · {s.camera.framing.replace(/_/g, ' ')}
            {shotIssues(s.id) ? <span className="ml-1 text-danger">●</span> : null}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <Plan
          draft={draft}
          ctx={ctx}
          names={names}
          shotId={shot?.id ?? ''}
          selected={selected}
          onSelect={setSelected}
          onShot={setShotId}
          edit={edit}
          editMark={editMark}
        />
        <div className="min-w-0 space-y-2">
          {input ? <CameraView draft={draft} shot={input} aspect={ctx.aspect} names={names} /> : null}
          <p className="text-[12px] break-words text-muted" data-testid="desk-blocking-line">
            {(shot && view.lines[shot.id]) || 'Nobody of the shot is in its frame.'}
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <section className="min-w-0 space-y-2" aria-label="Characters" data-testid="desk-inspector">
          <div className="flex flex-wrap items-center gap-2">
            <h4 className="flex items-center gap-1 text-[13px] font-medium">
              <Users className="size-3.5" /> {selectedActor ? names[selectedActor.characterId] : 'Characters'}
            </h4>
            <button
              type="button"
              className={cx('rounded border border-border px-2 py-0.5 text-[11px]', allShots && PRESSED)}
              onClick={() => setAllShots((v) => !v)}
              aria-pressed={allShots}
              data-testid="desk-mode"
            >
              {allShots ? 'All shots (opening marks)' : 'This shot'}
            </button>
          </div>
          {selectedActor && selectedMark ? (
            <div className="grid grid-cols-2 gap-2">
              <Field label="Pose" className="col-span-2">
                <Select
                  value={selectedMark.pose}
                  onChange={(e) =>
                    edit((b) =>
                      editMark(b, selectedActor.characterId, (m) => {
                        m.pose = e.target.value as BlockingPose;
                      }),
                    )
                  }
                  data-testid="desk-pose"
                >
                  {BLOCKING_POSES.map((p) => (
                    <option key={p} value={p}>
                      {POSE_LABEL[p]}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field
                label={`Facing ${Math.round(((selectedMark.facingDeg % 360) + 360) % 360)}°`}
                className="col-span-2"
              >
                <input
                  type="range"
                  min={0}
                  max={359}
                  value={Math.round(((selectedMark.facingDeg % 360) + 360) % 360)}
                  onChange={(e) =>
                    edit((b) =>
                      editMark(b, selectedActor.characterId, (m) => {
                        m.facingDeg = Number(e.target.value);
                      }),
                    )
                  }
                  className="w-full accent-[var(--color-accent)]"
                  aria-label="Facing"
                  data-testid="desk-facing"
                />
              </Field>
              <Field label="x (m)">
                <Input
                  type="number"
                  step={0.1}
                  value={selectedMark.x}
                  onChange={(e) =>
                    edit((b) =>
                      editMark(b, selectedActor.characterId, (m) => {
                        m.x = snap(Number(e.target.value));
                      }),
                    )
                  }
                  data-testid="desk-x"
                />
              </Field>
              <Field label="z (m)">
                <Input
                  type="number"
                  step={0.1}
                  value={selectedMark.z}
                  onChange={(e) =>
                    edit((b) =>
                      editMark(b, selectedActor.characterId, (m) => {
                        m.z = snap(Number(e.target.value));
                      }),
                    )
                  }
                  data-testid="desk-z"
                />
              </Field>
            </div>
          ) : (
            <p className="text-[12px] text-muted">Tap a character on the plan to pose and turn it.</p>
          )}
        </section>

        <section className="min-w-0 space-y-2" aria-label="Camera">
          <h4 className="flex items-center gap-1 text-[13px] font-medium">
            <Camera className="size-3.5" /> Camera of S{(shot?.index ?? 0) + 1}
          </h4>
          {camera && shot && input ? (
            <div className="grid grid-cols-2 gap-2">
              <Field label={`Lens ${Math.round(camera.lensMm)} mm`} className="col-span-2">
                <input
                  type="range"
                  min={12}
                  max={200}
                  value={Math.round(camera.lensMm)}
                  onChange={(e) =>
                    edit((b) => {
                      b.shots[shot.id]!.camera.lensMm = Number(e.target.value);
                    })
                  }
                  className="w-full accent-[var(--color-accent)]"
                  aria-label="Lens"
                  data-testid="desk-lens"
                />
              </Field>
              <Field label={`Height ${camera.y.toFixed(2)} m`} className="col-span-2">
                <input
                  type="range"
                  min={0.2}
                  max={8}
                  step={0.05}
                  value={camera.y}
                  onChange={(e) =>
                    edit((b) => {
                      const c = b.shots[shot.id]!.camera;
                      const dy = Number(e.target.value) - c.y;
                      c.y = Number(e.target.value);
                      if (c.end) c.end.y = Math.max(0.05, c.end.y + dy);
                    })
                  }
                  className="w-full accent-[var(--color-accent)]"
                  aria-label="Height"
                  data-testid="desk-height"
                />
              </Field>
              <Field label="Move">
                <Select
                  value={moveOf(draft, shot.id)}
                  onChange={(e) =>
                    edit((b) => {
                      const entry = b.shots[shot.id]!;
                      const move = e.target.value as BlockingMove;
                      entry.spec = { ...(entry.spec ?? defaultCameraSpec(input)), move };
                      entry.camera.end = moveEnd(entry.camera, entry.camera.lensMm, ctx.aspect, move);
                    })
                  }
                  data-testid="desk-move"
                >
                  {BLOCKING_MOVES.map((m) => (
                    <option key={m} value={m}>
                      {MOVE_LABEL[m]}
                    </option>
                  ))}
                </Select>
              </Field>
              <div className="flex items-end">
                <Button
                  size="sm"
                  icon={<Wand2 className="size-3.5" />}
                  onClick={autoCamera}
                  data-testid="desk-auto-camera"
                >
                  Auto camera
                </Button>
              </div>
            </div>
          ) : null}
        </section>

        <section className="min-w-0 space-y-2" aria-label="Checks" data-testid="desk-issues">
          <h4 className="flex items-center gap-1 text-[13px] font-medium">
            <Check className="size-3.5" /> Checks
            <Badge
              tone={
                view.issues.some((i) => i.severity === 'error')
                  ? 'danger'
                  : view.issues.length
                    ? 'warning'
                    : 'success'
              }
            >
              {view.issues.length ? `${view.issues.length} issue(s)` : 'clean'}
            </Badge>
          </h4>
          <ul className="max-h-48 space-y-1 overflow-y-auto">
            {view.issues.map((i, k) => (
              <li key={`${i.code}-${i.shotId}-${i.characterId}-${k}`}>
                <button
                  type="button"
                  className="w-full rounded px-1.5 py-1 text-left text-[12px] break-words hover:bg-surface-2"
                  onClick={() => i.shotId && setShotId(i.shotId)}
                  data-testid="desk-issue"
                  data-code={i.code}
                >
                  <span className={i.severity === 'error' ? 'text-danger' : 'text-warning'}>●</span>{' '}
                  {i.message}
                </button>
              </li>
            ))}
          </ul>
          <SetControls draft={draft} edit={edit} />
        </section>
      </div>
    </Card>
  );
}

function SetControls({
  draft,
  edit,
}: {
  draft: SceneBlocking;
  edit: (fn: (b: SceneBlocking) => void) => void;
}) {
  return (
    <details className="text-[12px]" data-testid="desk-set">
      <summary className="cursor-pointer text-muted">
        The set: {draft.set.ground}, {draft.set.width}×{draft.set.depth} m
      </summary>
      <div className="mt-2 grid grid-cols-2 gap-2">
        <Field label="Width (m)">
          <Input
            type="number"
            min={2}
            max={200}
            value={draft.set.width}
            onChange={(e) =>
              edit((b) => {
                b.set.width = Math.min(200, Math.max(2, Number(e.target.value)));
              })
            }
            data-testid="desk-set-width"
          />
        </Field>
        <Field label="Depth (m)">
          <Input
            type="number"
            min={2}
            max={200}
            value={draft.set.depth}
            onChange={(e) =>
              edit((b) => {
                b.set.depth = Math.min(200, Math.max(2, Number(e.target.value)));
              })
            }
            data-testid="desk-set-depth"
          />
        </Field>
        <Field label="Ground" className="col-span-2">
          <Input
            value={draft.set.ground}
            maxLength={80}
            onChange={(e) =>
              edit((b) => {
                b.set.ground = e.target.value;
              })
            }
            data-testid="desk-set-ground"
          />
        </Field>
        <Field
          label={`Sun from ${Math.round(((draft.set.sun.azimuthDeg % 360) + 360) % 360)}°`}
          className="col-span-2"
        >
          <input
            type="range"
            min={0}
            max={359}
            value={Math.round(((draft.set.sun.azimuthDeg % 360) + 360) % 360)}
            onChange={(e) =>
              edit((b) => {
                b.set.sun.azimuthDeg = Number(e.target.value);
              })
            }
            className="w-full accent-[var(--color-accent)]"
            aria-label="Sun"
            data-testid="desk-sun"
          />
        </Field>
      </div>
    </details>
  );
}

/** The director's view: the floor plan from above, the front of the set at the bottom. */
function Plan({
  draft,
  ctx,
  names,
  shotId,
  selected,
  onSelect,
  onShot,
  edit,
  editMark,
}: {
  draft: SceneBlocking;
  ctx: ReturnType<typeof blockingContextFor>;
  names: Record<string, string>;
  shotId: string;
  selected: Selection | null;
  onSelect: (s: Selection) => void;
  onShot: (id: string) => void;
  edit: (fn: (b: SceneBlocking) => void) => void;
  editMark: (b: SceneBlocking, characterId: string, fn: (m: BlockingMark) => void) => void;
}) {
  const svg = useRef<SVGSVGElement>(null);
  const drag = useRef<Drag | null>(null);
  const { width: W, depth: D } = draft.set;
  // The plan shows the set, its landmarks and every camera
  const xs = [-W / 2, W / 2, ...Object.values(draft.shots).map((s) => s.camera.x)];
  const zs = [-D / 2, D / 2, ...Object.values(draft.shots).map((s) => s.camera.z)];
  const lim = Math.max(W, D) * 1.6;
  const minX = Math.max(-lim, Math.min(...xs)) - 1;
  const maxX = Math.min(lim, Math.max(...xs)) + 1;
  const minZ = Math.max(-lim, Math.min(...zs)) - 1;
  const maxZ = Math.min(lim, Math.max(...zs)) + 1;
  const unit = Math.max(maxX - minX, maxZ - minZ) / 40;
  const toWorld = (e: ReactPointerEvent) => {
    const el = svg.current;
    const m = el?.getScreenCTM();
    if (!el || !m) return null;
    const pt = el.createSVGPoint();
    pt.x = e.clientX;
    pt.y = e.clientY;
    const p = pt.matrixTransform(m.inverse());
    return { x: p.x, z: p.y };
  };
  const start = (e: ReactPointerEvent, d: Drag, sel: Selection) => {
    e.stopPropagation();
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    drag.current = d;
    onSelect(sel);
    if (d.kind === 'camera' || d.kind === 'aim') onShot(d.id);
  };
  const move = (e: ReactPointerEvent) => {
    const d = drag.current;
    const w = d ? toWorld(e) : null;
    if (!d || !w) return;
    edit((b) => {
      if (d.kind === 'actor')
        editMark(b, d.id, (m) => {
          m.x = snap(w.x);
          m.z = snap(w.z);
        });
      else if (d.kind === 'facing')
        editMark(b, d.id, (m) => {
          m.facingDeg = facingOf({ x: w.x - m.x, z: w.z - m.z });
        });
      else if (d.kind === 'prop') {
        const p = b.props.find((x) => x.id === d.id);
        if (p) Object.assign(p, { x: snap(w.x), z: snap(w.z) });
      } else {
        const c = b.shots[d.id]?.camera;
        if (!c) return;
        if (d.kind === 'camera') {
          const dx = snap(w.x) - c.x;
          const dz = snap(w.z) - c.z;
          c.x += dx;
          c.z += dz;
          if (c.end) Object.assign(c.end, { x: c.end.x + dx, z: c.end.z + dz });
        } else {
          const dx = snap(w.x) - c.targetX;
          const dz = snap(w.z) - c.targetZ;
          c.targetX += dx;
          c.targetZ += dz;
          if (c.end) Object.assign(c.end, { targetX: c.end.targetX + dx, targetZ: c.end.targetZ + dz });
        }
      }
    });
  };
  const end = () => {
    drag.current = null;
  };
  const line = lineOfAction(draft, ctx.shots);
  const lineA = line ? markFor(draft, shotId, line.a) : null;
  const lineB = line ? markFor(draft, shotId, line.b) : null;
  // Lines, labels and wedges ignore the pointer: a facing line starts at its disc's centre and would take the press
  return (
    <svg
      ref={svg}
      viewBox={`${minX} ${minZ} ${maxX - minX} ${maxZ - minZ}`}
      className="aspect-square w-full touch-none rounded-[var(--radius-control)] border border-border bg-surface-2 select-none [&_line]:pointer-events-none [&_polygon]:pointer-events-none [&_text]:pointer-events-none"
      role="img"
      aria-label="Director's view: the floor plan"
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={end}
      onPointerDown={() => onSelect({ kind: 'set' })}
      data-testid="desk-plan"
    >
      <rect
        x={-W / 2}
        y={-D / 2}
        width={W}
        height={D}
        fill="var(--color-surface)"
        stroke="var(--color-border)"
        strokeWidth={unit * 0.15}
      />
      {Array.from({ length: Math.floor(W) + 1 }, (_, i) => (
        <line
          key={`gx${i}`}
          x1={-W / 2 + i}
          x2={-W / 2 + i}
          y1={-D / 2}
          y2={D / 2}
          stroke="var(--color-border)"
          strokeWidth={unit * 0.05}
        />
      ))}
      {Array.from({ length: Math.floor(D) + 1 }, (_, i) => (
        <line
          key={`gz${i}`}
          x1={-W / 2}
          x2={W / 2}
          y1={-D / 2 + i}
          y2={-D / 2 + i}
          stroke="var(--color-border)"
          strokeWidth={unit * 0.05}
        />
      ))}
      <text x={0} y={D / 2 + unit * 1.4} textAnchor="middle" fontSize={unit * 0.9} fill="var(--color-muted)">
        front
      </text>
      {draft.set.landmarks.map((l) => (
        <g
          key={l.id}
          transform={`translate(${l.x} ${l.z}) rotate(${-l.rotationDeg})`}
          onPointerDown={(e) => {
            e.stopPropagation();
            onSelect({ kind: 'landmark', id: l.id });
          }}
        >
          {l.shape === 'cylinder' ? (
            <ellipse rx={l.width / 2} ry={l.depth / 2} fill={l.color} fillOpacity={0.55} />
          ) : (
            <rect
              x={-l.width / 2}
              y={-l.depth / 2}
              width={l.width}
              height={l.depth}
              fill={l.color}
              fillOpacity={l.shape === 'water' ? 0.45 : 0.6}
            />
          )}
          {l.label ? (
            <text textAnchor="middle" y={unit * 0.3} fontSize={unit * 0.8} fill="var(--color-text)">
              {l.label}
            </text>
          ) : null}
        </g>
      ))}
      {lineA && lineB ? (
        <line
          x1={lineA.x - (lineB.x - lineA.x) * 2}
          y1={lineA.z - (lineB.z - lineA.z) * 2}
          x2={lineB.x + (lineB.x - lineA.x) * 2}
          y2={lineB.z + (lineB.z - lineA.z) * 2}
          stroke="var(--color-warning)"
          strokeDasharray={`${unit * 0.6} ${unit * 0.4}`}
          strokeWidth={unit * 0.12}
          data-testid="desk-line"
        />
      ) : null}
      {ctx.shots.map((s) => (
        <CameraWedge
          key={s.id}
          draft={draft}
          shot={s}
          aspect={ctx.aspect}
          unit={unit}
          active={s.id === shotId}
          onDrag={(e, kind) => start(e, { kind, id: s.id }, { kind: 'camera', id: s.id })}
        />
      ))}
      {draft.props.map((p) => (
        <g key={p.id} onPointerDown={(e) => start(e, { kind: 'prop', id: p.id }, { kind: 'prop', id: p.id })}>
          <rect
            x={p.x - p.size / 2}
            y={p.z - p.size / 2}
            width={p.size}
            height={p.size}
            fill={p.color}
            stroke="var(--color-bg)"
            strokeWidth={unit * 0.08}
          />
        </g>
      ))}
      {draft.actors.map((a) => {
        const m = markFor(draft, shotId, a.characterId)!;
        const f = facingVector(m.facingDeg);
        const r = Math.max(0.22, unit * 0.7);
        const active = selected?.kind === 'actor' && selected.id === a.characterId;
        return (
          <g
            key={a.id}
            data-testid={`desk-actor-${a.characterId}`}
            data-x={m.x}
            data-z={m.z}
            data-facing={Math.round(m.facingDeg)}
          >
            {m.toX !== null && m.toZ !== null ? (
              <line
                x1={m.x}
                y1={m.z}
                x2={m.toX}
                y2={m.toZ}
                stroke={a.color}
                strokeDasharray={`${unit * 0.4} ${unit * 0.3}`}
                strokeWidth={unit * 0.12}
              />
            ) : null}
            <circle
              cx={m.x}
              cy={m.z}
              r={r}
              fill={a.color}
              stroke={active ? 'var(--color-text)' : 'var(--color-bg)'}
              strokeWidth={unit * (active ? 0.25 : 0.12)}
              className="cursor-grab"
              onPointerDown={(e) =>
                start(e, { kind: 'actor', id: a.characterId }, { kind: 'actor', id: a.characterId })
              }
            />
            <line
              x1={m.x}
              y1={m.z}
              x2={m.x + f.x * r * 2}
              y2={m.z + f.z * r * 2}
              stroke="var(--color-text)"
              strokeWidth={unit * 0.15}
            />
            <circle
              cx={m.x + f.x * r * 2}
              cy={m.z + f.z * r * 2}
              r={r * 0.45}
              fill="var(--color-text)"
              className="cursor-grab"
              onPointerDown={(e) =>
                start(e, { kind: 'facing', id: a.characterId }, { kind: 'actor', id: a.characterId })
              }
              data-testid={`desk-facing-${a.characterId}`}
            />
            <text
              x={m.x}
              y={m.z - r * 1.6}
              textAnchor="middle"
              fontSize={unit * 0.85}
              fill="var(--color-text)"
            >
              {names[a.characterId] ?? ''}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

/** A shot's camera on the plan: its field of view as a wedge, the body to move, the aim to turn. */
function CameraWedge({
  draft,
  shot,
  aspect,
  unit,
  active,
  onDrag,
}: {
  draft: SceneBlocking;
  shot: BlockingShotInput;
  aspect: number;
  unit: number;
  active: boolean;
  onDrag: (e: ReactPointerEvent, kind: 'camera' | 'aim') => void;
}) {
  const c = draft.shots[shot.id]?.camera;
  if (!c) return null;
  const dx = c.targetX - c.x;
  const dz = c.targetZ - c.z;
  const dist = Math.max(0.5, Math.hypot(dx, dz));
  const { tanH } = lensTangents(c.lensMm, aspect);
  const ux = dx / dist;
  const uz = dz / dist;
  const reach = Math.min(dist, unit * 8);
  const half = tanH * reach;
  const color = active ? 'var(--color-accent)' : 'var(--color-muted)';
  return (
    <g data-testid={`desk-camera-${shot.index + 1}`} data-x={c.x} data-z={c.z} opacity={active ? 1 : 0.6}>
      <polygon
        points={`${c.x},${c.z} ${c.x + ux * reach - uz * half},${c.z + uz * reach + ux * half} ${c.x + ux * reach + uz * half},${c.z + uz * reach - ux * half}`}
        fill={color}
        fillOpacity={active ? 0.22 : 0.1}
        stroke={color}
        strokeWidth={unit * 0.08}
      />
      {c.end ? (
        <line
          x1={c.x}
          y1={c.z}
          x2={c.end.x}
          y2={c.end.z}
          stroke={color}
          strokeWidth={unit * 0.12}
          strokeDasharray={`${unit * 0.3} ${unit * 0.25}`}
        />
      ) : null}
      <rect
        x={c.x - unit * 0.6}
        y={c.z - unit * 0.45}
        width={unit * 1.2}
        height={unit * 0.9}
        rx={unit * 0.15}
        fill={color}
        className="cursor-grab"
        onPointerDown={(e) => onDrag(e, 'camera')}
      />
      <text x={c.x} y={c.z + unit * 1.6} textAnchor="middle" fontSize={unit * 0.8} fill={color}>
        S{shot.index + 1}
      </text>
      {active ? (
        <circle
          cx={c.targetX}
          cy={c.targetZ}
          r={unit * 0.45}
          fill="none"
          stroke={color}
          strokeWidth={unit * 0.15}
          className="cursor-crosshair"
          onPointerDown={(e) => onDrag(e, 'aim')}
          data-testid="desk-aim"
        />
      ) : null}
    </g>
  );
}

/** The shot through its camera: the camera view the image model gets, a thirds grid and the names. */
function CameraView({
  draft,
  shot,
  aspect,
  names,
}: {
  draft: SceneBlocking;
  shot: BlockingShotInput;
  aspect: number;
  names: Record<string, string>;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(480);
  useEffect(() => {
    const el = wrap.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(([e]) =>
      setWidth(Math.max(160, Math.min(960, Math.round(e!.contentRect.width)))),
    );
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const height = Math.round(width / aspect);
  useEffect(() => {
    const c = canvas.current;
    const g = c?.getContext?.('2d');
    if (!c || !g) return;
    c.width = width;
    c.height = height;
    const img = renderShotView(draft, shot, { width, height });
    g.putImageData(new ImageData(img.data, img.width, img.height), 0, 0);
  }, [draft, shot, width, height]);
  const cam = draft.shots[shot.id]?.camera;
  const labels = cam
    ? shot.characterIds.flatMap((id) => {
        const actor = draft.actors.find((a) => a.characterId === id);
        const m = markFor(draft, shot.id, id);
        if (!actor || !m) return [];
        const p = projectPoint(cameraBasis(cam, aspect), figurePoints(m, actor.heightM).head);
        if (!Number.isFinite(p.x) || Math.abs(p.x) > 1 || p.y > 1.2 || p.y < -1) return [];
        return [{ id, x: (p.x + 1) * 50, y: Math.max(4, (1 - p.y) * 50 - 6) }];
      })
    : [];
  return (
    <div
      ref={wrap}
      className="relative w-full overflow-hidden rounded-[var(--radius-control)] border border-border bg-black"
      style={{ aspectRatio: String(aspect) }}
    >
      <canvas
        ref={canvas}
        className="block h-full w-full"
        aria-label="Camera view"
        data-testid="desk-camera-view"
      />
      <div className="pointer-events-none absolute inset-0" aria-hidden>
        <div className="absolute inset-y-0 left-1/3 w-px bg-white/25" />
        <div className="absolute inset-y-0 left-2/3 w-px bg-white/25" />
        <div className="absolute inset-x-0 top-1/3 h-px bg-white/25" />
        <div className="absolute inset-x-0 top-2/3 h-px bg-white/25" />
        {labels.map((l) => (
          <span
            key={l.id}
            className="absolute -translate-x-1/2 rounded bg-black/60 px-1 text-[11px] text-white"
            style={{ left: `${l.x}%`, top: `${l.y}%` }}
          >
            {names[l.id]}
          </span>
        ))}
      </div>
    </div>
  );
}
