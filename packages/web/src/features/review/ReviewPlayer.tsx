import type { Annotation, CommentThread, Shape } from '@rideo/shared';
import { ArrowUpRight, Check, Eraser, MessageSquare, Pencil, RotateCcw, Square } from 'lucide-react';
import { type PointerEvent, useEffect, useMemo, useRef, useState } from 'react';
import { Badge, Button, cx, Textarea } from '../../components/ui';
import { reportError } from '../../store/ui';

/** The ink of drawings: Ember, the accent (docs/brand.md). */
export const INK = '#FF6B3D';
type Point = [number, number];
type Tool = 'stroke' | 'box' | 'arrow';
const TOOLS: { tool: Tool; label: string; icon: typeof Pencil }[] = [
  { tool: 'stroke', label: 'Draw', icon: Pencil },
  { tool: 'box', label: 'Box', icon: Square },
  { tool: 'arrow', label: 'Arrow', icon: ArrowUpRight },
];
/** How close (seconds) the playhead must be to a comment's time for its drawing to show. */
const SHOW_WITHIN = 0.35;

export function formatAt(sec: number): string {
  const m = Math.floor(sec / 60);
  return `${m}:${(sec - m * 60).toFixed(1).padStart(4, '0')}`;
}

const clamp = (v: number) => Math.min(1, Math.max(0, v));

/** The two strokes of an arrowhead at `to`, in frame coordinates corrected for the frame's aspect ratio. */
function arrowHead(from: Point, to: Point, ratio: number): [Point, Point] {
  const dx = (to[0] - from[0]) * ratio;
  const dy = to[1] - from[1];
  const angle = Math.atan2(dy, dx);
  const len = 0.05;
  const wing = (a: number): Point => [
    clamp(to[0] - (Math.cos(a) * len) / ratio),
    clamp(to[1] - Math.sin(a) * len),
  ];
  return [wing(angle - Math.PI / 7), wing(angle + Math.PI / 7)];
}

/** Drawings on a frame: SVG in a 0–1 viewBox stretched over the picture. */
export function ShapesLayer({ shapes, ratio }: { shapes: readonly Shape[]; ratio: number }) {
  return (
    <>
      {shapes.map((s, i) => {
        const common = {
          stroke: s.color,
          strokeWidth: 3,
          fill: 'none',
          vectorEffect: 'non-scaling-stroke' as const,
          strokeLinecap: 'round' as const,
          strokeLinejoin: 'round' as const,
        };
        if (s.kind === 'stroke')
          return <polyline key={i} points={s.points.map((p) => p.join(',')).join(' ')} {...common} />;
        if (s.kind === 'box')
          return (
            <rect
              key={i}
              x={Math.min(s.from[0], s.to[0])}
              y={Math.min(s.from[1], s.to[1])}
              width={Math.abs(s.to[0] - s.from[0])}
              height={Math.abs(s.to[1] - s.from[1])}
              {...common}
            />
          );
        const [a, b] = arrowHead(s.from, s.to, ratio);
        return (
          <g key={i}>
            <line x1={s.from[0]} y1={s.from[1]} x2={s.to[0]} y2={s.to[1]} {...common} />
            <polyline points={`${a.join(',')} ${s.to.join(',')} ${b.join(',')}`} {...common} />
          </g>
        );
      })}
    </>
  );
}

export interface ReviewPlayerProps {
  src: string;
  poster?: string;
  threads: readonly CommentThread[];
  /** Members with `project.comment`, or a guest who gave a name. */
  canComment: boolean;
  /** Editors resolve any thread, reviewers their own; guests none. */
  canResolve?: (t: CommentThread) => boolean;
  onComment: (input: { at: number | null; annotation: Annotation | null; body: string }) => Promise<unknown>;
  onReply: (commentId: string, body: string) => Promise<unknown>;
  onResolve?: (commentId: string, status: 'open' | 'resolved') => Promise<unknown>;
  /** A thread to open with (a notification's link). */
  focusId?: string | null;
  /** Threads beside the picture on wide screens (the guest page); stacked otherwise (dialogs). */
  split?: boolean;
}

/**
 * The review player (docs/design/review.md#surfaces): the video, comment markers on its timeline, drawing tools and
 * the threads with replies and resolve. The studio and the guest page of a share link both use it.
 */
