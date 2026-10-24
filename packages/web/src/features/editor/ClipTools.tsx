import {
  type ChromaKey,
  type Effects,
  isStillMedia,
  itemEnd,
  MARKER_COLORS,
  type Marker,
  type MarkerColor,
  type TimelineOp,
  type VideoItem,
} from '@rideo/shared';
import {
  AudioLines,
  FlipHorizontal2,
  FlipVertical2,
  Pipette,
  RotateCcw,
  SlidersHorizontal,
  Snowflake,
  Trash2,
} from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { Badge, Button, cx, Dialog, Field, Input, Kbd, PRESSED, Select } from '../../components/ui';
import { type EditorAction, isMac, keysOf, SHORTCUTS } from './shortcuts';

type Apply = (ops: TimelineOp[]) => void;

const sectionTitle = (icon: ReactNode, text: string) => (
  <div className="flex items-center gap-1.5 text-[11px] font-medium tracking-wide text-muted uppercase">
    {icon}
    {text}
  </div>
);

/** A range input that commits once a change ends (the native `change` event: the thumb released, a key pressed). */
export function Slider({
  value,
  min,
  max,
  step,
  onCommit,
  label,
  testid,
  format = (v) => String(Math.round(v * 100) / 100),
}: {
  value: number;
  min: number;
  max: number;
  step: number;
  onCommit: (v: number) => void;
  label: string;
  testid?: string;
  format?: (v: number) => string;
}) {
  const [draft, setDraft] = useState(value);
  const ref = useRef<HTMLInputElement>(null);
  const commit = useRef(onCommit);
  commit.current = onCommit;
  useEffect(() => setDraft(value), [value]);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onChange = () => {
      const v = Number(el.value);
      if (v !== value) commit.current(v);
    };
    el.addEventListener('change', onChange);
    return () => el.removeEventListener('change', onChange);
  }, [value]);
  return (
    <label className="block min-w-0">
      <span className="flex items-center justify-between text-[12px] text-muted">
        {label}
        <span className="tabular font-mono text-[11px]">{format(draft)}</span>
      </span>
      <input
        ref={ref}
        type="range"
        min={min}
        max={max}
        step={step}
        value={draft}
        onChange={(e) => setDraft(Number(e.target.value))}
        className="w-full accent-[var(--color-accent)]"
        aria-label={label}
        data-testid={testid}
      />
    </label>
  );
}

/** Whether an item's sound can become an audio item (docs/design/editing-tools.md#detach-audio). */
export function canDetach(item: VideoItem): boolean {
  return (
    !isStillMedia(item.source.media) &&
    item.source.media.hasAudio !== false &&
    !item.muted &&
    !item.freeze &&
    !item.ramp &&
    Math.abs(item.speed - 1) < 1e-6
  );
}

/** Freeze frame, Detach audio and Mirror (docs/design/editing-tools.md#clip-tools). */
export function ClipActions({ item, apply, time }: { item: VideoItem; apply: Apply; time: number }) {
  const still = isStillMedia(item.source.media);
  const inside = time >= item.start - 1e-6 && time <= itemEnd(item) + 1e-6;
  const flip = item.flip ?? {};
  const toggle = (axis: 'x' | 'y') =>
    apply([{ op: 'set_flip', itemId: item.id, flip: { ...flip, [axis]: !flip[axis] } }]);
  return (
    <div className="flex flex-wrap gap-1.5" data-testid="clip-actions">
      <Button
        size="sm"
        className="h-7"
        icon={<Snowflake className="size-3.5" />}
        disabled={still || !!item.freeze || !inside}
        title={inside ? 'Hold the frame at the playhead for 2 s' : 'Move the playhead onto the item'}
        onClick={() => apply([{ op: 'freeze_frame', itemId: item.id, at: time }])}
        data-testid="freeze-frame"
      >
        Freeze frame
      </Button>
      <Button
        size="sm"
        className="h-7"
        icon={<AudioLines className="size-3.5" />}
        disabled={!canDetach(item)}
        title="Move the sound to its own audio item"
        onClick={() => apply([{ op: 'detach_audio', itemId: item.id }])}
        data-testid="detach-audio"
      >
        Detach audio
      </Button>
      <Button
        size="sm"
        className={cx('h-7', flip.x && PRESSED)}
        icon={<FlipHorizontal2 className="size-3.5" />}
        aria-pressed={!!flip.x}
        onClick={() => toggle('x')}
        data-testid="mirror"
      >
        Mirror
      </Button>
      <Button
        size="sm"
        className={cx('h-7', flip.y && PRESSED)}
        icon={<FlipVertical2 className="size-3.5" />}
        aria-pressed={!!flip.y}
        aria-label="Upside down"
        onClick={() => toggle('y')}
        data-testid="flip-vertical"
      />
    </div>
  );
}

