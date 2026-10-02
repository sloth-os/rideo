import {
  type ProjectDocs,
  type Review,
  type ReviewTarget,
  reviewItems,
  sortedClips,
  workflowFor,
} from '@rideo/shared';
import {
  CheckCircle2,
  ClipboardCheck,
  Copy,
  Link2,
  Link2Off,
  MessageSquareWarning,
  Plus,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import { Badge, Button, Card, cx, Dialog, Field, Input, Select, Textarea } from '../../components/ui';
import { api } from '../../lib/api';
import { useProjectRole } from '../../lib/auth';
import { reportError, useUi } from '../../store/ui';
import { STATUS_LABEL, STATUS_TONE } from './GuestReviewPage';
import { useReviewDialog } from './ReviewHost';

/** What can be reviewed: exports with a playable video, clips with selected takes. */
function targets(docs: ProjectDocs): { value: string; label: string; target: ReviewTarget }[] {
  const exports = Object.values(docs.exports)
    .filter((e) => e.media?.mime === 'video/mp4')
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((e) => ({
      value: `export:${e.id}`,
      label: `Export · ${e.quality} · ${new Date(e.createdAt).toLocaleString()}`,
      target: { kind: 'export' as const, exportId: e.id },
    }));
  const clips = sortedClips(docs)
    .filter((c) => reviewItems({ target: { kind: 'clip', clipId: c.id } }, docs).length > 0)
    .map((c) => ({
      value: `clip:${c.id}`,
      label: `Clip C${c.index + 1}${c.title ? ` · ${c.title}` : ''}`,
      target: { kind: 'clip' as const, clipId: c.id },
    }));
  return [...exports, ...clips];
}

function targetLabel(docs: ProjectDocs, r: Review): string {
  if (r.target.kind === 'export') return `export · ${docs.exports[r.target.exportId]?.quality ?? 'removed'}`;
  const clip = docs.clips[r.target.clipId];
  return clip ? `clip C${clip.index + 1}` : 'clip (removed)';
}

/**
 * Reviews of the project (docs/design/review.md#reviews-and-share-links): directors ask for one, with a share link
 * for outside reviewers and optionally the gate it decides; members decide; the link can be revoked.
 */
export function ReviewsCard({ docs }: { docs: ProjectDocs }) {
  const { can } = useProjectRole(docs.project);
  const [creating, setCreating] = useState(false);
  const [params] = useSearchParams();
  const focus = params.get('review');
  const reviews = Object.values(docs.reviews).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  useEffect(() => {
    if (focus) document.querySelector(`[data-review-id="${focus}"]`)?.scrollIntoView({ block: 'center' });
  }, [focus]);
  return (
    <Card className="p-4" data-testid="reviews-card">
      <div className="mb-2 flex items-center gap-2 font-medium">
        <ClipboardCheck className="size-4 text-muted" /> Reviews
        {can('project.approve') ? (
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto h-7"
            icon={<Plus className="size-3.5" />}
            onClick={() => setCreating(true)}
            data-testid="review-new"
          >
            Ask for a review
          </Button>
        ) : null}
      </div>
      {reviews.length === 0 ? (
        <p className="text-[13px] text-muted">
          Ask clients and collaborators for a decision on an export or a clip; a review can approve a gate.
        </p>
      ) : (
        <ul className="space-y-2">
          {reviews.map((r) => (
            <ReviewRow key={r.id} docs={docs} review={r} focused={focus === r.id} />
          ))}
        </ul>
      )}
      {creating ? <CreateReviewDialog docs={docs} onClose={() => setCreating(false)} /> : null}
    </Card>
  );
}

function ReviewRow({ docs, review: r, focused }: { docs: ProjectDocs; review: Review; focused: boolean }) {
  const { can } = useProjectRole(docs.project);
  const dialog = useReviewDialog();
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const projectId = docs.project.id;
  const run = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    try {
      await fn();
    } catch (err) {
      reportError(err);
    } finally {
      setBusy(null);
    }
  };
  const approvals = new Set(
    r.decisions.filter((d) => d.decision === 'approve').map((d) => `${d.author.kind}:${d.author.id}`),
  ).size;
  const items = reviewItems(r, docs);
  const linkState = !r.link
    ? null
    : r.link.revokedAt
      ? 'revoked'
      : r.link.expiresAt && Date.parse(r.link.expiresAt) < Date.now()
        ? 'expired'
        : 'active';
  return (
    <li
      className={cx(
        'rounded-[var(--radius-control)] border bg-surface-2 p-2.5 text-[13px]',
        focused ? 'border-accent' : 'border-border',
      )}
      data-testid="review-row"
      data-review-id={r.id}
      data-status={r.status}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="min-w-0 flex-1 truncate font-medium" data-testid="review-row-title">
          {r.title}
        </span>
        <Badge tone={STATUS_TONE[r.status]} testid="review-status">
          {STATUS_LABEL[r.status]}
        </Badge>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[12px] text-muted">
        <span>{targetLabel(docs, r)}</span>
        <span>
          · {approvals}/{r.required} approvals
        </span>
        {r.gate ? (
          <Badge tone={r.gateApprovedAt ? 'success' : 'info'} testid="review-gate">
            {r.gate}
            {r.gateApprovedAt ? ' ✓' : ''}
          </Badge>
        ) : null}
        {linkState ? (
          <Badge tone={linkState === 'active' ? 'accent' : 'neutral'} testid="review-link-state">
            {linkState === 'active' ? <Link2 className="size-3" /> : <Link2Off className="size-3" />}
            link {linkState}
          </Badge>
        ) : null}
      </div>
      {r.decisions.length ? (
        <ul className="mt-1.5 space-y-0.5 text-[12px]" data-testid="review-decisions">
          {r.decisions.map((d) => (
            <li key={`${d.author.kind}:${d.author.id}:${d.at}`}>
              <span className="font-medium">{d.author.name}</span>{' '}
              <span className={d.decision === 'approve' ? 'text-success' : 'text-warning'}>
                {d.decision === 'approve' ? 'approved' : 'asked for changes'}
              </span>
              {d.note ? <span className="text-muted"> “{d.note}”</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
      {note !== null ? (
        <Textarea
          className="mt-2"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={2}
          maxLength={2000}
          placeholder="A note with your decision (optional)"
          data-testid="review-note"
        />
      ) : null}
      <div className="mt-2 flex flex-wrap gap-1">
        {items[0] ? (
          <Button
            size="sm"
            variant="ghost"
            className="h-7"
            onClick={() => dialog?.open(items[0]!.target)}
            data-testid="review-watch"
          >
            Watch{items.length > 1 ? ` (${items.length})` : ''}
          </Button>
        ) : null}
        {can('project.comment') && r.status !== 'closed' ? (
          <>
            <Button
              size="sm"
              variant="ghost"
              className="h-7"
              icon={<MessageSquareWarning className="size-3.5" />}
              loading={busy === 'changes'}
              onClick={() =>
                note === null
                  ? setNote('')
                  : void run('changes', async () => {
                      await api.decideReview(projectId, r.id, 'changes', note.trim() || undefined);
                      setNote(null);
                    })
              }
              data-testid="review-changes"
            >
              Request changes
            </Button>
            <Button
              size="sm"
              variant="secondary"
              className="h-7"
              icon={<CheckCircle2 className="size-3.5" />}
              loading={busy === 'approve'}
              onClick={() =>
                void run('approve', async () => {
                  await api.decideReview(projectId, r.id, 'approve', note?.trim() || undefined);
                  setNote(null);
                })
              }
              data-testid="review-approve"
            >
              Approve
            </Button>
          </>
        ) : null}
        {can('project.approve') && linkState === 'active' ? (
          <Button
            size="sm"
            variant="ghost"
            className="h-7"
            icon={<Link2Off className="size-3.5" />}
            loading={busy === 'revoke'}
            onClick={() => void run('revoke', () => api.revokeReviewLink(projectId, r.id))}
            data-testid="review-revoke"
          >
            Revoke link
          </Button>
        ) : null}
      </div>
    </li>
  );
}

function CreateReviewDialog({ docs, onClose }: { docs: ProjectDocs; onClose: () => void }) {
  const options = targets(docs);
  const gates = workflowFor(docs.project.kind)
    .stages.flatMap((s) => (s.gate ? [s.gate] : []))
    .filter((g) => !docs.project.workflow.approvals[g.id]);
  const [title, setTitle] = useState('');
  const [target, setTarget] = useState(options[0]?.value ?? '');
  const [gate, setGate] = useState('');
  const [required, setRequired] = useState(1);
  const [link, setLink] = useState(true);
  const [days, setDays] = useState(14);
  const [busy, setBusy] = useState(false);
  const [url, setUrl] = useState<string | null>(null);
  const create = async () => {
    const t = options.find((o) => o.value === target);
    if (!t) return;
    setBusy(true);
    try {
      const r = await api.createReview(docs.project.id, {
        title: title.trim(),
        target: t.target,
        gate: gate || null,
        required,
        link: link ? { expiresInDays: days } : null,
      });
      if (r.url) setUrl(r.url);
      else onClose();
      useUi.getState().toast('Review created', 'success');
    } catch (err) {
      reportError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title={url ? 'Share the review' : 'Ask for a review'}
      footer={
        url ? (
          <Button variant="primary" onClick={onClose} data-testid="review-done">
            Done
          </Button>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button
              variant="primary"
              loading={busy}
              disabled={!title.trim() || !target}
              onClick={() => void create()}
              data-testid="review-create"
            >
              Create
            </Button>
          </>
        )
      }
    >
      {url ? (
        <div className="space-y-2">
          <p className="text-[13px] text-muted">
            Anyone with this link can watch, comment and decide under a name they type. It is shown once;
            revoke it from the Reviews card.
          </p>
          <div className="flex gap-2">
            <Input readOnly value={url} onFocus={(e) => e.target.select()} data-testid="review-link-url" />
            <Button
              aria-label="Copy link"
              icon={<Copy className="size-4" />}
              onClick={() =>
                navigator.clipboard?.writeText(url).then(() => useUi.getState().toast('Copied', 'success'))
              }
              data-testid="review-copy"
            />
          </div>
        </div>
      ) : options.length === 0 ? (
        <p className="text-[13px] text-muted">Export the cut or select takes first: reviews show a video.</p>
      ) : (
        <div className="space-y-3">
          <Field label="Title">
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Pilot for the client"
              maxLength={200}
              data-testid="review-title"
            />
          </Field>
          <Field label="What to review">
            <Select value={target} onChange={(e) => setTarget(e.target.value)} data-testid="review-target">
              {options.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          </Field>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Decides the gate" hint="Approved when the review is">
              <Select value={gate} onChange={(e) => setGate(e.target.value)} data-testid="review-gate-select">
                <option value="">none</option>
                {gates.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.title}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Approvals needed">
              <Input
                type="number"
                min={1}
                max={50}
                value={required}
                onChange={(e) => setRequired(Math.max(1, Math.min(50, Number(e.target.value) || 1)))}
                data-testid="review-required"
              />
            </Field>
          </div>
          <label className="flex items-center gap-2 text-[13px]">
            <input
              type="checkbox"
              checked={link}
              onChange={(e) => setLink(e.target.checked)}
              className="accent-[var(--color-accent)]"
              data-testid="review-link-toggle"
            />
            Share link for people without an account, valid for
            <Input
              type="number"
              min={1}
              max={365}
              value={days}
              disabled={!link}
              onChange={(e) => setDays(Math.max(1, Math.min(365, Number(e.target.value) || 14)))}
              className="w-20"
              aria-label="Days the link is valid"
              data-testid="review-expiry"
            />
            days
          </label>
        </div>
      )}
    </Dialog>
  );
}
