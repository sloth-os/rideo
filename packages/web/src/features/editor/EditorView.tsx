import {
  disclosureFor,
  type ExportQuality,
  emptyTimeline,
  formatDuration,
  formatTimecode,
  type Item,
  isTerminalJob,
  itemDuration,
  itemEnd,
  primaryTrack,
  type RenderEngineChoice,
  type TextItem,
  type Timeline,
  type TimelineOp,
  type TransitionType,
  timelineDuration,
  type VideoItem,
  withDisclosure,
} from '@rideo/shared';
import {
  Clapperboard,
  Cpu,
  Download,
  Pause,
  Play,
  Plus,
  Scissors,
  SkipBack,
  SkipForward,
  Trash2,
  Type,
  Undo2,
  Wand2,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Entity } from '../../components/Entity';
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
  Progress,
  SectionHeader,
  Select,
} from '../../components/ui';
import { useEngine } from '../../engine/state';
import { api } from '../../lib/api';
import { useProject } from '../../store/project';
import { reportError, useUi } from '../../store/ui';
import { detectCaps, type EngineCaps } from './engine/capabilities';
import { MediaPool } from './engine/media-pool';
import { Player } from './engine/player';
import { GenerativeExtend } from './GenerativeExtend';
import { trimOps } from './trim';

const TRACK_COLORS = {
  video: 'bg-accent/25 border-accent/60',
  audio: 'bg-success/20 border-success/50',
  text: 'bg-info/20 border-info/50',
};

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

function itemLabel(item: Item): string {
  if (item.kind === 'text') return item.text;
  return (
    item.label ??
    (item.source.type === 'take' ? 'take' : (item.source.media.path.split('/').pop() ?? 'media'))
  );
}

function TrimHandle({
  side,
  zoom,
  onCommit,
  active,
}: {
  side: 'start' | 'end';
  zoom: number;
  onCommit: (deltaSec: number) => void;
  active: { current: boolean };
}) {
  const [drag, setDrag] = useState<{ x: number; dx: number } | null>(null);
  return (
    <span
      aria-hidden
      className={cx(
        'absolute inset-y-0 z-10 w-1.5 cursor-ew-resize rounded-sm hover:bg-accent/70',
        side === 'start' ? 'left-0' : 'right-0',
        drag && 'bg-accent',
      )}
      style={drag ? { transform: `translateX(${drag.dx}px)` } : undefined}
      onPointerDown={(e) => {
        e.stopPropagation();
        active.current = true;
        e.currentTarget.setPointerCapture(e.pointerId);
        setDrag({ x: e.clientX, dx: 0 });
      }}
      onPointerMove={(e) => {
        if (drag) setDrag({ ...drag, dx: e.clientX - drag.x });
      }}
      onPointerUp={(e) => {
        active.current = false;
        if (!drag) return;
        const dx = e.clientX - drag.x;
        setDrag(null);
        if (Math.abs(dx) > 2) onCommit(dx / zoom);
      }}
      onPointerCancel={() => {
        active.current = false;
        setDrag(null);
      }}
      onClick={(e) => e.stopPropagation()}
      data-testid={`trim-handle-${side}`}
    />
  );
}