/** How long a freeze frame holds (docs/design/editing-tools.md#freeze-frame). */
export function FreezeSection({ item, apply }: { item: VideoItem; apply: Apply }) {
  if (!item.freeze) return null;
  return (
    <div className="space-y-2 border-t border-border pt-3" data-testid="freeze-section">
      {sectionTitle(<Snowflake className="size-3.5" />, 'Freeze frame')}
      <Field label="Hold (s)">
        <Input
          type="number"
          min={0.1}
          max={60}
          step={0.1}
          defaultValue={item.freeze.duration}
          key={`fz${item.freeze.duration}`}
          onBlur={(e) => {
            const v = Number(e.target.value);
            if (v >= 0.1 && v <= 60 && v !== item.freeze?.duration)
              apply([{ op: 'set_freeze', itemId: item.id, duration: v }]);
          }}
          data-testid="freeze-duration"
        />
      </Field>
    </div>
  );
}

const ADJUSTMENTS: { key: keyof Effects; label: string; min: number; max: number; step: number }[] = [
  { key: 'exposure', label: 'Exposure', min: -2, max: 2, step: 0.05 },
  { key: 'temperature', label: 'Temperature', min: -1, max: 1, step: 0.05 },
  { key: 'tint', label: 'Tint', min: -1, max: 1, step: 0.05 },
  { key: 'hue', label: 'Hue (°)', min: -180, max: 180, step: 1 },
  { key: 'shadows', label: 'Shadows', min: -1, max: 1, step: 0.05 },
  { key: 'highlights', label: 'Highlights', min: -1, max: 1, step: 0.05 },
  { key: 'vignette', label: 'Vignette', min: 0, max: 1, step: 0.05 },
];

/** The seven color adjustments (docs/design/editing-tools.md#color-adjustments). */
export function AdjustSection({ item, apply }: { item: VideoItem; apply: Apply }) {
  const e = item.effects ?? {};
  const touched = ADJUSTMENTS.some((a) => (e[a.key] ?? 0) !== 0);
  return (
    <div className="space-y-2 border-t border-border pt-3" data-testid="adjust-section">
      <div className="flex items-center justify-between">
        {sectionTitle(<SlidersHorizontal className="size-3.5" />, 'Adjust')}
        <Button
          size="sm"
          variant="ghost"
          className="h-7"
          icon={<RotateCcw className="size-3.5" />}
          disabled={!touched}
          onClick={() =>
            apply([
              {
                op: 'set_effects',
                itemId: item.id,
                effects: Object.fromEntries(ADJUSTMENTS.map((a) => [a.key, 0])),
              },
            ])
          }
          data-testid="adjust-reset"
        >
          Reset
        </Button>
      </div>
      <div className="grid grid-cols-2 gap-x-3 gap-y-1">
        {ADJUSTMENTS.map((a) => (
          <Slider
            key={a.key}
            label={a.label}
            min={a.min}
            max={a.max}
            step={a.step}
            value={e[a.key] ?? 0}
            onCommit={(v) => apply([{ op: 'set_effects', itemId: item.id, effects: { [a.key]: v } }])}
            testid={`adjust-${a.key}`}
          />
        ))}
      </div>
    </div>
  );
}

/** The key's color: committed when the picker closes (the native `change` event), not on every move. */
function ColorInput({ value, onCommit }: { value: string; onCommit: (color: string) => void }) {
  const [draft, setDraft] = useState(value);
  const ref = useRef<HTMLInputElement>(null);
  const commit = useRef(onCommit);
  commit.current = onCommit;
  useEffect(() => setDraft(value), [value]);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onChange = () => {
      if (el.value.toLowerCase() !== value.toLowerCase()) commit.current(el.value);
    };
    el.addEventListener('change', onChange);
    return () => el.removeEventListener('change', onChange);
  }, [value]);
  return (
    <input
      ref={ref}
      type="color"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      className="h-7 w-10 cursor-pointer rounded border border-border bg-surface-2"
      aria-label="Key color"
      data-testid="key-color"
    />
  );
}

