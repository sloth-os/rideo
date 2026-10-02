import { sameTarget } from '@rideo/shared';
import { CheckCircle2, Link2Off, MessageSquareWarning } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router';
import { Badge, Button, Card, cx, EmptyState, Field, Input, Spinner, Textarea } from '../../components/ui';
import { ApiError, api, type GuestReview, guestMediaUrl } from '../../lib/api';
import { reportError } from '../../store/ui';
import { ReviewPlayer } from './ReviewPlayer';

const NAME_KEY = 'rideo.reviewer.name';
const readName = () => {
  try {
    return localStorage.getItem(NAME_KEY) ?? '';
  } catch {
    return '';
  }
};
const saveName = (name: string) => {
  try {
    localStorage.setItem(NAME_KEY, name);
  } catch {
    // private windows: the name lives for this visit only
  }
};

export const STATUS_TONE = {
  open: 'neutral',
  approved: 'success',
  changes_requested: 'warning',
  closed: 'neutral',
} as const;
export const STATUS_LABEL = {
  open: 'waiting for decisions',
  approved: 'approved',
  changes_requested: 'changes requested',
  closed: 'closed',
} as const;

/**
 * What an outside reviewer sees through a share link (docs/design/review.md#reviews-and-share-links): the review's
 * media, comments and drawings under a name they type, and their decision. Nothing else of the project.
 */
