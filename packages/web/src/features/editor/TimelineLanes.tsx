import {
  formatDuration,
  type Item,
  itemDuration,
  itemEnd,
  primaryTrack,
  type SnapTarget,
  snapSpan,
  snapTargets,
  snapTime,
  type Timeline,
  type TimelineOp,
  type Track,
  trackRole,
  type VideoItem,
} from '@rideo/shared';
import { Eye, EyeOff, Lock, LockOpen, Volume2, VolumeX } from 'lucide-react';
import { type PointerEvent as ReactPointerEvent, type RefObject, useRef, useState } from 'react';
import { Entity } from '../../components/Entity';
import { cx } from '../../components/ui';
import { dropOps, dropTargets } from './actions';
import { MARKER_HEX } from './ClipTools';
import type { MediaPool } from './engine/media-pool';
import { Filmstrip, Waveform } from './LaneMedia';
import { trimOps } from './trim';

const TRACK_COLORS = {
  video: 'bg-accent/25 border-accent/60',
  audio: 'bg-success/20 border-success/50',
  text: 'bg-info/20 border-info/50',
};

/** Snapping reaches this far on screen (docs/design/editing-tools.md#snapping). */
export const SNAP_PX = 8;
/** Seconds between the ruler's ticks at a zoom (pixels per second): at least 56 px apart. */
export function tickStep(zoom: number): number {
  return [1, 2, 5, 10, 30, 60].find((s) => s * zoom >= 56) ?? 60;
}

export function itemLabel(item: Item): string {
  if (item.kind === 'text') return item.text;
  return (
    item.label ??
    (item.source.type === 'take' ? 'take' : (item.source.media.path.split('/').pop() ?? 'media'))
  );
}

const LOCKED_STRIPES = 'repeating-linear-gradient(135deg, transparent 0 6px, rgb(0 0 0 / 0.28) 6px 12px)';

/**
 * Where something being dragged lands: snapped to a target when snapping is on. The playhead is a target except for
 * the playhead itself (a scrub would stick to where it is).
 */
type Snap = (
  t: number,
  exclude?: { items?: string[]; marker?: string; playhead?: boolean },
) => { t: number; target: SnapTarget | null };

function TrimHandle({
  side,
  edge,
  zoom,
  snap,
  onCommit,
  onGuide,
  active,
}: {
  side: 'start' | 'end';
  /** The edge's timeline time. */
  edge: number;
  zoom: number;
  snap: (t: number) => { t: number; target: SnapTarget | null };
  onCommit: (deltaSec: number) => void;
  onGuide: (t: number | null) => void;
  active: { current: boolean };
}) {
  const [drag, setDrag] = useState<{ x: number; dx: number } | null>(null);
  const delta = (clientX: number, x0: number) => {
    const s = snap(edge + (clientX - x0) / zoom);
    onGuide(s.target ? s.t : null);
    return s.t - edge;
  };
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
        if (drag) setDrag({ ...drag, dx: delta(e.clientX, drag.x) * zoom });
      }}
      onPointerUp={(e) => {
        active.current = false;
        onGuide(null);
        if (!drag) return;
        const moved = Math.abs(e.clientX - drag.x) > 2;
        const d = delta(e.clientX, drag.x);
        onGuide(null);
        setDrag(null);
        if (moved && Math.abs(d) > 1e-4) onCommit(d);
      }}
      onPointerCancel={() => {
        active.current = false;
        onGuide(null);
        setDrag(null);
      }}
      onClick={(e) => e.stopPropagation()}
      data-testid={`trim-handle-${side}`}
    />
  );
}