const KEY_PRESETS: { label: string; color: string }[] = [
  { label: 'Green', color: '#00ff00' },
  { label: 'Blue', color: '#0000ff' },
];

/** The chroma key (docs/design/editing-tools.md#chroma-key): on/off, its color, similarity and blend. */
export function KeySection({ item, apply }: { item: VideoItem; apply: Apply }) {
  const key = item.key;
  const set = (next: ChromaKey | null) => apply([{ op: 'set_key', itemId: item.id, key: next }]);
  return (
    <div className="space-y-2 border-t border-border pt-3" data-testid="key-section">
      <div className="flex items-center justify-between">
        {sectionTitle(<Pipette className="size-3.5" />, 'Chroma key')}
        <Button
          size="sm"
          className={cx('h-7', key && PRESSED)}
          aria-pressed={!!key}
          disabled={!!item.mask}
          onClick={() => set(key ? null : { color: '#00ff00', similarity: 0.3, blend: 0.1 })}
          data-testid="key-toggle"
        >
          {key ? 'On' : 'Off'}
        </Button>
      </div>
      {item.mask ? (
        <p className="text-[12px] text-muted">
          The background is removed with a mask; an item has a key or a mask.
        </p>
      ) : null}
      {key ? (
        <>
          <div className="flex flex-wrap items-center gap-1.5">
            <ColorInput value={key.color} onCommit={(color) => set({ ...key, color })} />
            {KEY_PRESETS.map((p) => (
              <Button
                key={p.color}
                size="sm"
                variant="ghost"
                className="h-7"
                aria-pressed={key.color.toLowerCase() === p.color}
                onClick={() => set({ ...key, color: p.color })}
              >
                <span className="size-3 rounded-full border border-border" style={{ background: p.color }} />
                {p.label}
              </Button>
            ))}
          </div>
          <div className="grid grid-cols-2 gap-x-3">
            <Slider
              label="Similarity"
              min={0.01}
              max={1}
              step={0.01}
              value={key.similarity}
              onCommit={(v) => set({ ...key, similarity: v })}
              testid="key-similarity"
            />
            <Slider
              label="Blend"
              min={0}
              max={1}
              step={0.01}
              value={key.blend}
              onCommit={(v) => set({ ...key, blend: v })}
              testid="key-blend"
            />
          </div>
        </>
      ) : null}
    </div>
  );
}

/** Marker colors as drawn on the ruler (a marker's color is the editor's choice, not a status). */
export const MARKER_HEX: Record<MarkerColor, string> = {
  red: '#FF4D5E',
  orange: '#FF8A3D',
  yellow: '#F4B740',
  green: '#2EC4B6',
  cyan: '#22D3EE',
  blue: '#5B8CFF',
  purple: '#A78BFA',
};

