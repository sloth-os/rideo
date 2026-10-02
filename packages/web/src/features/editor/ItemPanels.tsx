import {
  type Keyframe,
  type Ramp,
  rampPreset,
  type TimelineOp,
  type TransformProp,
  transformAt,
  type VideoItem,
} from '@rideo/shared';
import { Eraser, Layers, Palette, Scissors, Upload } from 'lucide-react';
import { useRef, useState } from 'react';
import { Badge, Button, Field, Input, Select } from '../../components/ui';
import { api } from '../../lib/api';
import { useProject } from '../../store/project';
import { reportError, useUi } from '../../store/ui';

type Apply = (ops: TimelineOp[]) => void;

const PROPS: { prop: TransformProp; label: string; min: number; max: number; step: number }[] = [
  { prop: 'x', label: 'X', min: -0.5, max: 1.5, step: 0.01 },
  { prop: 'y', label: 'Y', min: -0.5, max: 1.5, step: 0.01 },
  { prop: 'scale', label: 'Scale', min: 0.05, max: 4, step: 0.01 },
  { prop: 'rotation', label: 'Rotation (°)', min: -360, max: 360, step: 1 },
  { prop: 'opacity', label: 'Opacity', min: 0, max: 1, step: 0.01 },
];

const sectionTitle = (icon: React.ReactNode, text: string) => (
  <div className="flex items-center gap-1.5 text-[11px] font-medium tracking-wide text-muted uppercase">
    {icon}
    {text}
  </div>
);

/**
 * Transform keyframes at the playhead (docs/design/editor.md#multitrack-transforms-and-keyframes): the values in
 * effect now, *Set keyframe* writes them at this time, presets for picture-in-picture, push-in and fade-in.
 */