/** A lane's header: its name, and the eye, speaker and lock (docs/design/editing-tools.md#track-controls). */
function TrackHeader({
  track,
  apply,
  canEdit,
}: {
  track: Track;
  apply: (ops: TimelineOp[]) => void;
  canEdit: boolean;
}) {
  const set = (patch: { muted?: boolean; hidden?: boolean; locked?: boolean }) =>
    apply([{ op: 'set_track', trackId: track.id, ...patch }]);
  const toggle =
    'grid size-6 place-items-center rounded text-muted hover:bg-surface hover:text-text disabled:opacity-40';
  return (
    <div
      className="mb-1 flex h-12 flex-col justify-center gap-0.5 rounded bg-surface-2 px-1.5"
      data-testid="track-header"
      data-track-id={track.id}
    >
      <span className="truncate px-0.5 text-[11px] leading-tight text-muted" title={track.name}>
        {track.name}
      </span>
      <span className="flex items-center gap-0.5">
        {track.kind === 'video' ? (
          <button
            type="button"
            className={toggle}
            disabled={!canEdit}
            aria-pressed={!!track.hidden}
            aria-label={track.hidden ? `Show ${track.name}` : `Hide ${track.name}`}
            title={track.hidden ? 'Hidden: not drawn' : 'Shown'}
            onClick={() => set({ hidden: !track.hidden })}
            data-testid="track-hide"
          >
            {track.hidden ? <EyeOff className="size-3.5 text-warning" /> : <Eye className="size-3.5" />}
          </button>
        ) : null}
        {track.kind !== 'text' ? (
          <button
            type="button"
            className={toggle}
            disabled={!canEdit}
            aria-pressed={!!track.muted}
            aria-label={track.muted ? `Unmute ${track.name}` : `Mute ${track.name}`}
            onClick={() => set({ muted: !track.muted })}
            data-testid="track-mute"
          >
            {track.muted ? <VolumeX className="size-3.5 text-warning" /> : <Volume2 className="size-3.5" />}
          </button>
        ) : null}
        <button
          type="button"
          className={toggle}
          disabled={!canEdit}
          aria-pressed={!!track.locked}
          aria-label={track.locked ? `Unlock ${track.name}` : `Lock ${track.name}`}
          onClick={() => set({ locked: !track.locked })}
          data-testid="track-lock"
        >
          {track.locked ? <Lock className="size-3.5 text-warning" /> : <LockOpen className="size-3.5" />}
        </button>
      </span>
    </div>
  );
}

export interface LaneTarget {
  trackId: string;
  time: number;
  itemId?: string;
}

/**
 * The desktop timeline (docs/design/editing-tools.md#the-workflow): the ruler with its ticks and markers, a header per
 * lane, items that drag in time and between tracks, edges that trim, snapping with its guide, and the playhead.
 */
