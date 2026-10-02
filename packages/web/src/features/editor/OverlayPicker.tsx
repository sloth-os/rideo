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
import { Film, ImageIcon } from 'lucide-react';
import { Badge, Dialog } from '../../components/ui';
import { useProject } from '../../store/project';

interface Option {
  key: string;
  label: string;
  source: Source;
  media: MediaRef;
}

/**
 * B-roll, stills and takes onto an overlay track at the playhead (docs/design/editor.md#multitrack-transforms-and-keyframes):
 * up to 5 s of a video (3 s of a still), on the top overlay track (a new one when there is none).
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
  if (!docs) return null;
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
    const len = still ? 3 : Math.min(5, o.media.durationSec ?? 5);
    ops.push({
      op: 'insert',
      trackId: track.id,
      item: {
        kind: 'video',
        source: o.source,
        start: Math.max(0, time),
        in: 0,
        out: len,
        label: o.label.slice(0, 200),
      },
    });
    apply(ops);
    onClose();
  };
  return (
    <Dialog open={open} onClose={onClose} title="Add an overlay at the playhead">
      {options.length === 0 ? (
        <p className="text-[13px] text-muted">
          Upload footage or stills in Resources, or generate takes first.
        </p>
      ) : (
        <ul className="max-h-[60vh] space-y-1 overflow-y-auto" data-testid="overlay-options">
          {options.map((o) => (
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
                <span className="min-w-0 flex-1 truncate">{o.label}</span>
                {o.media.durationSec ? <Badge>{formatDuration(o.media.durationSec)}</Badge> : null}
                {o.source.type === 'take' ? <Badge tone="accent">take</Badge> : null}
              </button>
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}
