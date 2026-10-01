import {
  APERTURE_PRESETS,
  CAMERA_MOVES,
  type Clip,
  LENS_PRESETS,
  type Resource,
  type Shot,
  type Take,
} from '@rideo/shared';
import { Copy, Pause, Play } from 'lucide-react';
import { useRef, useState } from 'react';
import { Editable } from '../../components/Editable';
import { Badge, Button, Dialog, Field, Input, Select } from '../../components/ui';
import { api, mediaUrl } from '../../lib/api';
import { useProject } from '../../store/project';
import { reportError } from '../../store/ui';

const NO_RESOURCES: Record<string, Resource> = Object.freeze({}) as Record<string, Resource>;

/**
 * Directing controls of a shot (docs/design/directing.md): the camera move, lens and aperture, the start and end
 * frames, a motion reference, a fixed seed, and variations to compare.
 */
export function DirectPanel({ clip, shot }: { clip: Clip; shot: Shot }) {
  const projectId = useProject((s) => s.projectId);
  const resources = useProject((s) => s.docs?.resources ?? NO_RESOURCES);
  const [count, setCount] = useState(3);
  if (!projectId) return null;
  const ready = Object.values(resources).filter((r) => r.status === 'ready');
  const images = ready.filter((r) => r.kind === 'image');
  const videos = ready.filter((r) => r.kind === 'video');
  const update = (body: Record<string, unknown>) =>
    api.updateShot(projectId, clip.id, shot.id, body).catch(reportError);
  const camera = (patch: Record<string, unknown>) => update({ camera: { ...shot.camera, ...patch } });
  const num = (v: string) => (v === '' ? null : Number(v));
  return (
    <div
      className="mt-2 grid grid-cols-1 gap-2 rounded-[var(--radius-control)] border border-border bg-surface-2 p-2.5 sm:grid-cols-2 lg:grid-cols-4"
      data-testid="direct-panel"
    >
      <Field label="Camera move">
        <Select
          value={shot.camera.move ?? ''}
          onChange={(e) => camera({ move: e.target.value || null })}
          data-testid="camera-move"
        >
          <option value="">Planned: {shot.camera.movement.replace(/_/g, ' ')}</option>
          {CAMERA_MOVES.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Lens">
        <Select
          value={shot.camera.lensMm ?? ''}
          onChange={(e) => camera({ lensMm: num(e.target.value) })}
          data-testid="camera-lens"
        >
          <option value="">Model's choice</option>
          {LENS_PRESETS.map((l) => (
            <option key={l.mm} value={l.mm}>
              {l.label}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Aperture">
        <Select
          value={shot.camera.aperture ?? ''}
          onChange={(e) => camera({ aperture: num(e.target.value) })}
          data-testid="camera-aperture"
        >
          <option value="">Model's choice</option>
          {APERTURE_PRESETS.map((a) => (
            <option key={a} value={a}>
              f/{a}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Seed">
        <Input
          type="number"
          min={0}
          placeholder="derived"
          defaultValue={shot.seed ?? ''}
          onBlur={(e) => {
            const v = num(e.target.value);
            if (v !== shot.seed) void update({ seed: v === null ? null : Math.max(0, Math.round(v)) });
          }}
          data-testid="shot-seed"
        />
      </Field>
      <Field label="Start frame">
        <Select
          value={shot.startFrame.mode === 'resource' ? (shot.startFrame.resourceId ?? '') : ''}
          onChange={(e) =>
            update({
              startFrame: e.target.value
                ? { mode: 'resource', resourceId: e.target.value }
                : { mode: 'auto', resourceId: null },
            })
          }
          data-testid="start-frame"
        >
          <option value="">Keyframe / storyboard / previous shot</option>
          {images.map((r) => (
            <option key={r.id} value={r.id}>
              Image: {r.name}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="End frame">
        <Select
          value={shot.endFrame.mode === 'resource' ? `res:${shot.endFrame.resourceId}` : shot.endFrame.mode}
          onChange={(e) => {
            const v = e.target.value;
            if (v.startsWith('res:'))
              void update({ endFrame: { mode: 'resource', description: '', resourceId: v.slice(4) } });
            else if (v === 'generate')
              void update({
                endFrame: {
                  mode: 'generate',
                  description: shot.endFrame.description || shot.description,
                  resourceId: null,
                },
              });
            else void update({ endFrame: { mode: 'none', description: '', resourceId: null } });
          }}
          data-testid="end-frame-mode"
        >
          <option value="none">None</option>
          <option value="generate">Generate from a description</option>
          {images.map((r) => (
            <option key={r.id} value={`res:${r.id}`}>
              Image: {r.name}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Motion reference">
        <Select
          value={shot.motionReference?.resourceId ?? ''}
          onChange={(e) =>
            update({
              motionReference: e.target.value
                ? { resourceId: e.target.value, mode: shot.motionReference?.mode ?? 'motion' }
                : null,
            })
          }
          data-testid="motion-ref-resource"
        >
          <option value="">None</option>
          {videos.map((r) => (
            <option key={r.id} value={r.id}>
              Video: {r.name}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Follow">
        <Select
          value={shot.motionReference?.mode ?? 'motion'}
          disabled={!shot.motionReference}
          onChange={(e) =>
            shot.motionReference &&
            update({ motionReference: { ...shot.motionReference, mode: e.target.value } })
          }
          data-testid="motion-ref-mode"
        >
          <option value="motion">its motion</option>
          <option value="pose">its poses</option>
          <option value="camera">its camera move</option>
        </Select>
      </Field>
      {shot.endFrame.mode === 'generate' ? (
        <Field label="The last frame shows" className="sm:col-span-2 lg:col-span-4">
          <Editable
            value={shot.endFrame.description}
            multiline
            rows={2}
            onSave={(v) => update({ endFrame: { ...shot.endFrame, description: v } })}
            ariaLabel="End frame description"
          />
        </Field>
      ) : null}
      <div className="flex flex-wrap items-end gap-2 sm:col-span-2 lg:col-span-4">
        <Field label="Variations">
          <Select
            value={count}
            onChange={(e) => setCount(Number(e.target.value))}
            className="w-20"
            data-testid="variation-count"
          >
            {[2, 3, 4].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </Select>
        </Field>
        <Button
          size="sm"
          icon={<Copy className="size-3.5" />}
          onClick={() => api.variations(projectId, clip.id, shot.id, count).catch(reportError)}
          data-testid="generate-variations"
        >
          Generate {count} variations
        </Button>
      </div>
    </div>
  );
}

const FRAME_SOURCE: Record<Take['request']['firstFrameSource'], string> = {
  keyframe: 'keyframe',
  previous_shot: 'previous shot',
  storyboard: 'storyboard',
  resource: 'image',
  none: 'none',
};

/** Two takes side by side, played and seeked together (docs/design/directing.md#variations-and-comparison). */
export function CompareDialog({
  clip,
  shot,
  takes,
  onClose,
}: {
  clip: Clip;
  shot: Shot;
  takes: [Take, Take];
  onClose: () => void;
}) {
  const projectId = useProject((s) => s.projectId);
  const refs = [useRef<HTMLVideoElement>(null), useRef<HTMLVideoElement>(null)];
  const [playing, setPlaying] = useState(false);
  if (!projectId) return null;
  const all = () => refs.map((r) => r.current).filter((v): v is HTMLVideoElement => !!v);
  const toggle = () => {
    if (playing) {
      for (const v of all()) v.pause();
      setPlaying(false);
    } else {
      const t = all()[0]?.currentTime ?? 0;
      for (const v of all()) {
        v.currentTime = t;
        void v.play().catch(() => undefined);
      }
      setPlaying(true);
    }
  };
  const seek = (t: number) => {
    for (const v of all()) v.currentTime = t;
  };
  const use = (take: Take) =>
    api.selectTake(projectId, clip.id, shot.id, take.id).then(onClose).catch(reportError);
  return (
    <Dialog open onClose={onClose} title={`Compare takes · shot ${shot.index + 1}`} wide>
      <div className="space-y-3" data-testid="compare-dialog">
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {takes.map((take, i) => (
            <div key={take.id} className="space-y-1.5">
              <div className="flex flex-wrap items-center gap-1.5 text-[12px]">
                <span className="font-semibold">{i === 0 ? 'A' : 'B'}</span>
                {take.variation ? <Badge>variation {take.variation}</Badge> : null}
                <Badge tone={take.consistency.status === 'passed' ? 'success' : 'warning'}>
                  {take.consistency.status} {take.consistency.score.toFixed(2)}
                </Badge>
                <span className="text-muted">
                  seed {take.request.seed} · from {FRAME_SOURCE[take.request.firstFrameSource]}
                  {take.request.lastFrameSource ? ` · ends on ${take.request.lastFrameSource} frame` : ''}
                </span>
              </div>
              {take.video ? (
                <video
                  ref={refs[i]}
                  src={mediaUrl(projectId, take.video.path)}
                  muted={i === 1}
                  playsInline
                  onEnded={() => setPlaying(false)}
                  onSeeked={(e) => {
                    const t = e.currentTarget.currentTime;
                    for (const v of all())
                      if (v !== e.currentTarget && Math.abs(v.currentTime - t) > 0.05) v.currentTime = t;
                  }}
                  className="aspect-video w-full rounded bg-black"
                  data-testid={`compare-video-${i === 0 ? 'a' : 'b'}`}
                />
              ) : null}
              <Button
                size="sm"
                variant={shot.selectedTakeId === take.id ? 'secondary' : 'primary'}
                disabled={!take.video || shot.selectedTakeId === take.id}
                onClick={() => use(take)}
                data-testid={`compare-use-${i === 0 ? 'a' : 'b'}`}
              >
                {shot.selectedTakeId === take.id ? 'Selected' : `Use ${i === 0 ? 'A' : 'B'}`}
              </Button>
            </div>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            icon={playing ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}
            onClick={toggle}
            data-testid="compare-play"
          >
            {playing ? 'Pause both' : 'Play both'}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => seek(0)}>
            From the start
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