export function TimelineLanes({
  timeline,
  zoom,
  time,
  duration,
  seek,
  selected,
  onSelect,
  selectedMarker,
  onSelectMarker,
  apply,
  snapping,
  lanePool,
  canEdit,
  onContextMenu,
  scrollRef,
}: {
  timeline: Timeline;
  zoom: number;
  time: number;
  duration: number;
  seek: (t: number) => void;
  selected: string | null;
  onSelect: (id: string | null) => void;
  selectedMarker: string | null;
  onSelectMarker: (id: string | null) => void;
  apply: (ops: TimelineOp[]) => void;
  snapping: boolean;
  lanePool: MediaPool | null;
  canEdit: boolean;
  onContextMenu: (at: { x: number; y: number }, target: LaneTarget) => void;
  scrollRef: RefObject<HTMLDivElement | null>;
}) {
  const primary = primaryTrack(timeline);
  const trimming = useRef(false);
  const lanes = useRef(new Map<string, HTMLDivElement>());
  const [guide, setGuide] = useState<number | null>(null);
  const [drag, setDrag] = useState<{
    itemId: string;
    from: string;
    x0: number;
    y0: number;
    start0: number;
    moved: boolean;
    start: number;
    trackId: string;
    rects: { id: string; top: number; bottom: number }[];
    targets: string[];
  } | null>(null);
  const [markerDrag, setMarkerDrag] = useState<{
    id: string;
    x0: number;
    t0: number;
    t: number;
    moved: boolean;
  } | null>(null);
  const width = Math.max(duration, 10) * zoom;
  const tolerance = SNAP_PX / zoom;
  const snap: Snap = (t, exclude = {}) => {
    const clamped = Math.max(0, t);
    if (!snapping) return { t: clamped, target: null };
    const targets = snapTargets(timeline, {
      exclude: exclude.items,
      playhead: exclude.playhead ? undefined : time,
    }).filter(
      (x) =>
        !(
          exclude.marker &&
          x.kind === 'marker' &&
          timeline.markers?.some((m) => m.id === exclude.marker && m.t === x.t)
        ),
    );
    const near = snapTime(clamped, targets, tolerance);
    const target = near !== clamped ? (targets.find((x) => x.t === near) ?? null) : null;
    return { t: near, target };
  };
  const timeAt = (e: { clientX: number }, el: HTMLElement) =>
    (e.clientX - el.getBoundingClientRect().left) / zoom;

  // Moving items with the pointer (docs/design/editing-tools.md#moving-items)
  const beginDrag = (e: ReactPointerEvent<HTMLButtonElement>, item: Item, track: Track) => {
    if (!canEdit || track.locked || e.button !== 0 || trimming.current) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const rects = [...lanes.current].map(([id, el]) => {
      const r = el.getBoundingClientRect();
      return { id, top: r.top, bottom: r.bottom };
    });
    setDrag({
      itemId: item.id,
      from: track.id,
      x0: e.clientX,
      y0: e.clientY,
      start0: item.start,
      moved: false,
      start: item.start,
      trackId: track.id,
      rects,
      targets: dropTargets(timeline, item.id),
    });
  };
  const moveDrag = (e: ReactPointerEvent, item: Item) => {
    if (!drag || drag.itemId !== item.id || trimming.current) return;
    const dx = e.clientX - drag.x0;
    const dy = e.clientY - drag.y0;
    if (!drag.moved && Math.abs(dx) < 4 && Math.abs(dy) < 4) return;
    const raw = Math.max(0, drag.start0 + dx / zoom);
    const len = itemDuration(item);
    let start = raw;
    let target: SnapTarget | null = null;
    if (snapping) {
      const targets = snapTargets(timeline, { exclude: [item.id], playhead: time });
      ({ start, target } = snapSpan(raw, len, targets, tolerance));
    }
    setGuide(target ? target.t : null);
    const over = drag.rects.find((r) => e.clientY >= r.top && e.clientY < r.bottom);
    const trackId = over && drag.targets.includes(over.id) ? over.id : drag.trackId;
    setDrag({ ...drag, moved: true, start, trackId });
  };
  const endDrag = (item: Item) => {
    if (!drag || drag.itemId !== item.id) return;
    setDrag(null);
    setGuide(null);
    if (drag.moved) apply(dropOps(timeline, item.id, drag.trackId, drag.start));
  };

  const ticks = tickStep(zoom);
  const markers = timeline.markers ?? [];
  return (
    <div className="hidden md:flex" data-testid="timeline">
      <div className="w-24 shrink-0 pr-1">
        <div className="mb-1 h-5" />
        {timeline.tracks.map((track) => (
          <TrackHeader key={track.id} track={track} apply={apply} canEdit={canEdit} />
        ))}
      </div>
      <div className="min-w-0 flex-1 overflow-x-auto" ref={scrollRef} data-testid="timeline-scroll">
        <div className="relative" style={{ width }}>
          {/* The ruler: drag to scrub (snapping), click a marker to go there, drag it to move it */}
          <div
            className="relative mb-1 h-5 cursor-pointer touch-none border-b border-border select-none"
            data-testid="ruler"
            onPointerDown={(e) => {
              if (e.button !== 0) return;
              e.currentTarget.setPointerCapture(e.pointerId);
              const s = snap(timeAt(e, e.currentTarget), { playhead: true });
              setGuide(s.target ? s.t : null);
              seek(s.t);
            }}
            onPointerMove={(e) => {
              if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
              const s = snap(timeAt(e, e.currentTarget), { playhead: true });
              setGuide(s.target ? s.t : null);
              seek(s.t);
            }}
            onPointerUp={() => setGuide(null)}
            onPointerCancel={() => setGuide(null)}
          >
            {Array.from({ length: Math.ceil(Math.max(duration, 10) / ticks) + 1 }, (_, i) => (
              <span
                key={i}
                className="tabular pointer-events-none absolute top-0 border-l border-border pl-0.5 text-[10px] text-muted"
                style={{ left: i * ticks * zoom }}
              >
                {formatDuration(i * ticks)}
              </span>
            ))}
            {markers.map((m) => {
              const t = markerDrag?.id === m.id ? markerDrag.t : m.t;
              return (
                <button
                  key={m.id}
                  type="button"
                  className={cx(
                    'absolute top-0 z-20 h-4 w-3 -translate-x-1/2 cursor-grab rounded-b-sm border border-black/30',
                    selectedMarker === m.id && 'ring-2 ring-text',
                  )}
                  style={{ left: t * zoom, background: MARKER_HEX[m.color] }}
                  title={m.label || 'Marker'}
                  aria-label={`Marker ${m.label || ''} at ${m.t.toFixed(2)} s`}
                  data-testid="marker"
                  data-marker={m.id}
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    if (e.button !== 0) return;
                    e.currentTarget.setPointerCapture(e.pointerId);
                    setMarkerDrag({ id: m.id, x0: e.clientX, t0: m.t, t: m.t, moved: false });
                  }}
                  onPointerMove={(e) => {
                    if (!markerDrag || markerDrag.id !== m.id || !canEdit) return;
                    const dx = e.clientX - markerDrag.x0;
                    if (!markerDrag.moved && Math.abs(dx) < 3) return;
                    const s = snap(markerDrag.t0 + dx / zoom, { marker: m.id });
                    setGuide(s.target ? s.t : null);
                    setMarkerDrag({ ...markerDrag, t: s.t, moved: true });
                  }}
                  onPointerUp={() => {
                    const d = markerDrag;
                    setMarkerDrag(null);
                    setGuide(null);
                    onSelectMarker(m.id);
                    onSelect(null);
                    if (d?.moved && Math.abs(d.t - m.t) > 1e-4)
                      apply([{ op: 'update_marker', markerId: m.id, t: Math.round(d.t * 1000) / 1000 }]);
                    else seek(m.t);
                  }}
                  onPointerCancel={() => {
                    setMarkerDrag(null);
                    setGuide(null);
                  }}
                />
              );
            })}
          </div>
          {timeline.tracks.map((track) => (
            <div
              key={track.id}
              ref={(el) => {
                if (el) lanes.current.set(track.id, el);
                else lanes.current.delete(track.id);
              }}
              className={cx(
                'relative mb-1 h-12 rounded bg-surface-2',
                drag?.moved && drag.trackId === track.id && drag.from !== track.id && 'ring-1 ring-accent',
              )}
              data-track={track.kind}
              data-track-id={track.id}
              data-track-name={track.name}
              data-track-role={trackRole(track) ?? undefined}
              data-locked={track.locked ? 'true' : undefined}
              data-hidden={track.hidden ? 'true' : undefined}
              title={track.kind === 'text' ? track.name : `${track.name} · ${trackRole(track)} stem`}
              onContextMenu={(e) => {
                if (e.target !== e.currentTarget) return;
                e.preventDefault();
                onContextMenu(
                  { x: e.clientX, y: e.clientY },
                  { trackId: track.id, time: timeAt(e, e.currentTarget) },
                );
              }}
            >
              {track.items.map((item) => {
                const dragging = drag?.itemId === item.id && drag.moved ? drag : null;
                const lift = dragging
                  ? {
                      x: (dragging.start - item.start) * zoom,
                      y:
                        (lanes.current.get(dragging.trackId)?.offsetTop ?? 0) -
                        (lanes.current.get(track.id)?.offsetTop ?? 0),
                    }
                  : null;
                const video = item.kind === 'video' ? (item as VideoItem) : null;
                return (
                  <Entity key={item.id} kind="timeline-item" id={item.id} className="absolute top-1 bottom-1">
                    <button
                      type="button"
                      onPointerDown={(e) => beginDrag(e, item, track)}
                      onPointerMove={(e) => moveDrag(e, item)}
                      onPointerUp={() => endDrag(item)}
                      onPointerCancel={() => {
                        setDrag(null);
                        setGuide(null);
                      }}
                      onClick={() => {
                        onSelect(item.id);
                        onSelectMarker(null);
                      }}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        onSelect(item.id);
                        onSelectMarker(null);
                        onContextMenu(
                          { x: e.clientX, y: e.clientY },
                          { trackId: track.id, time: item.start, itemId: item.id },
                        );
                      }}
                      className={cx(
                        'absolute inset-y-0 touch-none overflow-hidden rounded border px-1.5 text-left text-[11px] whitespace-nowrap',
                        TRACK_COLORS[track.kind],
                        selected === item.id && 'ring-2 ring-accent',
                        track.hidden && 'opacity-50',
                        lift && 'z-30 opacity-80 shadow-lg',
                        !track.locked && canEdit && 'cursor-grab',
                      )}
                      style={{
                        left: item.start * zoom,
                        width: Math.max(8, itemDuration(item) * zoom),
                        transform: lift ? `translate(${lift.x}px, ${lift.y}px)` : undefined,
                      }}
                      data-testid="timeline-item"
                      data-item-id={item.id}
                      title={itemLabel(item)}
                    >
                      {video ? <Filmstrip pool={lanePool} item={video} zoom={zoom} height={40} /> : null}
                      {item.kind === 'audio' ||
                      (video && track.id === primary.id && !video.muted && !video.freeze) ? (
                        <Waveform pool={lanePool} item={item as VideoItem} zoom={zoom} height={18} />
                      ) : null}
                      {track.locked ? (
                        <span
                          aria-hidden
                          className="pointer-events-none absolute inset-0"
                          style={{ backgroundImage: LOCKED_STRIPES }}
                        />
                      ) : null}
                      <span className="relative">
                        {video?.transitionIn ? <span className="mr-1 text-accent">⤫</span> : null}
                        {video?.freeze ? (
                          <span className="mr-1 text-info" data-testid="item-freeze" title="Freeze frame">
                            ❄
                          </span>
                        ) : null}
                        {video?.flip ? (
                          <span className="mr-1 text-info" data-testid="item-mirror" title="Mirrored">
                            ⇋
                          </span>
                        ) : null}
                        {video?.key ? (
                          <span className="mr-1 text-info" data-testid="item-key" title="Chroma key">
                            ⌗
                          </span>
                        ) : null}
                        {video && (video.transform || video.mask || video.lut || video.ramp) ? (
                          <span className="mr-1 text-info" data-testid="item-shaped">
                            ◆
                          </span>
                        ) : null}
                        {itemLabel(item)}
                      </span>
                      {!track.locked && canEdit
                        ? (['start', 'end'] as const).map((side) => (
                            <TrimHandle
                              key={side}
                              side={side}
                              edge={side === 'start' ? item.start : itemEnd(item)}
                              zoom={zoom}
                              active={trimming}
                              snap={(t) => snap(t, { items: [item.id] })}
                              onGuide={setGuide}
                              onCommit={(delta) => apply(trimOps(item, side, delta, track.id !== primary.id))}
                            />
                          ))
                        : null}
                    </button>
                  </Entity>
                );
              })}
            </div>
          ))}
          {markers.map((m) => (
            <div
              key={m.id}
              aria-hidden
              className="pointer-events-none absolute bottom-0 w-px opacity-60"
              style={{
                top: 20,
                left: (markerDrag?.id === m.id ? markerDrag.t : m.t) * zoom,
                background: MARKER_HEX[m.color],
              }}
            />
          ))}
          {guide !== null ? (
            <div
              className="pointer-events-none absolute top-0 bottom-0 z-40 w-px bg-warning"
              style={{ left: guide * zoom }}
              data-testid="snap-guide"
            />
          ) : null}
          <div
            className="pointer-events-none absolute top-0 bottom-0 w-0.5 bg-accent"
            style={{ left: Math.min(time, duration) * zoom }}
            data-testid="playhead"
          />
        </div>
      </div>
    </div>
  );
}