/** The selected marker (docs/design/editing-tools.md#markers): its label and color, *Go to*, *Delete*. */
export function MarkerInspector({
  marker,
  apply,
  seek,
  onDone,
}: {
  marker: Marker;
  apply: Apply;
  seek: (t: number) => void;
  onDone: () => void;
}) {
  return (
    <div className="space-y-3" data-testid="marker-inspector">
      <div className="flex items-center gap-2">
        <Badge tone="accent">marker</Badge>
        <span className="tabular font-mono text-[12px] text-muted">{marker.t.toFixed(2)} s</span>
      </div>
      <Field label="Label">
        <Input
          defaultValue={marker.label}
          key={`${marker.id}${marker.label}`}
          maxLength={200}
          placeholder="Beat, cue, note…"
          onBlur={(e) =>
            e.target.value !== marker.label &&
            apply([{ op: 'update_marker', markerId: marker.id, label: e.target.value }])
          }
          data-testid="marker-label"
        />
      </Field>
      <Field label="Color">
        <Select
          value={marker.color}
          onChange={(e) =>
            apply([{ op: 'update_marker', markerId: marker.id, color: e.target.value as MarkerColor }])
          }
          data-testid="marker-color"
        >
          {MARKER_COLORS.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </Select>
      </Field>
      <div className="flex flex-wrap gap-2 border-t border-border pt-3">
        <Button size="sm" onClick={() => seek(marker.t)} data-testid="marker-goto">
          Go to
        </Button>
        <Button
          size="sm"
          variant="danger"
          icon={<Trash2 className="size-3.5" />}
          onClick={() => {
            apply([{ op: 'remove_marker', markerId: marker.id }]);
            onDone();
          }}
          data-testid="marker-delete"
        >
          Delete
        </Button>
      </div>
    </div>
  );
}

/** Markers on phones: the list, a tap goes there (docs/design/editing-tools.md#markers). */
export function MarkersCard({
  markers,
  selected,
  onSelect,
  onAdd,
  seek,
}: {
  markers: readonly Marker[];
  selected: string | null;
  onSelect: (id: string) => void;
  onAdd: () => void;
  seek: (t: number) => void;
}) {
  return (
    <div className="space-y-2 md:hidden" data-testid="markers-card">
      <div className="flex items-center justify-between">
        <span className="text-[13px] font-medium">Markers</span>
        <Button size="sm" className="h-7" onClick={onAdd} data-testid="marker-add">
          Add at playhead
        </Button>
      </div>
      {markers.length === 0 ? <p className="text-[12px] text-muted">No markers yet.</p> : null}
      <ul className="space-y-1">
        {markers.map((m) => (
          <li key={m.id}>
            <button
              type="button"
              onClick={() => {
                onSelect(m.id);
                seek(m.t);
              }}
              className={cx(
                'flex w-full items-center gap-2 rounded border border-border px-2 py-2 text-left text-[13px]',
                selected === m.id && 'border-accent',
              )}
              data-testid="marker-row"
            >
              <span className="size-2.5 shrink-0 rounded-full" style={{ background: MARKER_HEX[m.color] }} />
              <span className="min-w-0 flex-1 truncate">{m.label || 'Marker'}</span>
              <span className="tabular font-mono text-[12px] text-muted">{m.t.toFixed(2)} s</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The keyboard shortcuts, from the keymap table (docs/design/editing-tools.md#shortcuts). */
export function ShortcutsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const mac = isMac();
  return (
    <Dialog open={open} onClose={onClose} title="Keyboard shortcuts" wide>
      <ul className="grid grid-cols-1 gap-x-6 gap-y-1.5 sm:grid-cols-2" data-testid="shortcuts-list">
        {SHORTCUTS.map((s) => (
          <li key={s.action} className="flex items-center justify-between gap-3 text-[13px]">
            <span>{s.label}</span>
            <span className="flex shrink-0 flex-wrap justify-end gap-1">
              {keysOf(s.action, mac).map((k) => (
                <Kbd key={k}>{k}</Kbd>
              ))}
            </span>
          </li>
        ))}
      </ul>
    </Dialog>
  );
}

export interface MenuEntry {
  label: string;
  action?: EditorAction;
  onSelect: () => void;
  disabled?: boolean;
  danger?: boolean;
  testid?: string;
}

/** A right-click menu at a point; each entry shows its shortcut (docs/design/editing-tools.md#context-menu). */
export function ContextMenu({
  at,
  entries,
  onClose,
}: {
  at: { x: number; y: number };
  entries: MenuEntry[];
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const mac = isMac();
  useEffect(() => {
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent && e.key !== 'Escape') return;
      if (e.type === 'pointerdown' && ref.current?.contains(e.target as Node)) return;
      onClose();
    };
    window.addEventListener('pointerdown', close);
    window.addEventListener('keydown', close);
    window.addEventListener('resize', close);
    window.addEventListener('scroll', close, true);
    ref.current?.querySelector<HTMLElement>('button:not(:disabled)')?.focus();
    return () => {
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('keydown', close);
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', close, true);
    };
  }, [onClose]);
  // Kept inside the window
  const x = Math.min(at.x, (globalThis.innerWidth || 1024) - 228);
  const y = Math.min(at.y, (globalThis.innerHeight || 768) - entries.length * 32 - 16);
  return (
    <div
      ref={ref}
      role="menu"
      className="fixed z-50 w-56 rounded-[var(--radius-control)] border border-border bg-surface py-1 shadow-2xl"
      style={{ left: Math.max(8, x), top: Math.max(8, y) }}
      data-testid="context-menu"
    >
      {entries.map((e) => (
        <button
          key={e.label}
          type="button"
          role="menuitem"
          disabled={e.disabled}
          onClick={() => {
            onClose();
            e.onSelect();
          }}
          className={cx(
            'flex h-8 w-full items-center justify-between gap-3 px-3 text-left text-[13px] hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-40',
            e.danger && 'text-danger',
          )}
          data-testid={e.testid}
        >
          <span>{e.label}</span>
          {e.action ? (
            <span className="font-mono text-[11px] text-muted">{keysOf(e.action, mac)[0]}</span>
          ) : null}
        </button>
      ))}
    </div>
  );
}
