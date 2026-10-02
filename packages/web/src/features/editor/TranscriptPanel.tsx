import {
  cutRanges,
  fillerWords,
  type MediaRef,
  primaryTrack,
  type Timeline,
  type TimelineOp,
  type TranscriptWord,
  type VideoItem,
} from '@rideo/shared';
import { MessageSquareText, Scissors, Sparkles } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Button, Card, cx } from '../../components/ui';
import { useProject } from '../../store/project';

type Apply = (ops: TimelineOp[]) => void;

interface SourceWords {
  media: MediaRef;
  name: string;
  words: TranscriptWord[];
}

/** Whether the cut plays a source range (some primary item of that media covers most of it). */
function inCut(items: readonly VideoItem[], media: MediaRef, w: TranscriptWord): boolean {
  const mid = (w.start + w.end) / 2;
  return items.some((i) => i.source.media.path === media.path && mid >= i.in && mid <= i.out);
}

/**
 * Edit by text (docs/design/editor.md#transcript-editing): the words of the cut's sources, struck through where the
 * cut does not play them; select words and cut them, or remove the filler words in one go.
 */
export function TranscriptPanel({ timeline, apply }: { timeline: Timeline; apply: Apply }) {
  const docs = useProject((s) => s.docs);
  const [sel, setSel] = useState<{ src: number; from: number; to: number } | null>(null);
  const items = primaryTrack(timeline).items as VideoItem[];
  const sources = useMemo<SourceWords[]>(() => {
    if (!docs) return [];
    const used = new Set(items.map((i) => i.source.media.path));
    return Object.values(docs.analyses)
      .filter((a) => a.status === 'completed' && a.transcript.length)
      .flatMap((a) => {
        const r = docs.resources[a.resourceId];
        if (!r || !used.has(r.media.path)) return [];
        return [{ media: r.media, name: r.name, words: a.transcript.flatMap((s) => s.words ?? []) }];
      })
      .filter((s) => s.words.length);
  }, [docs, items]);
  if (!sources.length) return null;
  const fillers = sources.map((s) =>
    fillerWords(s.words).filter((f) => inCut(items, s.media, f as TranscriptWord)),
  );
  const fillerCount = fillers.reduce((n, f) => n + f.length, 0);
  const cut = (src: SourceWords, ranges: { start: number; end: number }[]) =>
    apply([{ op: 'remove_ranges', media: src.media.path, ranges: cutRanges(ranges) }]);
  return (
    <Card className="p-3" data-testid="transcript-panel">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <MessageSquareText className="size-4 text-muted" />
        <span className="font-medium">Transcript</span>
        <div className="ml-auto flex flex-wrap gap-1">
          <Button
            size="sm"
            variant="ghost"
            className="h-7"
            icon={<Scissors className="size-3.5" />}
            disabled={!sel}
            onClick={() => {
              if (!sel) return;
              const s = sources[sel.src]!;
              cut(s, s.words.slice(sel.from, sel.to + 1));
              setSel(null);
            }}
            data-testid="transcript-cut"
          >
            Cut selection
          </Button>
          <Button
            size="sm"
            className="h-7"
            icon={<Sparkles className="size-3.5" />}
            disabled={!fillerCount}
            onClick={() =>
              sources.forEach((s, k) => {
                if (fillers[k]!.length) cut(s, fillers[k]!);
              })
            }
            data-testid="transcript-fillers"
            data-count={fillerCount}
          >
            Remove filler words ({fillerCount})
          </Button>
        </div>
      </div>
      <div className="max-h-64 space-y-2 overflow-y-auto text-[13px] leading-relaxed">
        {sources.map((s, k) => (
          <p key={s.media.path} data-testid="transcript-source">
            <span className="mr-1 text-[11px] text-muted">{s.name}</span>
            {s.words.map((w, i) => {
              const playing = inCut(items, s.media, w);
              const chosen = sel?.src === k && i >= sel.from && i <= sel.to;
              return (
                <button
                  key={i}
                  type="button"
                  onClick={(e) =>
                    setSel(
                      e.shiftKey && sel?.src === k
                        ? { src: k, from: Math.min(sel.from, i), to: Math.max(sel.to, i) }
                        : { src: k, from: i, to: i },
                    )
                  }
                  className={cx(
                    'mr-1 rounded px-0.5',
                    !playing && 'text-muted line-through',
                    chosen && 'bg-accent/25 text-text',
                  )}
                  data-testid="transcript-word"
                  data-in-cut={playing}
                  title={`${w.start.toFixed(2)}–${w.end.toFixed(2)} s`}
                >
                  {w.text}
                </button>
              );
            })}
          </p>
        ))}
      </div>
      <p className="mt-2 text-[12px] text-muted">
        Click a word, shift-click another to select the words between.
      </p>
    </Card>
  );
}
