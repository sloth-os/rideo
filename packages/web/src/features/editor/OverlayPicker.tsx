import {
  formatDuration,
  isOverlayTrack,
  isStillMedia,
  type MediaRef,
  newId,
  type Source,
  sortedClips,
  type Timeline,
  type TimelineOp,
} from '@rideo/shared';
import { Film, ImageIcon, Search } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { Badge, Button, Dialog, Input } from '../../components/ui';
import { api } from '../../lib/api';
import { useProject } from '../../store/project';
import { reportError } from '../../store/ui';

interface Option {
  key: string;
  label: string;
  source: Source;
  media: MediaRef;
  /** A search match: the matched frame's time, and what it shows (docs/design/search.md#searching). */
  at?: number;
  caption?: string;
}

/**
 * B-roll, stills and takes onto an overlay track at the playhead (docs/design/editor.md#multitrack-transforms-and-keyframes):
 * up to 5 s of a video (3 s of a still), on the top overlay track (a new one when there is none). A search finds them by
 * what they show; a match starts a second before its frame.
 */
export function OverlayPicker({
  open,
  onClose,
  timeline,
  time,
  apply,
}: {
  open: boolean;
  onClose: () => void;
  timeline: Timeline;
  time: number;
  apply: (ops: TimelineOp[]) => void;
}) {
  const docs = useProject((s) => s.docs);
  const [q, setQ] = useState('');
  const [found, setFound] = useState<Option[] | null>(null);
  const [busy, setBusy] = useState(false);
  if (!docs) return null;
  const search = async (e: FormEvent) => {
    e.preventDefault();
    if (!q.trim()) return setFound(null);
    setBusy(true);
    try {
      const res = await api.search(docs.project.id, q.trim(), { kinds: ['take', 'resource'], limit: 12 });
      setFound(
        res.results.map((r) => ({
          key: `${r.media.hash}@${r.at}:${r.source.kind}`,
          label: r.label,
          caption: r.caption,
          at: r.at,
          media: r.media,
          source:
            r.source.kind === 'take'
              ? {
                  type: 'take' as const,
                  clipId: r.source.clipId,
                  shotId: r.source.shotId,
                  takeId: r.source.takeId,
                  media: r.media,
                }
              : {
                  type: 'media' as const,
                  media: r.media,
                  ...(r.source.kind === 'resource' ? { resourceId: r.source.resourceId } : {}),
                },
        })),
      );
    } catch (err) {
      reportError(err);
    } finally {
      setBusy(false);
    }
  };
  const options: Option[] = [
    ...Object.values(docs.resources)
      .filter((r) => (r.kind === 'video' || r.kind === 'image') && r.status === 'ready')
      .map((r) => ({
        key: r.id,
        label: r.name,
        source: { type: 'media' as const, media: r.media, resourceId: r.id },
        media: r.media,
      })),
    ...sortedClips(docs).flatMap((c) =>
      c.shots.flatMap((s) => {
        const take = s.takes.find((t) => t.id === s.selectedTakeId);
        return take?.video
          ? [
              {
                key: take.id,
                label: `C${c.index + 1}·S${s.index + 1} ${s.description.slice(0, 40)}`,
                source: {
                  type: 'take' as const,
                  clipId: c.id,
                  shotId: s.id,
                  takeId: take.id,
                  media: take.video,
                },
                media: take.video,
              },
            ]
          : [];
      }),
    ),
  ];
  const add = (o: Option) => {
    const ops: TimelineOp[] = [];
    let track = [...timeline.tracks].reverse().find((t) => isOverlayTrack(timeline, t));
    if (!track) {
      const id = newId('track');
      ops.push({ op: 'add_track', track: { id, kind: 'video', name: 'Overlay' } });
      track = { id, kind: 'video', name: 'Overlay', items: [] };
    }
    const still = isStillMedia(o.media);
    const dur = o.media.durationSec ?? 5;
    const len = still ? 3 : Math.min(5, dur);
    const from = still || o.at === undefined ? 0 : Math.max(0, Math.min(o.at - 1, dur - len));
    ops.push({
      op: 'insert',
      trackId: track.id,
      item: {
        kind: 'video',
        source: o.source,
        start: Math.max(0, time),
        in: from,
        out: from + len,
        label: o.label.slice(0, 200),
      },
    });
    apply(ops);
    onClose();
  };
  const shown = found ?? options;
  return (
    <Dialog open={open} onClose={onClose} title="Add an overlay at the playhead">
      <form onSubmit={search} className="mb-3 flex gap-2" role="search">
        <Input
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            if (!e.target.value.trim()) setFound(null);
          }}
          placeholder="Search by what it shows…"
          aria-label="Search footage and takes"
          maxLength={500}
          className="flex-1"
          data-testid="overlay-search"
        />
        <Button type="submit" icon={<Search className="size-4" />} loading={busy} aria-label="Search">
          <span className="sr-only sm:not-sr-only">Search</span>
        </Button>
      </form>
      {shown.length === 0 ? (
        <p className="text-[13px] text-muted">
          {found
            ? 'Nothing matches: try other words, or index the project for search.'
            : 'Upload footage or stills in Resources, or generate takes first.'}
        </p>
      ) : (
        <ul className="max-h-[60vh] space-y-1 overflow-y-auto" data-testid="overlay-options">
          {shown.map((o) => (
            <li key={o.key}>
              <button
                type="button"
                className="flex w-full items-center gap-2 rounded-[var(--radius-control)] border border-border px-2.5 py-2 text-left text-[13px] hover:border-accent"
                onClick={() => add(o)}
                data-testid="overlay-option"
              >
                {isStillMedia(o.media) ? (
                  <ImageIcon className="size-4 shrink-0 text-muted" />
                ) : (
                  <Film className="size-4 shrink-0 text-muted" />
                )}
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{o.label}</span>
                  {o.caption ? (
                    <span className="block truncate text-[12px] text-muted">{o.caption}</span>
                  ) : null}
                </span>
                {o.at !== undefined && !isStillMedia(o.media) ? (
                  <Badge>at {formatDuration(o.at)}</Badge>
                ) : o.media.durationSec ? (
                  <Badge>{formatDuration(o.media.durationSec)}</Badge>
                ) : null}
                {o.source.type === 'take' ? <Badge tone="accent">take</Badge> : null}
              </button>
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}