export function GuestReviewPage() {
  const { token = '' } = useParams();
  const [view, setView] = useState<GuestReview | null>(null);
  const [gone, setGone] = useState(false);
  const [name, setName] = useState(readName);
  const [draftName, setDraftName] = useState(readName);
  const [item, setItem] = useState(0);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState<'approve' | 'changes' | null>(null);

  const load = useCallback(async () => {
    try {
      setView(await api.guestReview(token));
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) setGone(true);
      else reportError(err);
    }
  }, [token]);
  useEffect(() => {
    void load();
    // No live channel for guests: a slow poll keeps the threads fresh.
    const t = setInterval(() => void load(), 15_000);
    return () => clearInterval(t);
  }, [load]);

  if (gone)
    return (
      <Shell>
        <EmptyState
          icon={<Link2Off className="size-6" />}
          title="This review link does not exist or has expired"
        >
          Ask the person who sent it for a new link.
        </EmptyState>
      </Shell>
    );
  if (!view)
    return (
      <Shell>
        <div className="flex justify-center p-10">
          <Spinner className="size-6" />
        </div>
      </Shell>
    );

  const current = view.items[Math.min(item, view.items.length - 1)];
  const mine = view.review.decisions
    .filter((d) => d.author.kind === 'guest' && d.author.name === name)
    .at(-1);
  const approvals = new Set(
    view.review.decisions
      .filter((d) => d.decision === 'approve')
      .map((d) => `${d.author.kind}:${d.author.id}`),
  ).size;
  const decide = async (decision: 'approve' | 'changes') => {
    setBusy(decision);
    try {
      await api.guestDecide(token, name, decision, note.trim() || undefined);
      setNote('');
      await load();
    } catch (err) {
      reportError(err);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Shell title={view.project.title}>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <h1 className="text-xl font-semibold tracking-tight" data-testid="guest-review-title">
          {view.review.title}
        </h1>
        <Badge tone={STATUS_TONE[view.review.status]} testid="guest-status">
          {STATUS_LABEL[view.review.status]}
        </Badge>
        <span className="text-[12px] text-muted">
          {approvals}/{view.review.required} approvals
        </span>
      </div>
      {!name ? (
        <Card className="mx-auto max-w-md p-4" data-testid="guest-name-card">
          <p className="mb-3 text-[13px] text-muted">
            {view.review.createdBy.name} asked for your review. Your name goes with your comments and
            decision.
          </p>
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              const n = draftName.trim();
              if (!n) return;
              saveName(n);
              setName(n);
            }}
          >
            <Input
              value={draftName}
              onChange={(e) => setDraftName(e.target.value)}
              placeholder="Your name"
              maxLength={80}
              aria-label="Your name"
              data-testid="guest-name"
            />
            <Button type="submit" variant="primary" disabled={!draftName.trim()} data-testid="guest-start">
              Start
            </Button>
          </form>
        </Card>
      ) : view.items.length === 0 ? (
        <EmptyState title="Nothing to watch yet">The video of this review is not ready.</EmptyState>
      ) : (
        <div className="space-y-4">
          {view.items.length > 1 ? (
            <div className="flex gap-1 overflow-x-auto pb-1" role="tablist" aria-label="Shots">
              {view.items.map((it, k) => {
                const open = view.comments.filter(
                  (c) => c.status === 'open' && sameTarget(c.target, it.target),
                ).length;
                return (
                  <button
                    key={it.key}
                    type="button"
                    role="tab"
                    aria-selected={k === item}
                    onClick={() => setItem(k)}
                    className={cx(
                      'shrink-0 rounded-[var(--radius-control)] border px-2.5 py-1 text-[13px]',
                      k === item ? 'border-accent bg-accent/15 text-accent' : 'border-border text-muted',
                    )}
                    data-testid="guest-item"
                  >
                    {it.label}
                    {open ? <span className="ml-1 text-warning">· {open}</span> : null}
                  </button>
                );
              })}
            </div>
          ) : null}
          {current ? (
            <ReviewPlayer
              key={current.key}
              split
              src={guestMediaUrl(token, current.media.path)}
              poster={current.media.poster ? guestMediaUrl(token, current.media.poster.path) : undefined}
              threads={view.comments.filter((c) => sameTarget(c.target, current.target))}
              canComment
              onComment={async (input) => {
                await api.guestComment(token, name, { ...input, target: current.target });
                await load();
              }}
              onReply={async (id, body) => {
                await api.guestReply(token, name, id, body);
                await load();
              }}
            />
          ) : null}
          <Card className="space-y-3 p-4" data-testid="guest-decision">
            <div className="flex flex-wrap items-center gap-2 text-[13px]">
              <span className="font-medium">Your decision</span>
              {mine ? (
                <Badge tone={mine.decision === 'approve' ? 'success' : 'warning'} testid="guest-my-decision">
                  {mine.decision === 'approve' ? 'approved' : 'changes requested'}
                </Badge>
              ) : null}
              <span className="ml-auto text-muted">
                as {name}{' '}
                <button
                  type="button"
                  className="underline hover:text-text"
                  onClick={() => {
                    setDraftName(name);
                    setName('');
                  }}
                >
                  change
                </button>
              </span>
            </div>
            <Field label="Note">
              <Textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                rows={2}
                maxLength={2000}
                placeholder="What should change, or anything to add"
                data-testid="guest-note"
              />
            </Field>
            <div className="flex flex-wrap justify-end gap-2">
              <Button
                variant="secondary"
                icon={<MessageSquareWarning className="size-4" />}
                loading={busy === 'changes'}
                disabled={!!busy || view.review.status === 'closed'}
                onClick={() => void decide('changes')}
                data-testid="guest-changes"
              >
                Request changes
              </Button>
              <Button
                variant="primary"
                icon={<CheckCircle2 className="size-4" />}
                loading={busy === 'approve'}
                disabled={!!busy || view.review.status === 'closed'}
                onClick={() => void decide('approve')}
                data-testid="guest-approve"
              >
                Approve
              </Button>
            </div>
            {view.review.decisions.length ? (
              <ul className="space-y-1 border-t border-border pt-2 text-[13px]" data-testid="guest-decisions">
                {view.review.decisions.map((d) => (
                  <li key={`${d.author.id}-${d.at}`} className="flex flex-wrap gap-1.5">
                    <span className="font-medium">{d.author.name}</span>
                    <span className={d.decision === 'approve' ? 'text-success' : 'text-warning'}>
                      {d.decision === 'approve' ? 'approved' : 'asked for changes'}
                    </span>
                    {d.note ? <span className="text-muted">“{d.note}”</span> : null}
                  </li>
                ))}
              </ul>
            ) : null}
          </Card>
        </div>
      )}
    </Shell>
  );
}

function Shell({ title, children }: { title?: string; children: React.ReactNode }) {
  return (
    <div className="min-h-full">
      <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b border-border bg-bg/95 px-3 backdrop-blur sm:px-4">
        <img src="/logo.svg" alt="" className="size-7" />
        <span className="font-semibold tracking-tight">Rideo</span>
        <span className="text-muted">review</span>
        {title ? (
          <span className="ml-2 min-w-0 truncate text-[13px] text-muted" data-testid="guest-project">
            {title}
          </span>
        ) : null}
      </header>
      <main className="mx-auto max-w-6xl px-3 py-4 sm:px-6">{children}</main>
    </div>
  );
}