function Inspector({
  item,
  timeline,
  apply,
  time,
}: {
  item: Item;
  timeline: Timeline;
  apply: (ops: TimelineOp[]) => void;
  time: number;
}) {
  const primary = primaryTrack(timeline);
  const index = primary.items.findIndex((i) => i.id === item.id);
  const num = (v: string) => Number.parseFloat(v);
  return (
    <div className="space-y-3" data-testid="inspector">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="accent">{item.kind}</Badge>
        <span className="min-w-0 flex-1 truncate text-[13px]">{itemLabel(item)}</span>
      </div>
      {item.kind !== 'text' ? (
        <div className="grid grid-cols-2 gap-2">
          <Field label="In (s)">
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
      {item.kind === 'video' && index >= 0 ? <GenerativeExtend item={item} /> : null}
      {item.kind === 'video' ? (
        <>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Speed">
              <Select
                value={item.speed}
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
                              type: e.target.value as TransitionType,
                              duration: item.transitionIn?.duration ?? 0.5,
                            }
                          : null,
                      },
                    ])
                  }
                  data-testid="transition-select"
                >
                  <option value="">Cut</option>
                  <option value="crossfade">Crossfade</option>
                  <option value="wipe">Wipe</option>
                  <option value="dip_to_black">Dip to black</option>
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
}: {
  open: boolean;
  onClose: () => void;
  timeline: Timeline;
  projectId: string;
}) {
  const [quality, setQuality] = useState<ExportQuality>('standard');
  const [engine, setEngine] = useState<RenderEngineChoice>('auto');
  const [caps, setCaps] = useState<EngineCaps | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [queued, setQueued] = useState<{ exportId: string; jobId: string } | null>(null);
  const job = useProject((s) => (queued ? s.jobs[queued.jobId] : undefined));
  const exp = useProject((s) => (queued ? s.docs?.exports[queued.exportId] : undefined));
  const here = useEngine((s) => (queued && s.busy?.jobId === queued.jobId ? s.busy : null));
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
      const r = await api.createExport(projectId, { quality, engine });
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
  const playerCommand = useProject((s) => s.playerCommand);
  const timeline = useTimeline();
  // The preview shows the export's disclosure label (docs/design/provenance.md#disclosure-label).
  const preview = useMemo(() => {
    if (!timeline || !docs) return timeline;
    const d = disclosureFor(docs, timeline);
    return withDisclosure(timeline, d.label ? { text: d.text, position: d.position } : null);
  }, [timeline, docs]);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const playerRef = useRef<Player | null>(null);
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [zoom, setZoom] = useState(40);
  const [exportOpen, setExportOpen] = useState(false);
  const trimming = useRef(false);
  const [webcodecs] = useState(() => typeof globalThis.VideoDecoder !== 'undefined');
  // Optimistic: the shared reducer updates the timeline at once; the server's result is authoritative.
  const apply = useCallback(
    (ops: TimelineOp[]) => {
      if (!projectId) return;
      let rollback: () => void;
      try {
        rollback = useProject.getState().applyLocalOps(ops);
      } catch (err) {
        reportError(err);
        return;
      }
      api
        .applyOps(projectId, ops)
        .then((r) => useProject.getState().confirmTimeline(r.timeline))
        .catch((err) => {
          rollback();
          reportError(err);
        });
    },
    [projectId],
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
    const pool = new MediaPool(projectId, previewSize);
    const player = new Player(canvasRef.current, pool, preview);
    player.onTime = setTime;
    player.onPlaying = setPlaying;
    playerRef.current = player;
    void player.draw();
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
    if (!playerCommand || !playerRef.current) return;
    const p = playerRef.current;
    if (playerCommand.action === 'play')
      void (playerCommand.time !== undefined ? p.seek(playerCommand.time).then(() => p.play()) : p.play());
    else if (playerCommand.action === 'pause') p.pause();
    else void p.seek(playerCommand.time ?? 0);
  }, [playerCommand]);

  const selectedItem = timeline?.tracks.flatMap((t) => t.items).find((i) => i.id === selected) ?? null;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      const p = playerRef.current;
      if (e.key === ' ') {
        e.preventDefault();
        if (p?.playing) p.pause();
        else void p?.play();
      } else if (
        (e.key === 's' || e.key === 'S') &&
        selectedItem &&
        time > selectedItem.start &&
        time < itemEnd(selectedItem)
      ) {
        apply([{ op: 'split', itemId: selectedItem.id, at: time }]);
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && selectedItem) {
        apply([{ op: 'remove', itemId: selectedItem.id }]);
        setSelected(null);
      } else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        const step = 1 / (timeline?.fps ?? 24);
        void p?.seek(time + (e.key === 'ArrowRight' ? step : -step));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedItem, time, apply, timeline?.fps]);

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
  const lastTimelineCommits = commits.filter((c) => c.changes.some((ch) => ch.path === 'timeline.json'));
  const undo = () => {
    const prev =
      lastTimelineCommits[1] ??
      (lastTimelineCommits[0]?.parents[0] ? { id: lastTimelineCommits[0].parents[0] } : null);
    if (!prev) return;
    api.restore(projectId, prev.id, ['timeline.json']).catch(reportError);
  };
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
  const seek = (t: number) => {
    setTime(t);
    void playerRef.current?.seek(t);
  };
  const width = Math.max(duration, 10) * zoom;
  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <SectionHeader
        title="Editor"
        subtitle={`${formatDuration(duration)} · ${timeline.width}×${timeline.height} @ ${timeline.fps} fps`}
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
              icon={<Undo2 className="size-4" />}
              disabled={lastTimelineCommits.length === 0}
              onClick={undo}
              data-testid="undo"
            >
              Undo
            </Button>
            <Button
              variant="primary"
              icon={<Download className="size-4" />}
              disabled={primary.items.length === 0}
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
            <div className="mb-2 flex items-center gap-2 text-[12px] text-muted">
              Zoom
              <input
                type="range"
                min={10}
                max={160}
                value={zoom}
                onChange={(e) => setZoom(Number(e.target.value))}
                aria-label="Zoom"
                className="w-32 accent-[var(--color-accent)]"
              />
            </div>
            <div className="hidden overflow-x-auto md:block" data-testid="timeline">
              <div className="relative" style={{ width }}>
                <div
                  className="relative mb-1 h-5 cursor-pointer border-b border-border"
                  onClick={(e) => {
                    const r = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
                    seek((e.clientX - r.left) / zoom);
                  }}
                >
                  {Array.from({ length: Math.ceil(Math.max(duration, 10) / 5) + 1 }, (_, i) => (
                    <span
                      key={i}
                      className="tabular absolute top-0 text-[10px] text-muted"
                      style={{ left: i * 5 * zoom }}
                    >
                      {formatDuration(i * 5)}
                    </span>
                  ))}
                </div>
                {timeline.tracks.map((track) => (
                  <div
                    key={track.id}
                    className="relative mb-1 h-12 rounded bg-surface-2"
                    data-track={track.kind}
                    data-track-name={track.name}
                    title={track.name}
                  >
                    {track.items.map((item) => (
                      <Entity
                        key={item.id}
                        kind="timeline-item"
                        id={item.id}
                        className="absolute top-1 bottom-1"
                      >
                        <button
                          type="button"
                          draggable={track.id === primary.id}
                          onDragStart={(e) => {
                            if (trimming.current) e.preventDefault();
                            else e.dataTransfer.setData('text/plain', item.id);
                          }}
                          onDragOver={(e) => e.preventDefault()}
                          onDrop={(e) => {
                            e.preventDefault();
                            const dragged = e.dataTransfer.getData('text/plain');
                            const to = primary.items.findIndex((i) => i.id === item.id);
                            if (dragged && dragged !== item.id && to >= 0)
                              apply([{ op: 'move', itemId: dragged, index: to }]);
                          }}
                          onClick={() => setSelected(item.id)}
                          className={cx(
                            'absolute inset-y-0 overflow-hidden rounded border px-1.5 text-left text-[11px] whitespace-nowrap',
                            TRACK_COLORS[track.kind],
                            selected === item.id && 'ring-2 ring-accent',
                          )}
                          style={{ left: item.start * zoom, width: Math.max(8, itemDuration(item) * zoom) }}
                          data-testid="timeline-item"
                          title={itemLabel(item)}
                        >
                          {item.kind === 'video' && item.transitionIn ? (
                            <span className="mr-1 text-accent">⤫</span>
                          ) : null}
                          {itemLabel(item)}
                          {(['start', 'end'] as const).map((side) => (
                            <TrimHandle
                              key={side}
                              side={side}
                              zoom={zoom}
                              active={trimming}
                              onCommit={(delta) => apply(trimOps(item, side, delta, track.id !== primary.id))}
                            />
                          ))}
                        </button>
                      </Entity>
                    ))}
                  </div>
                ))}
                <div
                  className="pointer-events-none absolute top-0 bottom-0 w-0.5 bg-accent"
                  style={{ left: Math.min(time, duration) * zoom }}
                  data-testid="playhead"
                />
              </div>
            </div>
            <ul className="space-y-1.5 md:hidden" data-testid="timeline-list">
              {primary.items.map((item, i) => (
                <li key={item.id}>
                  <button
                    type="button"
                    onClick={() => setSelected(item.id)}
                    className={cx(
                      'flex w-full items-center gap-2 rounded border border-border px-2 py-2 text-left text-[13px]',
                      selected === item.id && 'border-accent',
                    )}
                  >
                    <span className="tabular text-muted">{i + 1}.</span>
                    <span className="min-w-0 flex-1 truncate">{itemLabel(item)}</span>
                    <span className="tabular text-[12px] text-muted">
                      {formatDuration(itemDuration(item))}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </Card>
          <Card className="p-3">
            {selectedItem ? (
              <Inspector item={selectedItem} timeline={timeline} apply={apply} time={time} />
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
        </div>
      )}
      <ExportDialog
        open={exportOpen}
        onClose={() => setExportOpen(false)}
        timeline={timeline}
        projectId={projectId}
      />
    </div>
  );
}