export function ReviewPlayer({
  src,
  poster,
  threads,
  canComment,
  canResolve,
  onComment,
  onReply,
  onResolve,
  focusId,
  split,
}: ReviewPlayerProps) {
  const video = useRef<HTMLVideoElement>(null);
  const [ratio, setRatio] = useState(16 / 9);
  const [duration, setDuration] = useState(0);
  const [time, setTime] = useState(0);
  const [tool, setTool] = useState<Tool | null>(null);
  const [draft, setDraft] = useState<Shape[]>([]);
  const [drawing, setDrawing] = useState<Shape | null>(null);
  const [body, setBody] = useState('');
  const [atNow, setAtNow] = useState(true);
  const [selected, setSelected] = useState<string | null>(focusId ?? null);
  const [filter, setFilter] = useState<'all' | 'open'>('all');
  const [busy, setBusy] = useState(false);

  const seek = (t: CommentThread) => {
    setSelected(t.id);
    const v = video.current;
    if (t.at == null || !v) return;
    v.pause();
    v.currentTime = t.at;
    setTime(t.at);
  };
  // Open on a thread (a notification's link) once the video knows its length.
  const focused = threads.find((t) => t.id === focusId);
  useEffect(() => {
    if (focused && duration > 0) seek(focused);
  }, [focused?.id, duration]);

  const shown = threads.filter((t) => filter === 'all' || t.status === 'open');
  const visibleShapes = useMemo(
    () =>
      threads
        .filter((t) => t.annotation && t.at != null && Math.abs(t.at - time) < SHOW_WITHIN)
        .filter((t) => filter === 'all' || t.status === 'open')
        .flatMap((t) => t.annotation!.shapes),
    [threads, time, filter],
  );

  const pos = (e: PointerEvent<SVGSVGElement>): Point => {
    const r = e.currentTarget.getBoundingClientRect();
    return [clamp((e.clientX - r.left) / r.width), clamp((e.clientY - r.top) / r.height)];
  };
  const down = (e: PointerEvent<SVGSVGElement>) => {
    if (!tool) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    video.current?.pause();
    const p = pos(e);
    setDrawing(
      tool === 'stroke'
        ? { kind: 'stroke', points: [p, p], color: INK }
        : { kind: tool, from: p, to: p, color: INK },
    );
  };
  const move = (e: PointerEvent<SVGSVGElement>) => {
    if (!drawing) return;
    const p = pos(e);
    setDrawing((d) => {
      if (!d) return d;
      if (d.kind !== 'stroke') return { ...d, to: p };
      const last = d.points.at(-1)!;
      return Math.hypot(p[0] - last[0], p[1] - last[1]) < 0.004 || d.points.length >= 2000
        ? d
        : { ...d, points: [...d.points, p] };
    });
  };
  const up = () => {
    if (!drawing) return;
    const big =
      drawing.kind === 'stroke'
        ? drawing.points.length > 2
        : Math.hypot(drawing.to[0] - drawing.from[0], drawing.to[1] - drawing.from[1]) > 0.01;
    if (big) setDraft((d) => [...d, drawing].slice(0, 50));
    setDrawing(null);
  };

  const post = async () => {
    setBusy(true);
    try {
      await onComment({
        at: atNow ? Math.round(time * 100) / 100 : null,
        annotation: draft.length ? { shapes: draft } : null,
        body: body.trim(),
      });
      setBody('');
      setDraft([]);
      setTool(null);
    } catch (err) {
      reportError(err);
    } finally {
      setBusy(false);
    }
  };

  const openCount = threads.filter((t) => t.status === 'open').length;
  return (
    <div
      className={cx('grid gap-4', split && 'lg:grid-cols-[minmax(0,1fr)_22rem]')}
      data-testid="review-player"
    >
      <div className="min-w-0 space-y-2">
        <div
          className="relative mx-auto bg-black"
          style={{ aspectRatio: String(ratio), width: `min(100%, calc(60vh * ${ratio}))` }}
        >
          {/* biome-ignore lint/a11y/useMediaCaption: cuts under review carry burned-in or sidecar subtitles of their own */}
          <video
            ref={video}
            src={src}
            poster={poster}
            controls={!tool}
            playsInline
            preload="metadata"
            className="absolute inset-0 size-full"
            data-testid="review-video"
            onLoadedMetadata={(e) => {
              const v = e.currentTarget;
              setDuration(Number.isFinite(v.duration) ? v.duration : 0);
              if (v.videoWidth && v.videoHeight) setRatio(v.videoWidth / v.videoHeight);
            }}
            onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
            onSeeked={(e) => setTime(e.currentTarget.currentTime)}
          />
          <svg
            viewBox="0 0 1 1"
            preserveAspectRatio="none"
            className={cx(
              'absolute inset-0 size-full',
              tool ? 'cursor-crosshair touch-none' : 'pointer-events-none',
            )}
            onPointerDown={down}
            onPointerMove={move}
            onPointerUp={up}
            onPointerCancel={up}
            role="img"
            aria-label="Drawings on the frame"
            data-testid="annotation-layer"
            data-shapes={visibleShapes.length + draft.length}
          >
            <ShapesLayer shapes={[...visibleShapes, ...draft, ...(drawing ? [drawing] : [])]} ratio={ratio} />
          </svg>
        </div>
        <div className="relative h-4" data-testid="comment-markers">
          <div className="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-surface-2" />
          {duration > 0 ? (
            <div
              className="absolute top-0 h-full w-0.5 bg-accent"
              style={{ left: `${Math.min(100, (time / duration) * 100)}%` }}
            />
          ) : null}
          {duration > 0
            ? threads
                .filter((t) => t.at != null)
                .map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    className={cx(
                      'absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-surface',
                      t.status === 'open' ? 'bg-warning' : 'bg-success',
                      selected === t.id && 'ring-2 ring-accent',
                    )}
                    style={{ left: `${Math.min(100, ((t.at ?? 0) / duration) * 100)}%` }}
                    onClick={() => seek(t)}
                    aria-label={`Comment by ${t.author.name} at ${formatAt(t.at ?? 0)}`}
                    data-testid="comment-marker"
                  />
                ))
            : null}
        </div>
        {canComment ? (
          <div className="space-y-2" data-testid="comment-composer">
            <div className="flex flex-wrap items-center gap-1">
              {TOOLS.map(({ tool: t, label, icon: Icon }) => (
                <Button
                  key={t}
                  size="sm"
                  variant={tool === t ? 'primary' : 'ghost'}
                  className="h-7"
                  icon={<Icon className="size-3.5" />}
                  aria-pressed={tool === t}
                  onClick={() => setTool(tool === t ? null : t)}
                  data-testid={`draw-${t}`}
                >
                  <span className="hidden sm:inline">{label}</span>
                </Button>
              ))}
              {draft.length ? (
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7"
                  icon={<Eraser className="size-3.5" />}
                  onClick={() => setDraft([])}
                  data-testid="draw-clear"
                >
                  {draft.length}
                </Button>
              ) : null}
              <label className="ml-auto flex items-center gap-1.5 text-[12px] text-muted">
                <input
                  type="checkbox"
                  checked={atNow}
                  onChange={(e) => setAtNow(e.target.checked)}
                  className="accent-[var(--color-accent)]"
                  data-testid="comment-at-toggle"
                />
                at <span className="font-mono tabular-nums">{formatAt(time)}</span>
              </label>
            </div>
            <Textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="A note for this moment. @name mentions a member."
              rows={2}
              maxLength={4000}
              aria-label="Comment"
              data-testid="comment-body"
            />
            <div className="flex justify-end">
              <Button
                variant="primary"
                size="sm"
                icon={<MessageSquare className="size-3.5" />}
                disabled={!body.trim()}
                loading={busy}
                onClick={() => void post()}
                data-testid="comment-post"
              >
                Comment
              </Button>
            </div>
          </div>
        ) : null}
      </div>
      <div className="min-w-0">
        <div className="mb-2 flex items-center gap-2 text-[13px]">
          <span className="font-medium">Comments</span>
          <Badge tone={openCount ? 'warning' : 'success'} testid="comments-open">
            {openCount} open
          </Badge>
          <div className="ml-auto flex gap-1" role="group" aria-label="Show">
            {(['all', 'open'] as const).map((f) => (
              <Button
                key={f}
                size="sm"
                variant={filter === f ? 'secondary' : 'ghost'}
                className="h-7"
                aria-pressed={filter === f}
                onClick={() => setFilter(f)}
                data-testid={`comments-filter-${f}`}
              >
                {f === 'all' ? 'All' : 'Open'}
              </Button>
            ))}
          </div>
        </div>
        {shown.length === 0 ? (
          <p className="text-[13px] text-muted" data-testid="comments-empty">
            No comments yet.
          </p>
        ) : (
          <ul className="space-y-2" data-testid="comment-threads">
            {shown.map((t) => (
              <ThreadItem
                key={t.id}
                thread={t}
                selected={selected === t.id}
                onSeek={() => seek(t)}
                canReply={canComment}
                canResolve={!!onResolve && !!canResolve?.(t)}
                onReply={(text) => onReply(t.id, text)}
                onResolve={() => onResolve?.(t.id, t.status === 'open' ? 'resolved' : 'open')}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function ThreadItem({
  thread: t,
  selected,
  onSeek,
  canReply,
  canResolve,
  onReply,
  onResolve,
}: {
  thread: CommentThread;
  selected: boolean;
  onSeek: () => void;
  canReply: boolean;
  canResolve: boolean;
  onReply: (body: string) => Promise<unknown>;
  onResolve: () => Promise<unknown> | undefined;
}) {
  const [reply, setReply] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<unknown> | undefined) => {
    setBusy(true);
    try {
      await fn();
    } catch (err) {
      reportError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <li
      className={cx(
        'rounded-[var(--radius-control)] border bg-surface p-2.5',
        selected ? 'border-accent' : 'border-border',
        t.status === 'resolved' && 'opacity-75',
      )}
      data-testid="comment-thread"
      data-status={t.status}
      data-id={t.id}
    >
      <div className="flex flex-wrap items-center gap-1.5 text-[12px]">
        <span className="font-medium text-text" data-testid="comment-author">
          {t.author.name}
        </span>
        {t.author.kind === 'guest' ? <Badge>guest</Badge> : null}
        {t.author.kind === 'agent' ? <Badge tone="info">agent</Badge> : null}
        {t.at != null ? (
          <button
            type="button"
            className="font-mono text-accent tabular-nums hover:underline"
            onClick={onSeek}
            data-testid="comment-time"
          >
            {formatAt(t.at)}
          </button>
        ) : (
          <span className="text-muted">whole</span>
        )}
        {t.annotation ? (
          <button
            type="button"
            className="text-muted hover:text-text"
            onClick={onSeek}
            aria-label="Show the drawing"
          >
            <Pencil className="size-3" />
          </button>
        ) : null}
        {t.status === 'resolved' ? (
          <Badge tone="success" title={t.resolvedBy ? `Resolved by ${t.resolvedBy.name}` : undefined}>
            resolved
          </Badge>
        ) : null}
      </div>
      <p className="mt-1 text-[13px] break-words whitespace-pre-wrap" data-testid="comment-text">
        {t.body}
      </p>
      {t.replies.length ? (
        <ul className="mt-1.5 space-y-1">
          {t.replies.map((r) => (
            <li
              key={r.id}
              className="border-l-2 border-border pl-2 text-[13px] break-words whitespace-pre-wrap"
              data-testid="comment-reply"
            >
              <span className="font-medium">{r.author.name}</span> {r.body}
            </li>
          ))}
        </ul>
      ) : null}
      {reply !== null ? (
        <div className="mt-2 space-y-1.5">
          <Textarea
            value={reply}
            onChange={(e) => setReply(e.target.value)}
            rows={2}
            maxLength={4000}
            aria-label="Reply"
            placeholder="Reply"
            data-testid="reply-body"
          />
          <div className="flex justify-end gap-1">
            <Button size="sm" variant="ghost" className="h-7" onClick={() => setReply(null)}>
              Cancel
            </Button>
            <Button
              size="sm"
              variant="primary"
              className="h-7"
              disabled={!reply.trim()}
              loading={busy}
              onClick={() =>
                void run(async () => {
                  await onReply(reply.trim());
                  setReply(null);
                })
              }
              data-testid="reply-post"
            >
              Reply
            </Button>
          </div>
        </div>
      ) : (
        <div className="mt-1.5 flex gap-1">
          {canReply ? (
            <Button
              size="sm"
              variant="ghost"
              className="h-7"
              onClick={() => setReply('')}
              data-testid="comment-reply-open"
            >
              Reply
            </Button>
          ) : null}
          {canResolve ? (
            <Button
              size="sm"
              variant="ghost"
              className="h-7"
              loading={busy}
              icon={t.status === 'open' ? <Check className="size-3.5" /> : <RotateCcw className="size-3.5" />}
              onClick={() => void run(onResolve)}
              data-testid="comment-resolve"
            >
              {t.status === 'open' ? 'Resolve' : 'Reopen'}
            </Button>
          ) : null}
        </div>
      )}
    </li>
  );
}