export function TransformSection({
  item,
  time,
  duration,
  apply,
}: {
  item: VideoItem;
  time: number;
  duration: number;
  apply: Apply;
}) {
  const local = Math.min(duration, Math.max(0, time - item.start));
  const now = transformAt(item.transform, local);
  const [draft, setDraft] = useState<Partial<Record<TransformProp, number>>>({});
  const keyframes = item.transform?.keyframes ?? [];
  const at = keyframes.findIndex((k) => Math.abs(k.t - local) < 1 / 48);
  const set = (keys: Keyframe[] | null) =>
    apply([{ op: 'set_transform', itemId: item.id, transform: keys?.length ? { keyframes: keys } : null }]);
  const setKeyframe = () => {
    const values = { ...now, ...draft };
    const k: Keyframe = { t: Math.round(local * 1000) / 1000, ...values };
    const rest = keyframes.filter((_, i) => i !== at);
    set([...rest, k].sort((a, b) => a.t - b.t));
    setDraft({});
  };
  const presets: { id: string; label: string; keys: () => Keyframe[] }[] = [
    { id: 'pip', label: 'Picture in picture', keys: () => [{ t: 0, x: 0.78, y: 0.22, scale: 0.35 }] },
    {
      id: 'pushin',
      label: 'Push in',
      keys: () => [
        { t: 0, scale: 1 },
        { t: Math.max(0.1, duration), scale: 1.15 },
      ],
    },
    {
      id: 'fade',
      label: 'Fade in',
      keys: () => [
        { t: 0, opacity: 0 },
        { t: Math.min(0.5, duration), opacity: 1 },
      ],
    },
  ];
  return (
    <div className="space-y-2 border-t border-border pt-3" data-testid="transform-section">
      {sectionTitle(<Layers className="size-3.5" />, 'Transform')}
      <div className="grid grid-cols-2 gap-2">
        {PROPS.map(({ prop, label, min, max, step }) => (
          <Field key={prop} label={label}>
            <Input
              type="number"
              min={min}
              max={max}
              step={step}
              value={String(Math.round((draft[prop] ?? now[prop]) * 1000) / 1000)}
              onChange={(e) => setDraft({ ...draft, [prop]: Number(e.target.value) })}
              data-testid={`transform-${prop}`}
            />
          </Field>
        ))}
      </div>
      <div className="flex flex-wrap gap-1">
        <Button size="sm" variant="primary" className="h-7" onClick={setKeyframe} data-testid="keyframe-set">
          {at >= 0 ? 'Update keyframe' : 'Set keyframe'}
        </Button>
        {at >= 0 ? (
          <Button
            size="sm"
            variant="ghost"
            className="h-7"
            onClick={() => set(keyframes.filter((_, i) => i !== at))}
            data-testid="keyframe-remove"
          >
            Remove keyframe
          </Button>
        ) : null}
        {keyframes.length ? (
          <Button
            size="sm"
            variant="ghost"
            className="h-7"
            onClick={() => set(null)}
            data-testid="transform-reset"
          >
            Reset
          </Button>
        ) : null}
      </div>
      <Select
        value=""
        onChange={(e) => {
          const p = presets.find((x) => x.id === e.target.value);
          if (p) set(p.keys());
        }}
        aria-label="Transform preset"
        data-testid="transform-preset"
      >
        <option value="">Preset…</option>
        {presets.map((p) => (
          <option key={p.id} value={p.id}>
            {p.label}
          </option>
        ))}
      </Select>
      {keyframes.length ? (
        <ul className="flex flex-wrap gap-1 text-[11px]" data-testid="keyframes">
          {keyframes.map((k) => (
            <li key={k.t}>
              <Badge tone={Math.abs(k.t - local) < 1 / 48 ? 'accent' : 'neutral'}>◆ {k.t.toFixed(2)} s</Badge>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

const RAMPS = [
  { id: 'ease_in', label: 'Ease in (0.5× → 2×)' },
  { id: 'ease_out', label: 'Ease out (2× → 0.5×)' },
  { id: 'speed_up_middle', label: 'Speed up the middle (1× → 3× → 1×)' },
] as const;

/** Speed ramp presets (docs/design/editor.md#speed-ramps); a ramped item's own sound is muted. */
export function RampSection({ item, apply }: { item: VideoItem; apply: Apply }) {
  const current = item.ramp ? describe(item.ramp) : 'off';
  return (
    <div className="space-y-2 border-t border-border pt-3" data-testid="ramp-section">
      {sectionTitle(<Scissors className="size-3.5" />, 'Speed ramp')}
      <Select
        value=""
        onChange={(e) => {
          const v = e.target.value;
          if (!v) return;
          apply([
            {
              op: 'set_ramp',
              itemId: item.id,
              ramp: v === 'off' ? null : rampPreset(v as (typeof RAMPS)[number]['id'], item),
            },
          ]);
        }}
        aria-label="Speed ramp"
        data-testid="ramp-preset"
      >
        <option value="">{current === 'off' ? 'No ramp…' : `Ramp: ${current}`}</option>
        {RAMPS.map((r) => (
          <option key={r.id} value={r.id}>
            {r.label}
          </option>
        ))}
        {item.ramp ? <option value="off">Constant speed</option> : null}
      </Select>
      {item.ramp ? (
        <p className="text-[12px] text-muted">The item's own sound is muted while it ramps.</p>
      ) : null}
    </div>
  );
}

function describe(ramp: Ramp): string {
  return ramp.points.map((p) => `${p.speed}×`).join(' → ');
}

/** A `.cube` LUT on the item and how much of it (docs/design/editor.md#luts). */
export function LutSection({ item, apply }: { item: VideoItem; apply: Apply }) {
  const { docs, projectId } = useProject();
  const file = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const luts = Object.values(docs?.resources ?? {}).filter((r) => r.kind === 'lut');
  const choose = (resourceId: string) => {
    const r = luts.find((x) => x.id === resourceId);
    apply([
      {
        op: 'set_lut',
        itemId: item.id,
        lut: r ? { media: r.media, resourceId: r.id, intensity: item.lut?.intensity ?? 1 } : null,
      },
    ]);
  };
  const upload = async (f: File) => {
    if (!projectId) return;
    setBusy(true);
    try {
      const r = await api.upload(projectId, f);
      apply([{ op: 'set_lut', itemId: item.id, lut: { media: r.media, resourceId: r.id, intensity: 1 } }]);
      useUi.getState().toast(`LUT ${r.name} applied`, 'success');
    } catch (err) {
      reportError(err);
    } finally {
      setBusy(false);
      if (file.current) file.current.value = '';
    }
  };
  return (
    <div className="space-y-2 border-t border-border pt-3" data-testid="lut-section">
      {sectionTitle(<Palette className="size-3.5" />, 'LUT')}
      <div className="flex gap-1">
        <Select
          value={item.lut?.resourceId ?? ''}
          onChange={(e) => choose(e.target.value)}
          aria-label="LUT"
          data-testid="lut-select"
        >
          <option value="">None</option>
          {luts.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </Select>
        <input
          ref={file}
          type="file"
          accept=".cube"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void upload(f);
          }}
          data-testid="lut-upload-file"
        />
        <Button
          size="sm"
          className="h-9"
          loading={busy}
          icon={<Upload className="size-3.5" />}
          onClick={() => file.current?.click()}
          aria-label="Upload a .cube LUT"
          data-testid="lut-upload"
        />
      </div>
      {item.lut ? (
        <Field label={`Intensity ${Math.round(item.lut.intensity * 100)}%`}>
          <Input
            type="range"
            min={0}
            max={1}
            step={0.05}
            defaultValue={item.lut.intensity}
            key={`lut${item.lut.intensity}`}
            onMouseUp={(e) =>
              apply([
                {
                  op: 'set_lut',
                  itemId: item.id,
                  lut: { ...item.lut!, intensity: Number((e.target as HTMLInputElement).value) },
                },
              ])
            }
            onTouchEnd={(e) =>
              apply([
                {
                  op: 'set_lut',
                  itemId: item.id,
                  lut: { ...item.lut!, intensity: Number((e.target as HTMLInputElement).value) },
                },
              ])
            }
            data-testid="lut-intensity"
          />
        </Field>
      ) : null}
    </div>
  );
}

/** Remove the background with a segmentation model (docs/design/editor.md#segmentation-masks-remove-the-background). */
export function MaskSection({ item, apply }: { item: VideoItem; apply: Apply }) {
  const { projectId, jobs } = useProject();
  const [subject, setSubject] = useState(item.mask?.subject ?? 'the person');
  const [busy, setBusy] = useState(false);
  const running = Object.values(jobs).some(
    (j) =>
      j.kind === 'mask.generate' &&
      (j.params as { itemId?: string }).itemId === item.id &&
      !['succeeded', 'failed', 'cancelled'].includes(j.status),
  );
  const start = async () => {
    if (!projectId) return;
    setBusy(true);
    try {
      await api.removeBackground(projectId, item.id, { subject });
      useUi.getState().toast(`Finding ${subject}…`, 'info');
    } catch (err) {
      reportError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-2 border-t border-border pt-3" data-testid="mask-section">
      {sectionTitle(<Eraser className="size-3.5" />, 'Background')}
      {item.mask ? (
        <>
          <div className="flex flex-wrap items-center gap-1.5 text-[12px]">
            <Badge tone="success" testid="mask-badge">
              removed: {item.mask.subject}
            </Badge>
            {item.mask.model ? <span className="text-muted">{item.mask.model}</span> : null}
          </div>
          <label className="flex items-center gap-2 text-[13px]">
            <input
              type="checkbox"
              checked={item.mask.invert}
              onChange={(e) =>
                apply([
                  { op: 'set_mask', itemId: item.id, mask: { ...item.mask!, invert: e.target.checked } },
                ])
              }
              className="accent-[var(--color-accent)]"
              data-testid="mask-invert"
            />
            Keep the background instead
          </label>
          <Button
            size="sm"
            variant="ghost"
            className="h-7"
            onClick={() => apply([{ op: 'set_mask', itemId: item.id, mask: null }])}
            data-testid="mask-clear"
          >
            Restore the background
          </Button>
        </>
      ) : (
        <div className="flex gap-1">
          <Input
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            maxLength={200}
            aria-label="Subject to keep"
            data-testid="mask-subject"
          />
          <Button
            size="sm"
            className="h-9 shrink-0"
            loading={busy || running}
            disabled={!subject.trim()}
            onClick={() => void start()}
            data-testid="mask-start"
          >
            Remove the background
          </Button>
        </div>
      )}
    </div>
  );
}

/** The overlay tracks' items need a start time (they are positioned freely). */
export function StartField({ item, apply }: { item: VideoItem; apply: Apply }) {
  return (
    <Field label="Start (s)">
      <Input
        type="number"
        min={0}
        step={0.1}
        defaultValue={item.start}
        key={`start${item.start}`}
        onBlur={(e) => {
          const v = Number(e.target.value);
          if (Number.isFinite(v) && v >= 0 && v !== item.start)
            apply([{ op: 'move', itemId: item.id, start: v }]);
        }}
        data-testid="overlay-start"
      />
    </Field>
  );
}
