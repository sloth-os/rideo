import {
  DELIVERY_PRESETS,
  type DeliveryAspect,
  type DeliveryFormat,
  type DeliveryPresetId,
  type DeliveryResolution,
  disclosureFor,
  type ExportQuality,
  emptyTimeline,
  formatDuration,
  formatTimecode,
  type Item,
  isOverlayTrack,
  isStillMedia,
  isTerminalJob,
  itemDuration,
  itemEnd,
  LOUDNESS_TARGETS,
  type LoudnessTarget,
  newId,
  nextEditPoint,
  type ProjectBrand,
  previousEditPoint,
  primaryTrack,
  type RenderEngineChoice,
  type TextItem,
  type Timeline,
  type TimelineOp,
  TransitionTypeSchema,
  timelineDuration,
  type VideoItem,
  withBrand,
  withDisclosure,
} from '@rideo/shared';
import {
  Clapperboard,
  CopyPlus,
  Cpu,
  Download,
  Flag,
  Keyboard,
  Layers,
  LockOpen,
  Magnet,
  Maximize2,
  Pause,
  Play,
  Plus,
  Redo2,
  Scissors,
  SkipBack,
  SkipForward,
  Trash2,
  Type,
  Undo2,
  Wand2,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { JobRow } from '../../components/JobProgress';
import {
  Badge,
  Button,
  Card,
  cx,
  Dialog,
  EmptyState,
  Field,
  Input,
  PRESSED,
  Progress,
  SectionHeader,
  Select,
} from '../../components/ui';
import { laneFetch, previewFetch } from '../../engine/media-fetch';
import { useEngine } from '../../engine/state';
import { api } from '../../lib/api';
import { useProjectRole } from '../../lib/auth';
import { useProject } from '../../store/project';
import { reportError, useUi } from '../../store/ui';
import { type Clip, findItem, nudgeOps, pasteOps, splitTarget } from './actions';
import { BrandTools } from './BrandTools';
import {
  AdjustSection,
  ClipActions,
  ContextMenu,
  FreezeSection,
  KeySection,
  MarkerInspector,
  MarkersCard,
  type MenuEntry,
  ShortcutsDialog,
} from './ClipTools';
import { detectCaps, type EngineCaps } from './engine/capabilities';
import { gpuRenderer } from './engine/gpu-choice';
import { MediaPool } from './engine/media-pool';
import { Player } from './engine/player';
import { GenerativeExtend } from './GenerativeExtend';
import { type EditHistory, recordEdit, redone, redoTarget, seedHistory, undone, undoTarget } from './history';
import { LutSection, MaskSection, RampSection, StartField, TransformSection } from './ItemPanels';
import { LocalizationPanel } from './LocalizationPanel';
import { MixPanel } from './MixPanel';
import { OverlayPicker } from './OverlayPicker';
import { actionFor, type EditorAction, typing } from './shortcuts';
import { itemLabel, type LaneTarget, TimelineLanes } from './TimelineLanes';
import { TranscriptPanel } from './TranscriptPanel';

/** Labels of the transition types, in the menu's order (docs/design/editing-tools.md#transitions). */
const TRANSITION_LABELS: Record<NonNullable<VideoItem['transitionIn']>['type'], string> = {
  crossfade: 'Crossfade',
  wipe: 'Wipe',
  dip_to_black: 'Dip to black',
  dip_to_white: 'Dip to white',
  slide_left: 'Slide left',
  slide_right: 'Slide right',
  slide_up: 'Slide up',
  slide_down: 'Slide down',
  circle_open: 'Circle open',
};

/** Snapping is kept in this browser (docs/design/editing-tools.md#snapping). */
const SNAP_KEY = 'rideo.editor.snap';
function readSnap(): boolean {
  try {
    return globalThis.localStorage?.getItem(SNAP_KEY) !== 'off';
  } catch {
    return true;
  }
}
function writeSnap(on: boolean): void {
  try {
    globalThis.localStorage?.setItem(SNAP_KEY, on ? 'on' : 'off');
  } catch {
    // private windows: the choice lasts the session
  }
}

function useTimeline(): Timeline | null {
  const docs = useProject((s) => s.docs);
  return useMemo(() => {
    if (!docs) return null;
    const s = docs.project.settings;
    return (
      docs.timeline ?? emptyTimeline({ fps: s.fps, width: s.resolution.width, height: s.resolution.height })
    );
  }, [docs]);
}

function Inspector({
  item,
  timeline,
  apply,
  time,
  onDuplicate,
}: {
  item: Item;
  timeline: Timeline;
  apply: (ops: TimelineOp[]) => void;
  time: number;
  onDuplicate: () => void;
}) {
  const primary = primaryTrack(timeline);
  const index = primary.items.findIndex((i) => i.id === item.id);
  const overlay = timeline.tracks.some(
    (t) => isOverlayTrack(timeline, t) && t.items.some((i) => i.id === item.id),
  );
  const track = findItem(timeline, item.id)?.track;
  // A freeze frame's `in` is its frame; it has no out or sound (docs/design/editing-tools.md#freeze-frame)
  const frozen = item.kind === 'video' && !!item.freeze;
  const num = (v: string) => Number.parseFloat(v);
  if (track?.locked)
    return (
      <div className="space-y-3" data-testid="inspector">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="accent">{item.kind}</Badge>
          <span className="min-w-0 flex-1 truncate text-[13px]">{itemLabel(item)}</span>
        </div>
        <p className="text-[13px] text-muted" data-testid="inspector-locked">
          {track.name} is locked: its items do not change.
        </p>
        <Button
          size="sm"
          icon={<LockOpen className="size-3.5" />}
          onClick={() => apply([{ op: 'set_track', trackId: track.id, locked: false }])}
          data-testid="inspector-unlock"
        >
          Unlock {track.name}
        </Button>
      </div>
    );
  return (
    <div className="space-y-3" data-testid="inspector">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="accent">{item.kind}</Badge>
        {item.kind === 'video' && item.freeze ? <Badge tone="info">freeze</Badge> : null}
        <span className="min-w-0 flex-1 truncate text-[13px]">{itemLabel(item)}</span>
      </div>
      {item.kind === 'video' ? <ClipActions item={item} apply={apply} time={time} /> : null}
      {item.kind !== 'text' ? (
        <div className="grid grid-cols-2 gap-2">
          <Field label={frozen ? 'Frame at (s)' : 'In (s)'}>
            <Input
              type="number"
              step={0.1}
              min={0}
              defaultValue={item.in}
              key={`in${item.in}`}
              onBlur={(e) =>
                num(e.target.value) !== item.in &&
                apply([{ op: 'trim', itemId: item.id, in: num(e.target.value) }])
              }
              data-testid="trim-in"
            />
          </Field>
          {frozen ? null : (
            <Field label="Out (s)">
              <Input
                type="number"
                step={0.1}
                min={0}
                defaultValue={item.out}
                key={`out${item.out}`}
                onBlur={(e) =>
                  num(e.target.value) !== item.out &&
                  apply([{ op: 'trim', itemId: item.id, out: num(e.target.value) }])
                }
                data-testid="trim-out"
              />
            </Field>
          )}
          {frozen ? null : (
            <Field label="Volume">
              <Input
                type="range"
                min={0}
                max={2}
                step={0.05}
                defaultValue={item.volume}
                key={`v${item.volume}`}
                onMouseUp={(e) =>
                  apply([
                    { op: 'set_volume', itemId: item.id, volume: num((e.target as HTMLInputElement).value) },
                  ])
                }
                onKeyUp={(e) =>
                  apply([
                    { op: 'set_volume', itemId: item.id, volume: num((e.target as HTMLInputElement).value) },
                  ])
                }
              />
            </Field>
          )}
          <Field label="Fade in / out">
            <div className="flex gap-1">
              <Input
                type="number"
                step={0.25}
                min={0}
                defaultValue={item.fadeIn ?? 0}
                key={`fi${item.fadeIn}`}
                onBlur={(e) => apply([{ op: 'set_fades', itemId: item.id, fadeIn: num(e.target.value) }])}
                aria-label="Fade in"
              />
              <Input
                type="number"
                step={0.25}
                min={0}
                defaultValue={item.fadeOut ?? 0}
                key={`fo${item.fadeOut}`}
                onBlur={(e) => apply([{ op: 'set_fades', itemId: item.id, fadeOut: num(e.target.value) }])}
                aria-label="Fade out"
              />
            </div>
          </Field>
        </div>
      ) : null}
      {item.kind === 'video' && index >= 0 && !frozen ? <GenerativeExtend item={item} /> : null}
      {item.kind === 'video' ? (
        <>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Speed">
              <Select
                value={item.speed}
                disabled={!!item.freeze}
                onChange={(e) => apply([{ op: 'set_speed', itemId: item.id, speed: num(e.target.value) }])}
              >
                {[0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4].map((s) => (
                  <option key={s} value={s}>
                    {s}×
                  </option>
                ))}
              </Select>
            </Field>
            {index > 0 ? (
              <Field label="Transition in">
                <Select
                  value={item.transitionIn?.type ?? ''}
                  onChange={(e) =>
                    apply([
                      {
                        op: 'set_transition',
                        itemId: item.id,
                        transition: e.target.value
                          ? {
                              type: TransitionTypeSchema.parse(e.target.value),
                              duration: item.transitionIn?.duration ?? 0.5,
                            }
                          : null,
                      },
                    ])
                  }
                  data-testid="transition-select"
                >
                  <option value="">Cut</option>
                  {TransitionTypeSchema.options.map((t) => (
                    <option key={t} value={t}>
                      {TRANSITION_LABELS[t]}
                    </option>
                  ))}
                </Select>
              </Field>
            ) : null}
          </div>
          <div className="grid grid-cols-3 gap-2">
            {(['brightness', 'contrast', 'saturation'] as const).map((k) => (
              <Field key={k} label={k}>
                <Input
                  type="number"
                  step={0.05}
                  defaultValue={item.effects?.[k] ?? (k === 'brightness' ? 0 : 1)}
                  key={`${k}${item.effects?.[k]}`}
                  onBlur={(e) =>
                    apply([{ op: 'set_effects', itemId: item.id, effects: { [k]: num(e.target.value) } }])
                  }
                />
              </Field>
            ))}
          </div>
          {overlay ? <StartField item={item} apply={apply} /> : null}
          <FreezeSection item={item} apply={apply} />
          <AdjustSection item={item} apply={apply} />
          <TransformSection item={item} time={time} duration={itemDuration(item)} apply={apply} />
          {isStillMedia(item.source.media) || item.freeze ? null : <RampSection item={item} apply={apply} />}
          <LutSection item={item} apply={apply} />
          <KeySection item={item} apply={apply} />
          {isStillMedia(item.source.media) || item.key || item.freeze ? null : (
            <MaskSection item={item} apply={apply} />
          )}
        </>
      ) : null}
      {item.kind === 'text' ? (
        <div className="space-y-2">
          <Field label="Text">
            <Input
              defaultValue={item.text}
              key={item.text}
              onBlur={(e) =>
                e.target.value &&
                e.target.value !== item.text &&
                apply([{ op: 'update_text', itemId: item.id, text: e.target.value }])
              }
            />
          </Field>
          <div className="grid grid-cols-3 gap-2">
            <Field label="Start">
              <Input
                type="number"
                step={0.1}
                defaultValue={item.start}
                key={`s${item.start}`}
                onBlur={(e) => apply([{ op: 'update_text', itemId: item.id, start: num(e.target.value) }])}
              />
            </Field>
            <Field label="Duration">
              <Input
                type="number"
                step={0.1}
                defaultValue={item.duration}
                key={`d${item.duration}`}
                onBlur={(e) => apply([{ op: 'update_text', itemId: item.id, duration: num(e.target.value) }])}
              />
            </Field>
            <Field label="Style">
              <Select
                value={item.style.preset}
                onChange={(e) =>
                  apply([
                    {
                      op: 'update_text',
                      itemId: item.id,
                      style: { ...item.style, preset: e.target.value as TextItem['style']['preset'] },
                    },
                  ])
                }
              >
                <option value="title">Title</option>
                <option value="lower_third">Lower third</option>
                <option value="caption">Caption</option>
              </Select>
            </Field>
          </div>
        </div>
      ) : null}
      <div className="flex flex-wrap gap-2 border-t border-border pt-3">
        <Button
          size="sm"
          icon={<Scissors className="size-3.5" />}
          disabled={!(time > item.start && time < itemEnd(item))}
          onClick={() => apply([{ op: 'split', itemId: item.id, at: time }])}
          data-testid="split-item"
        >
          Split at playhead
        </Button>
        {index > 0 ? (
          <Button size="sm" onClick={() => apply([{ op: 'move', itemId: item.id, index: index - 1 }])}>
            ← Earlier
          </Button>
        ) : null}
        {index >= 0 && index < primary.items.length - 1 ? (
          <Button size="sm" onClick={() => apply([{ op: 'move', itemId: item.id, index: index + 1 }])}>
            Later →
          </Button>
        ) : null}
        <Button
          size="sm"
          icon={<CopyPlus className="size-3.5" />}
          onClick={onDuplicate}
          data-testid="duplicate-item"
        >
          Duplicate
        </Button>
        <Button
          size="sm"
          variant="danger"
          icon={<Trash2 className="size-3.5" />}
          onClick={() => apply([{ op: 'remove', itemId: item.id }])}
          data-testid="delete-item"
        >
          Delete
        </Button>
      </div>
    </div>
  );
}

const ENGINE_LABEL: Record<RenderEngineChoice, string> = {
  auto: 'Auto (WebCodecs when every source decodes, else ffmpeg.wasm)',
  ffmpeg: 'ffmpeg.wasm (exact filtergraph, any codec)',
  webcodecs: 'WebCodecs (hardware encoder, fastest)',
};

/**
 * Export (docs/design/editor.md#rendering): queues an `export.render` editor job that a studio tab (usually
 * this one) renders in chunks; the server then watermarks and publishes it.
 */
function ExportDialog({
  open,
  onClose,
  timeline,
  projectId,
  brand,
}: {
  open: boolean;
  onClose: () => void;
  timeline: Timeline;
  projectId: string;
  brand: ProjectBrand | null;
}) {
  const [quality, setQuality] = useState<ExportQuality>('standard');
  const [bug, setBug] = useState(!!brand?.logo && brand.bug.enabled);
  const [engine, setEngine] = useState<RenderEngineChoice>('auto');
  const [loudness, setLoudness] = useState<LoudnessTarget>('streaming');
  const [stems, setStems] = useState(false);
  // Deliveries (docs/design/finishing.md#delivery-presets): a preset, then its options.
  const [preset, setPreset] = useState<DeliveryPresetId>('web');
  const [format, setFormat] = useState<DeliveryFormat>('mp4');
  const [resolution, setResolution] = useState<DeliveryResolution>('project');
  const [fps, setFps] = useState(0);
  const [aspect, setAspect] = useState<DeliveryAspect>('source');
  const [maxDuration, setMaxDuration] = useState(0);
  const [thumbnails, setThumbnails] = useState(false);
  const choosePreset = (id: DeliveryPresetId) => {
    const p = DELIVERY_PRESETS[id];
    setPreset(id);
    setFormat(p.format);
    setResolution(p.resolution);
    setAspect(p.aspect);
    setMaxDuration(p.maxDurationSec ?? 0);
    setThumbnails(p.thumbnails);
    setLoudness(p.loudness);
    setStems(p.stems);
    setCaptions(p.captions);
  };
  // Language variants (docs/design/localization.md#language-variants).
  const [language, setLanguage] = useState('');
  const [dubbed, setDubbed] = useState(false);
  const [captions, setCaptions] = useState<'burn' | 'sidecar'>('burn');
  const localizations = useProject((s) => s.docs?.localizations);
  const [caps, setCaps] = useState<EngineCaps | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [queued, setQueued] = useState<{ exportId: string; jobId: string } | null>(null);
  const queuedJob = useProject((s) => (queued ? s.jobs[queued.jobId] : undefined));
  // A reframed export prepares its focus first (docs/design/finishing.md); the render is a later job.
  const renderJob = useProject((s) =>
    queued
      ? Object.values(s.jobs).find((j) => j.kind === 'export.render' && j.params.exportId === queued.exportId)
      : undefined,
  );
  const job = renderJob ?? queuedJob;
  const exp = useProject((s) => (queued ? s.docs?.exports[queued.exportId] : undefined));
  const here = useEngine((s) => (job && s.busy?.jobId === job.id ? s.busy : null));
  useEffect(() => {
    if (!open) return;
    setError(null);
    void detectCaps(timeline.width, timeline.height).then(setCaps);
  }, [open, timeline.width, timeline.height]);
  useEffect(() => {
    if (exp?.status === 'succeeded')
      useUi.getState().toast('Export ready (watermarked) — see Exports', 'success');
    if (exp?.status === 'failed') setError(exp.error ?? 'the export failed');
  }, [exp?.status, exp?.error]);
  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.createExport(projectId, {
        quality,
        engine,
        loudness,
        stems,
        ...(language ? { language, dubbed } : {}),
        captions,
        preset,
        format,
        resolution,
        ...(fps ? { fps } : {}),
        aspect,
        ...(maxDuration ? { maxDurationSec: maxDuration } : {}),
        thumbnails,
        ...(brand?.logo ? { bug } : {}),
      });
      setQueued({ exportId: r.export.id, jobId: r.job.id });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      reportError(err);
    } finally {
      setBusy(false);
    }
  };
  const progress = here?.progress ?? job?.progress;
  const status = !queued
    ? null
    : exp?.status === 'succeeded'
      ? 'Ready: watermarked and published in Exports.'
      : exp?.status === 'failed'
        ? null
        : exp?.status === 'finishing'
          ? 'Rendered. The server is adding the invisible watermark…'
          : here
            ? `Rendering in this tab — ${here.progress.message ?? 'starting'}. Keep this tab open.`
            : job?.kind === 'export.prepare'
              ? 'Finding the subject of every take to reframe…'
              : job?.status === 'running'
                ? 'Rendering in another studio tab…'
                : 'Waiting for an editor tab to pick up the render…';
  return (
    <Dialog open={open} onClose={onClose} title="Export">
      <div className="space-y-4">
        <p className="text-[13px] text-muted">
          The film is rendered in this browser in chunks — with ffmpeg.wasm or WebCodecs — then the server
          adds the invisible watermark and publishes it.
        </p>
        <Field label="Delivery">
          <Select
            value={preset}
            onChange={(e) => choosePreset(e.target.value as DeliveryPresetId)}
            data-testid="export-preset"
          >
            {(Object.keys(DELIVERY_PRESETS) as DeliveryPresetId[]).map((id) => (
              <option key={id} value={id}>
                {DELIVERY_PRESETS[id].label}
              </option>
            ))}
          </Select>
        </Field>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <Field label="Format">
            <Select
              value={format}
              onChange={(e) => setFormat(e.target.value as DeliveryFormat)}
              data-testid="export-format"
            >
              <option value="mp4">MP4 (H.264)</option>
              <option value="prores">ProRes 422 HQ (MOV)</option>
              <option value="frames">PNG sequence + WAV</option>
            </Select>
          </Field>
          <Field label="Size">
            <Select
              value={resolution}
              onChange={(e) => setResolution(e.target.value as DeliveryResolution)}
              data-testid="export-resolution"
            >
              <option value="project">Project</option>
              <option value="hd">HD (1080)</option>
              <option value="uhd">4K UHD (2160)</option>
            </Select>
          </Field>
          <Field label="Frame rate">
            <Select value={fps} onChange={(e) => setFps(Number(e.target.value))} data-testid="export-fps">
              <option value={0}>Project ({timeline.fps} fps)</option>
              {[30, 48, 50, 60].map((v) => (
                <option key={v} value={v}>
                  {v} fps{v > timeline.fps ? ' (interpolated)' : ''}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Aspect">
            <Select
              value={aspect}
              onChange={(e) => setAspect(e.target.value as DeliveryAspect)}
              data-testid="export-aspect"
            >
              <option value="source">As the cut</option>
              <option value="9:16">9:16 (auto-reframe)</option>
              <option value="1:1">1:1 (auto-reframe)</option>
            </Select>
          </Field>
          <Field label="Length">
            <Select
              value={maxDuration}
              onChange={(e) => setMaxDuration(Number(e.target.value))}
              data-testid="export-maxduration"
            >
              <option value={0}>The whole cut</option>
              {[15, 30, 60].map((v) => (
                <option key={v} value={v}>
                  Cut down to {v} s
                </option>
              ))}
            </Select>
          </Field>
          <label className="flex h-9 items-center justify-between gap-2 self-end rounded-[var(--radius-control)] border border-border bg-surface-2 px-2.5 text-[13px]">
            Thumbnails
            <input
              type="checkbox"
              checked={thumbnails}
              onChange={(e) => setThumbnails(e.target.checked)}
              className="size-4 accent-[var(--color-accent)]"
              data-testid="export-thumbnails"
            />
          </label>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Quality">
            <Select
              value={quality}
              onChange={(e) => setQuality(e.target.value as ExportQuality)}
              name="quality"
            >
              <option value="draft">Draft (720p)</option>
              <option value="standard">Standard</option>
              <option value="high">High</option>
            </Select>
          </Field>
          <Field label="Engine">
            <Select
              value={engine}
              onChange={(e) => setEngine(e.target.value as RenderEngineChoice)}
              name="engine"
              data-testid="export-engine"
            >
              {(Object.keys(ENGINE_LABEL) as RenderEngineChoice[]).map((k) => (
                <option key={k} value={k} disabled={k === 'webcodecs' && !caps?.video}>
                  {ENGINE_LABEL[k]}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <div className="grid grid-cols-1 items-end gap-3 sm:grid-cols-2">
          <Field label="Loudness">
            <Select
              value={loudness}
              onChange={(e) => setLoudness(e.target.value as LoudnessTarget)}
              data-testid="export-loudness"
            >
              {(Object.keys(LOUDNESS_TARGETS) as (keyof typeof LOUDNESS_TARGETS)[]).map((k) => (
                <option key={k} value={k}>
                  {LOUDNESS_TARGETS[k].label}
                </option>
              ))}
              <option value="off">Off (as mixed)</option>
            </Select>
          </Field>
          <label className="flex h-9 items-center justify-between gap-2 rounded-[var(--radius-control)] border border-border bg-surface-2 px-2.5 text-[13px]">
            Dialogue, music and effects stems (WAV)
            <input
              type="checkbox"
              checked={stems}
              onChange={(e) => setStems(e.target.checked)}
              className="size-4 accent-[var(--color-accent)]"
              data-testid="export-stems"
            />
          </label>
        </div>
        <div className="grid grid-cols-1 items-end gap-3 sm:grid-cols-3">
          <Field label="Language">
            <Select
              value={language}
              onChange={(e) => {
                setLanguage(e.target.value);
                if (!e.target.value) setDubbed(false);
              }}
              data-testid="export-language"
            >
              <option value="">Original</option>
              {Object.values(localizations ?? {}).map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </Select>
          </Field>
          <label className="flex h-9 items-center justify-between gap-2 rounded-[var(--radius-control)] border border-border bg-surface-2 px-2.5 text-[13px]">
            Dubbed voices
            <input
              type="checkbox"
              checked={dubbed}
              disabled={!language}
              onChange={(e) => setDubbed(e.target.checked)}
              className="size-4 accent-[var(--color-accent)]"
              data-testid="export-dubbed"
            />
          </label>
          <Field label="Captions">
            <Select
              value={captions}
              onChange={(e) => setCaptions(e.target.value as 'burn' | 'sidecar')}
              data-testid="export-captions"
            >
              <option value="burn">Burned in (+ SRT/VTT)</option>
              <option value="sidecar">SRT/VTT files only</option>
            </Select>
          </Field>
          {brand?.logo ? (
            <label className="flex h-9 items-center justify-between gap-2 rounded-[var(--radius-control)] border border-border bg-surface-2 px-2.5 text-[13px]">
              Brand bug ({brand.name})
              <input
                type="checkbox"
                checked={bug}
                onChange={(e) => setBug(e.target.checked)}
                className="size-4 accent-[var(--color-accent)]"
                data-testid="export-bug"
              />
            </label>
          ) : null}
        </div>
        <div className="flex flex-wrap gap-1.5 text-[12px]" data-testid="webcodecs-caps">
          <Badge tone="success">
            <Cpu className="size-3" /> ffmpeg.wasm
          </Badge>
          {caps === null ? (
            <Badge>detecting WebCodecs…</Badge>
          ) : caps.webcodecs && caps.video ? (
            <>
              <Badge tone="success">WebCodecs</Badge>
              <Badge>video {caps.video}</Badge>
              <Badge>{caps.container}</Badge>
            </>
          ) : (
            <Badge tone="warning">WebCodecs encoding unavailable</Badge>
          )}
        </div>
        {status ? (
          <div className="space-y-2" data-testid="export-status">
            <p className="text-[13px]">{status}</p>
            {progress && exp?.status !== 'succeeded' ? (
              <Progress value={progress.total ? progress.done / progress.total : 0} label="export" />
            ) : null}
          </div>
        ) : null}
        {error ? (
          <p className="text-[12px] break-words text-danger" role="alert" data-testid="export-error">
            {error}
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} data-testid="export-close">
            Close
          </Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={!!queued && exp?.status !== 'succeeded' && exp?.status !== 'failed'}
            onClick={start}
            data-testid="export-start"
          >
            {queued ? 'Export again' : 'Export'}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

export function EditorView() {
  const { docs, projectId, jobs, commits } = useProject();
  const loading = useProject((s) => s.loading);
  const playerCommand = useProject((s) => s.playerCommand);
  const timeline = useTimeline();
  // The preview shows the export's disclosure label (docs/design/provenance.md#disclosure-label).
  const preview = useMemo(() => {
    if (!timeline || !docs) return timeline;
    const d = disclosureFor(docs, timeline);
    // The brand bug as the export draws it by default (docs/design/brand-kits.md#a-projects-brand)
    const brand = docs.project.settings.brand;
    return withBrand(
      withDisclosure(timeline, d.label ? { text: d.text, position: d.position } : null),
      brand,
      !!brand?.bug.enabled,
    );
  }, [timeline, docs]);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const playerRef = useRef<Player | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [selectedMarker, setSelectedMarker] = useState<string | null>(null);
  const [zoom, setZoom] = useState(40);
  const [exportOpen, setExportOpen] = useState(false);
  const [overlayOpen, setOverlayOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [menu, setMenu] = useState<{ at: { x: number; y: number }; entries: MenuEntry[] } | null>(null);
  // Snapping, kept in this browser (docs/design/editing-tools.md#snapping)
  const [snapping, setSnappingState] = useState(readSnap);
  const setSnapping = useCallback((on: boolean) => {
    setSnappingState(on);
    writeSnap(on);
  }, []);
  // The session's edit history and clipboard (docs/design/editing-tools.md#undo-and-redo). Edits, undo and redo run
  // one after the other in one queue, each on the history the last one left: an edit is sent once the one before it
  // is answered, and an undo steps back from the last edit made before it.
  const historyRef = useRef<EditHistory>({ undo: [], redo: [], current: null });
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const setHistory = useCallback((next: (h: EditHistory) => EditHistory) => {
    historyRef.current = next(historyRef.current);
    rerender();
  }, []);
  const queue = useRef<Promise<void>>(Promise.resolve());
  const pendingEdits = useProject((s) => s.pendingEdits.length);
  const seededFor = useRef<string | null>(null);
  const clipboard = useRef<Clip | null>(null);
  const reverse = useRef<ReturnType<typeof setInterval> | null>(null);
  // Small frames and sound for the lanes' filmstrips and waveforms (docs/design/editor.md#waveforms-and-filmstrips)
  const [lanePool, setLanePool] = useState<MediaPool | null>(null);
  const [webcodecs] = useState(() => typeof globalThis.VideoDecoder !== 'undefined');
  /** Runs `task` after everything queued before it, then fetches the timeline if a commit changed it meanwhile. */
  const enqueue = useCallback(
    (task: () => Promise<void>) => {
      queue.current = queue.current
        .then(async () => {
          await task();
          const s = useProject.getState();
          if (!projectId || !s.timelineBehind || s.pendingEdits.length > 0) return;
          const next = await api.timeline(projectId).catch(() => null);
          if (next) useProject.getState().confirmTimeline(next);
        })
        .catch(reportError);
    },
    [projectId],
  );
  // Optimistic (docs/design/editor.md#operations): the shared reducer updates the timeline at once and the ops wait in
  // the queue; the server's answer is authoritative, with the edits it has not answered yet replayed on top.
  const apply = useCallback(
    (ops: TimelineOp[]) => {
      if (!projectId || ops.length === 0) return;
      try {
        useProject.getState().applyLocalOps(ops);
      } catch (err) {
        reportError(err);
        return;
      }
      enqueue(async () => {
        try {
          const r = await api.applyOps(projectId, ops);
          useProject.getState().confirmEdit(projectId, r.timeline);
          setHistory((h) => recordEdit(h, r.commit));
        } catch (err) {
          useProject.getState().rejectEdit(projectId);
          reportError(err);
        }
      });
    },
    [projectId, setHistory, enqueue],
  );
  const previewSize = useMemo(() => {
    if (!timeline) return { width: 640, height: 360 };
    const scale = Math.min(1, 960 / timeline.width);
    return {
      width: Math.round((timeline.width * scale) / 2) * 2,
      height: Math.round((timeline.height * scale) / 2) * 2,
    };
  }, [timeline?.width, timeline?.height]);

  useEffect(() => {
    if (!projectId || !canvasRef.current || !preview || !webcodecs) return;
    // Heavy originals preview from editing proxies (docs/design/engine-performance.md#local-proxies-made-with-webcodecs)
    const pool = new MediaPool(projectId, previewSize, { editingProxies: true, fetchFn: previewFetch });
    const player = new Player(canvasRef.current, pool, preview);
    player.onTime = setTime;
    player.onPlaying = setPlaying;
    playerRef.current = player;
    void player.draw();
    // ...and composite on the GPU once the tab's WebGPU renderer is ready (docs/design/engine-performance.md#webgpu-compositing)
    void gpuRenderer().then((gpu) => {
      useEngine.setState({ compositor: gpu ? 'webgpu' : 'canvas' });
      if (gpu && playerRef.current === player) player.setGpu(gpu);
    });
    return () => {
      player.dispose();
      pool.dispose();
      playerRef.current = null;
    };
  }, [projectId, previewSize.width, previewSize.height, webcodecs]);

  useEffect(() => {
    if (preview) playerRef.current?.setTimeline(preview);
  }, [preview]);

  useEffect(() => {
    if (!projectId || !webcodecs) return;
    // The lanes read three media requests at a time, so a long cut leaves room for the API and job heartbeats
    const pool = new MediaPool(projectId, { width: 160, height: 90 }, { fetchFn: laneFetch });
    setLanePool(pool);
    return () => {
      pool.dispose();
      setLanePool(null);
    };
  }, [projectId, webcodecs]);

  useEffect(() => {
    if (!playerCommand || !playerRef.current) return;
    const p = playerRef.current;
    if (playerCommand.action === 'play')
      void (playerCommand.time !== undefined ? p.seek(playerCommand.time).then(() => p.play()) : p.play());
    else if (playerCommand.action === 'pause') p.pause();
    else void p.seek(playerCommand.time ?? 0);
  }, [playerCommand]);

  // At load the last timeline change can be undone (docs/design/editing-tools.md#undo-and-redo)
  useEffect(() => {
    if (!projectId || loading || seededFor.current === projectId) return;
    seededFor.current = projectId;
    setHistory(() => seedHistory(commits));
  }, [projectId, loading, commits, setHistory]);

  const stopReverse = useCallback(() => {
    if (reverse.current) clearInterval(reverse.current);
    reverse.current = null;
  }, []);
  useEffect(() => stopReverse, [stopReverse]);

  const selectedItem = timeline?.tracks.flatMap((t) => t.items).find((i) => i.id === selected) ?? null;
  const marker = timeline?.markers?.find((m) => m.id === selectedMarker) ?? null;
  const access = useProjectRole(docs?.project);
  const canEdit = access.can('project.edit');

  const seek = useCallback((t: number) => {
    const at = Math.max(0, t);
    setTime(at);
    void playerRef.current?.seek(at);
  }, []);

  /**
   * Undo and redo restore the timeline from a commit (a new commit; docs/design/editing-tools.md#undo-and-redo), once
   * the edits made before them are answered.
   */
  const step = useCallback(
    (dir: 'undo' | 'redo') => {
      enqueue(async () => {
        const h = historyRef.current;
        const target = dir === 'undo' ? undoTarget(h) : redoTarget(h);
        if (!projectId || !target) return;
        try {
          const restored = await api.restore(projectId, target, ['timeline.json']);
          setHistory((x) =>
            dir === 'undo' ? undone(x, restored?.id ?? null) : redone(x, restored?.id ?? null),
          );
          const next = await api.timeline(projectId).catch(() => null);
          if (next) useProject.getState().confirmTimeline(next);
        } catch (err) {
          reportError(err);
        }
      });
    },
    [projectId, setHistory, enqueue],
  );
  const history = historyRef.current;

  /** Every editing action, from the keys, the context menu and the buttons (docs/design/editing-tools.md#shortcuts). */
  const run = useCallback(
    (action: EditorAction, at?: { time?: number; itemId?: string; trackId?: string }) => {
      if (!timeline) return;
      const p = playerRef.current;
      const fps = timeline.fps;
      const duration = timelineDuration(timeline);
      const playhead = at?.time ?? time;
      const itemId = at?.itemId ?? selected;
      const found = itemId ? findItem(timeline, itemId) : null;
      if (action !== 'reverse') stopReverse();
      switch (action) {
        case 'playPause':
          if (p?.playing) p.pause();
          else void p?.play();
          return;
        case 'pause':
          p?.pause();
          return;
        case 'play':
          void p?.play();
          return;
        case 'reverse':
          // Backwards in tenths of a second until K, L or Space
          p?.pause();
          if (reverse.current) return;
          reverse.current = setInterval(() => {
            const now = playerRef.current?.time ?? 0;
            if (now <= 0) stopReverse();
            else seek(now - 0.1);
          }, 100);
          return;
        case 'frameBack':
        case 'frameForward':
          seek(time + (action === 'frameForward' ? 1 : -1) / fps);
          return;
        case 'secondBack':
        case 'secondForward':
          seek(time + (action === 'secondForward' ? 1 : -1));
          return;
        case 'previousEdit': {
          const t = previousEditPoint(timeline, time);
          if (t !== null) seek(t);
          return;
        }
        case 'nextEdit': {
          const t = nextEditPoint(timeline, time);
          if (t !== null) seek(t);
          return;
        }
        case 'start':
          seek(0);
          return;
        case 'end':
          seek(duration);
          return;
        case 'split': {
          const target = splitTarget(timeline, itemId, playhead);
          if (target) apply([{ op: 'split', itemId: target.id, at: playhead }]);
          return;
        }
        case 'delete':
          if (found && !found.track.locked) {
            apply([{ op: 'remove', itemId: found.item.id }]);
            setSelected(null);
          } else if (!found && selectedMarker) {
            apply([{ op: 'remove_marker', markerId: selectedMarker }]);
            setSelectedMarker(null);
          }
          return;
        case 'copy':
        case 'cut':
          if (!found) return;
          clipboard.current = { item: structuredClone(found.item), trackId: found.track.id };
          if (action === 'cut' && !found.track.locked) {
            apply([{ op: 'remove', itemId: found.item.id }]);
            setSelected(null);
          }
          return;
        case 'paste':
          if (clipboard.current) apply(pasteOps(timeline, clipboard.current, playhead));
          return;
        case 'duplicate':
          if (found && !found.track.locked) apply([{ op: 'duplicate', itemId: found.item.id }]);
          return;
        case 'undo':
        case 'redo':
          step(action);
          return;
        case 'addMarker': {
          const id = newId('marker');
          apply([{ op: 'add_marker', marker: { id, t: Math.round(playhead * 1000) / 1000 } }]);
          setSelectedMarker(id);
          setSelected(null);
          return;
        }
        case 'nextMarker':
        case 'previousMarker': {
          const ms = timeline.markers ?? [];
          const m =
            action === 'nextMarker'
              ? ms.find((x) => x.t > time + 0.01)
              : [...ms].reverse().find((x) => x.t < time - 0.01);
          if (m) {
            seek(m.t);
            setSelectedMarker(m.id);
            setSelected(null);
          }
          return;
        }
        case 'snap':
          setSnapping(!snapping);
          return;
        case 'zoomIn':
          setZoom((z) => Math.min(320, Math.round(z * 1.25)));
          return;
        case 'zoomOut':
          setZoom((z) => Math.max(4, Math.round(z / 1.25)));
          return;
        case 'zoomFit': {
          const w = scrollRef.current?.clientWidth ?? 800;
          setZoom(Math.max(4, Math.min(320, Math.floor((w - 8) / Math.max(duration, 1)))));
          return;
        }
        case 'nudgeBack':
        case 'nudgeForward':
          if (found) apply(nudgeOps(timeline, found.item.id, action === 'nudgeForward' ? 1 : -1));
          return;
        case 'deselect':
          setSelected(null);
          setSelectedMarker(null);
          setMenu(null);
          return;
        case 'help':
          setShortcutsOpen(true);
          return;
      }
    },
    [timeline, time, selected, selectedMarker, snapping, apply, seek, step, stopReverse, setSnapping],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (typing(e.target) || shortcutsOpen || exportOpen || overlayOpen) return;
      const action = actionFor(e);
      if (!action) return;
      if (
        !canEdit &&
        [
          'split',
          'delete',
          'cut',
          'paste',
          'duplicate',
          'undo',
          'redo',
          'addMarker',
          'nudgeBack',
          'nudgeForward',
        ].includes(action)
      )
        return;
      e.preventDefault();
      run(action);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [run, canEdit, shortcutsOpen, exportOpen, overlayOpen]);

  /** The right-click menu of an item or of an empty part of a lane (docs/design/editing-tools.md#context-menu). */
  const openMenu = useCallback(
    (at: { x: number; y: number }, target: LaneTarget) => {
      if (!timeline) return;
      const found = target.itemId ? findItem(timeline, target.itemId) : null;
      const go =
        (action: EditorAction, extra: { time?: number } = {}) =>
        () =>
          run(action, { itemId: target.itemId, trackId: target.trackId, ...extra });
      let entries: MenuEntry[];
      if (found) {
        const item = found.item;
        const locked = !!found.track.locked || !canEdit;
        const video = item.kind === 'video' ? item : null;
        const inside = time > item.start + 0.05 && time < itemEnd(item) - 0.05;
        entries = [
          {
            label: 'Split at playhead',
            action: 'split',
            onSelect: go('split'),
            disabled: locked || !inside,
            testid: 'menu-split',
          },
          {
            label: 'Duplicate',
            action: 'duplicate',
            onSelect: go('duplicate'),
            disabled: locked,
            testid: 'menu-duplicate',
          },
          { label: 'Copy', action: 'copy', onSelect: go('copy'), testid: 'menu-copy' },
          { label: 'Cut', action: 'cut', onSelect: go('cut'), disabled: locked, testid: 'menu-cut' },
        ];
        if (video)
          entries.push(
            {
              label: 'Freeze frame',
              onSelect: () =>
                apply([
                  {
                    op: 'freeze_frame',
                    itemId: video.id,
                    at: Math.min(Math.max(time, video.start), itemEnd(video)),
                  },
                ]),
              disabled: locked || !!video.freeze || isStillMedia(video.source.media),
              testid: 'menu-freeze',
            },
            {
              label: 'Detach audio',
              onSelect: () => apply([{ op: 'detach_audio', itemId: video.id }]),
              disabled:
                locked ||
                video.muted ||
                !!video.freeze ||
                !!video.ramp ||
                video.speed !== 1 ||
                video.source.media.hasAudio === false ||
                isStillMedia(video.source.media),
              testid: 'menu-detach',
            },
            {
              label: video.flip?.x ? 'Unmirror' : 'Mirror',
              onSelect: () =>
                apply([{ op: 'set_flip', itemId: video.id, flip: { ...video.flip, x: !video.flip?.x } }]),
              disabled: locked,
              testid: 'menu-mirror',
            },
          );
        entries.push({
          label: 'Delete',
          action: 'delete',
          onSelect: go('delete'),
          disabled: locked,
          danger: true,
          testid: 'menu-delete',
        });
      } else {
        entries = [
          {
            label: 'Paste',
            action: 'paste',
            onSelect: () => {
              seek(target.time);
              run('paste', { time: target.time });
            },
            disabled: !clipboard.current || !canEdit,
            testid: 'menu-paste',
          },
          {
            label: 'Add marker',
            action: 'addMarker',
            onSelect: () => run('addMarker', { time: target.time }),
            disabled: !canEdit,
            testid: 'menu-marker',
          },
        ];
      }
      setMenu({ at, entries });
    },
    [timeline, time, canEdit, run, apply, seek],
  );

  if (!docs || !projectId || !timeline) return null;
  const duration = timelineDuration(timeline);
  const primary = primaryTrack(timeline);
  const exportJobs = Object.values(jobs).filter(
    (j) =>
      (j.kind === 'export.render' ||
        j.kind === 'export.finish' ||
        j.kind === 'timeline.assemble' ||
        j.kind === 'edit.auto') &&
      !isTerminalJob(j),
  );
  const addTitle = () =>
    apply([
      {
        op: 'add_text',
        item: {
          kind: 'text',
          start: Math.max(0, time),
          duration: 3,
          text: docs.screenplay?.title ?? docs.project.title,
          style: { preset: 'title' },
        },
      },
    ]);
  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <SectionHeader
        title="Editor"
        subtitle={
          <>
            {`${formatDuration(duration)} · ${timeline.width}×${timeline.height} @ ${timeline.fps} fps`}
            {pendingEdits > 0 ? (
              <span data-testid="edits-pending" aria-live="polite">
                {` · Saving ${pendingEdits === 1 ? '1 edit' : `${pendingEdits} edits`}…`}
              </span>
            ) : null}
          </>
        }
        actions={
          <>
            {docs.project.kind === 'story' ? (
              <Button
                icon={<Clapperboard className="size-4" />}
                onClick={() => api.assemble(projectId, { captions: true }).catch(reportError)}
                data-testid="assemble"
              >
                Assemble from approved clips
              </Button>
            ) : null}
            <Button icon={<Type className="size-4" />} onClick={addTitle} data-testid="add-title">
              Title
            </Button>
            <Button
              icon={<Layers className="size-4" />}
              disabled={!canEdit}
              onClick={() => setOverlayOpen(true)}
              data-testid="overlay-open"
            >
              Overlay
            </Button>
            <BrandTools brand={docs.project.settings.brand} time={time} apply={apply} />
            <Button
              icon={<Undo2 className="size-4" />}
              disabled={!(undoTarget(history) || pendingEdits > 0) || !canEdit}
              onClick={() => step('undo')}
              title="Undo (Ctrl/⌘+Z)"
              data-testid="undo"
            >
              Undo
            </Button>
            <Button
              icon={<Redo2 className="size-4" />}
              disabled={!redoTarget(history) || pendingEdits > 0 || !canEdit}
              onClick={() => step('redo')}
              title="Redo (Ctrl/⌘+Shift+Z)"
              data-testid="redo"
            >
              Redo
            </Button>
            <Button
              variant="primary"
              icon={<Download className="size-4" />}
              disabled={primary.items.length === 0 || !canEdit}
              onClick={() => setExportOpen(true)}
              data-testid="open-export"
            >
              Export
            </Button>
          </>
        }
      />
      {exportJobs.map((j) => (
        <JobRow key={j.id} job={j} projectId={projectId} />
      ))}
      <Card className="overflow-hidden">
        <div
          className="relative mx-auto bg-black"
          style={{ aspectRatio: `${timeline.width} / ${timeline.height}`, maxHeight: '56vh' }}
        >
          {webcodecs ? (
            <canvas
              ref={canvasRef}
              width={previewSize.width}
              height={previewSize.height}
              className="size-full"
              data-testid="preview-canvas"
            />
          ) : (
            <div className="flex size-full items-center justify-center p-4 text-center text-[13px] text-muted">
              WebCodecs is not available in this browser; use the server render to preview exports.
            </div>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2 border-t border-border px-3 py-2">
          <Button size="sm" variant="ghost" onClick={() => seek(0)} aria-label="Go to start">
            <SkipBack className="size-4" />
          </Button>
          <Button
            size="sm"
            variant="primary"
            onClick={() => (playing ? playerRef.current?.pause() : void playerRef.current?.play())}
            disabled={!webcodecs || duration === 0}
            aria-label={playing ? 'Pause' : 'Play'}
            data-testid="play-toggle"
          >
            {playing ? <Pause className="size-4" /> : <Play className="size-4" />}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => seek(duration)} aria-label="Go to end">
            <SkipForward className="size-4" />
          </Button>
          <span className="tabular font-mono text-[12px]" data-testid="timecode">
            {formatTimecode(time, timeline.fps)} / {formatTimecode(duration, timeline.fps)}
          </span>
          <input
            type="range"
            min={0}
            max={Math.max(duration, 0.01)}
            step={1 / timeline.fps}
            value={Math.min(time, duration)}
            onChange={(e) => seek(Number(e.target.value))}
            className="min-w-32 flex-1 accent-[var(--color-accent)]"
            aria-label="Seek"
          />
          <Badge tone={webcodecs ? 'success' : 'warning'}>{webcodecs ? 'WebCodecs' : 'no WebCodecs'}</Badge>
        </div>
      </Card>
      {primary.items.length === 0 ? (
        <EmptyState icon={<Wand2 className="size-8" />} title="The timeline is empty">
          {docs.project.kind === 'story'
            ? 'Approve clips, then assemble them here.'
            : 'Run the analysis and apply the suggestions to build an automatic edit.'}
        </EmptyState>
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
          <Card className="min-w-0 p-3">
            <div className="mb-2 flex flex-wrap items-center gap-1.5 text-[12px] text-muted">
              <Button
                size="sm"
                variant="ghost"
                className="h-7"
                icon={<Plus className="size-3.5" />}
                disabled={!canEdit}
                onClick={() =>
                  apply([
                    {
                      op: 'add_track',
                      track: {
                        id: newId('track'),
                        kind: 'video',
                        name: `Overlay ${timeline.tracks.filter((t) => t.kind === 'video').length}`,
                      },
                    },
                  ])
                }
                data-testid="add-video-track"
              >
                Video track
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-7"
                icon={<Flag className="size-3.5" />}
                disabled={!canEdit}
                onClick={() => run('addMarker')}
                title="Add a marker at the playhead (M)"
                data-testid="add-marker"
              >
                Marker
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className={cx('hidden h-7 md:inline-flex', snapping && PRESSED)}
                icon={<Magnet className="size-3.5" />}
                aria-pressed={snapping}
                onClick={() => setSnapping(!snapping)}
                title="Snapping (N)"
                data-testid="snap-toggle"
              >
                Snap
              </Button>
              <span className="ml-auto hidden items-center gap-1 md:flex">
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7"
                  onClick={() => run('zoomOut')}
                  aria-label="Zoom out"
                >
                  <ZoomOut className="size-3.5" />
                </Button>
                <input
                  type="range"
                  min={4}
                  max={320}
                  value={zoom}
                  onChange={(e) => setZoom(Number(e.target.value))}
                  aria-label="Zoom"
                  className="w-28 accent-[var(--color-accent)]"
                />
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7"
                  onClick={() => run('zoomIn')}
                  aria-label="Zoom in"
                >
                  <ZoomIn className="size-3.5" />
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7"
                  onClick={() => run('zoomFit')}
                  aria-label="Zoom to fit"
                  data-testid="zoom-fit"
                >
                  <Maximize2 className="size-3.5" />
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7"
                  onClick={() => setShortcutsOpen(true)}
                  aria-label="Keyboard shortcuts"
                  data-testid="shortcuts-open"
                >
                  <Keyboard className="size-3.5" />
                </Button>
              </span>
            </div>
            <TimelineLanes
              timeline={timeline}
              zoom={zoom}
              time={time}
              duration={duration}
              seek={seek}
              selected={selected}
              onSelect={setSelected}
              selectedMarker={selectedMarker}
              onSelectMarker={setSelectedMarker}
              apply={apply}
              snapping={snapping}
              lanePool={lanePool}
              canEdit={canEdit}
              onContextMenu={openMenu}
              scrollRef={scrollRef}
            />
            <ul className="space-y-1.5 md:hidden" data-testid="timeline-list-overlays">
              {timeline.tracks
                .filter((t) => isOverlayTrack(timeline, t))
                .flatMap((t) => t.items)
                .map((item) => (
                  <li key={item.id}>
                    <button
                      type="button"
                      onClick={() => {
                        setSelected(item.id);
                        setSelectedMarker(null);
                      }}
                      className={cx(
                        'flex w-full items-center gap-2 rounded border border-dashed border-info/60 px-2 py-2 text-left text-[13px]',
                        selected === item.id && 'border-accent',
                      )}
                      data-testid="overlay-item"
                    >
                      <Layers className="size-3.5 text-info" />
                      <span className="min-w-0 flex-1 truncate">{itemLabel(item)}</span>
                      <span className="tabular text-[12px] text-muted">at {formatDuration(item.start)}</span>
                    </button>
                  </li>
                ))}
            </ul>
            <ul className="space-y-1.5 md:hidden" data-testid="timeline-list">
              {primary.items.map((item, i) => (
                <li key={item.id}>
                  <button
                    type="button"
                    onClick={() => {
                      setSelected(item.id);
                      setSelectedMarker(null);
                    }}
                    className={cx(
                      'flex w-full items-center gap-2 rounded border border-border px-2 py-2 text-left text-[13px]',
                      selected === item.id && 'border-accent',
                    )}
                  >
                    <span className="tabular text-muted">{i + 1}.</span>
                    {item.kind === 'video' && item.freeze ? <span className="text-info">❄</span> : null}
                    <span className="min-w-0 flex-1 truncate">{itemLabel(item)}</span>
                    <span className="tabular text-[12px] text-muted">
                      {formatDuration(itemDuration(item))}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </Card>
          <div className="min-w-0 space-y-4">
            <Card className="p-3">
              {selectedItem ? (
                <Inspector
                  item={selectedItem}
                  timeline={timeline}
                  apply={apply}
                  time={time}
                  onDuplicate={() => run('duplicate')}
                />
              ) : marker ? (
                <MarkerInspector
                  marker={marker}
                  apply={apply}
                  seek={seek}
                  onDone={() => setSelectedMarker(null)}
                />
              ) : (
                <div className="text-[13px] text-muted">
                  Select an item to trim, split, reorder, change speed, fades, transitions or color.
                  <Button
                    size="sm"
                    className="mt-3"
                    icon={<Plus className="size-3.5" />}
                    onClick={() => setSelected((primary.items[0] as VideoItem | undefined)?.id ?? null)}
                  >
                    Select first item
                  </Button>
                </div>
              )}
            </Card>
            <Card className="p-3 md:hidden">
              <MarkersCard
                markers={timeline.markers ?? []}
                selected={selectedMarker}
                onSelect={(id) => {
                  setSelectedMarker(id);
                  setSelected(null);
                }}
                onAdd={() => run('addMarker')}
                seek={seek}
              />
            </Card>
            <MixPanel timeline={timeline} apply={apply} />
            <LocalizationPanel timeline={timeline} apply={apply} />
            <TranscriptPanel timeline={timeline} apply={apply} />
          </div>
        </div>
      )}
      {menu ? <ContextMenu at={menu.at} entries={menu.entries} onClose={() => setMenu(null)} /> : null}
      <ShortcutsDialog open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
      <OverlayPicker
        open={overlayOpen}
        onClose={() => setOverlayOpen(false)}
        timeline={timeline}
        time={time}
        apply={apply}
      />
      <ExportDialog
        open={exportOpen}
        onClose={() => setExportOpen(false)}
        timeline={timeline}
        projectId={projectId}
        brand={docs.project.settings.brand}
      />
    </div>
  );
}
