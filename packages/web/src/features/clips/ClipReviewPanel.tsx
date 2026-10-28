import {
  type Clip,
  type ClipReviewState,
  clipReviewState,
  FEEDBACK_DIMENSIONS,
  type FeedbackRecommendation,
  fixOutcome,
  isTerminalJob,
  shotsWithoutTakes,
} from '@rideo/shared';
import { Eye } from 'lucide-react';
import { useState } from 'react';
import { JobRow } from '../../components/JobProgress';
import { Badge, Button, cx, type Tone } from '../../components/ui';
import { api } from '../../lib/api';
import { useProjectRole } from '../../lib/auth';
import { useProject } from '../../store/project';
import { reportError, useUi } from '../../store/ui';

/**
 * A scene's takes watched before the edit (docs/design/ai-review.md#scenes-before-the-edit): the score (and the first
 * round's when the scene was watched again after its fixes), a bar per dimension, the issues by shot, each fix with
 * what became of it, and *Review the scene*.
 */

const STATE: Record<ClipReviewState, { label: string; tone: Tone } | null> = {
  missing: null,
  running: { label: 'Watching…', tone: 'info' },
  error: { label: 'Could not run', tone: 'danger' },
  outdated: { label: 'Takes changed since', tone: 'warning' },
  current: null,
};

const SEVERITY_TONE: Record<string, Tone> = { critical: 'danger', major: 'warning', minor: 'neutral' };

const scoreTone = (v: number | null | undefined): Tone =>
  typeof v !== 'number' ? 'neutral' : v >= 7.5 ? 'success' : v >= 5 ? 'warning' : 'danger';

const fmt = (v: number | null | undefined) => (typeof v === 'number' ? v.toFixed(1) : '–');

function Fix({ fix, clip, projectId }: { fix: FeedbackRecommendation; clip: Clip; projectId: string }) {
  const docs = useProject((s) => s.docs);
  const job = useProject((s) => (fix.jobId ? s.jobs[fix.jobId] : undefined));
  const [busy, setBusy] = useState(false);
  const outcome = docs ? fixOutcome(fix, docs) : null;
  const shot =
    fix.action?.kind === 'regenerate_shot'
      ? clip.shots.find((s) => s.id === (fix.action as { shotId: string }).shotId)
      : undefined;
  const useTake = async () => {
    if (outcome?.state !== 'not_fixed') return;
    setBusy(true);
    try {
      await api.selectTake(projectId, outcome.clipId, outcome.shotId, outcome.takeId, { inCut: true });
      useUi.getState().toast('The new take is selected', 'success');
    } catch (err) {
      reportError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <li
      className="space-y-1 text-[12px] break-words"
      data-testid="clip-review-fix"
      data-outcome={outcome?.state}
    >
      <p>
        <span className="font-mono tabular-nums text-muted">
          {shot ? `C${clip.index + 1}·S${shot.index + 1}` : ''}
        </span>{' '}
        {fix.title}
      </p>
      {!outcome || outcome.state === 'pending' ? (
        <p className={job?.status === 'failed' ? 'text-danger' : 'text-muted'}>
          {job?.status === 'failed'
            ? `The fix failed: ${job.error?.message ?? 'unknown error'}`
            : 'Regenerating…'}
        </p>
      ) : outcome.state === 'fixed' ? (
        <p className="text-success">Fixed: the new take passed its checks and is selected.</p>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-warning">
            Not fixed: the new take did not pass its checks
            {outcome.issues.length ? ` (${outcome.issues.slice(0, 2).join(' · ')})` : ''}, so the shot keeps
            its take.
          </p>
          <Button size="sm" loading={busy} onClick={useTake} data-testid="clip-review-use-take">
            Use the new take
          </Button>
        </div>
      )}
    </li>
  );
}

export function ClipReviewPanel({ clip, projectId }: { clip: Clip; projectId: string }) {
  const access = useProjectRole(useProject((s) => s.docs?.project));
  const job = useProject((s) =>
    Object.values(s.jobs).find(
      (j) => j.kind === 'clip.review' && j.params.clipId === clip.id && !isTerminalJob(j),
    ),
  );
  const [busy, setBusy] = useState(false);
  const review = clip.review;
  const ready = clip.shots.length > 0 && shotsWithoutTakes(clip).length === 0;
  if (!review && !ready && !job) return null;
  const state = clipReviewState(clip);
  const badge = job ? STATE.running : STATE[state];
  const run = async () => {
    setBusy(true);
    try {
      await api.reviewClip(projectId, clip.id);
      useUi.getState().toast(`Watching scene ${clip.index + 1}`, 'success');
    } catch (err) {
      reportError(err);
    } finally {
      setBusy(false);
    }
  };
  const done = review?.status === 'succeeded';
  const fixed = review?.fixes.length ?? 0;
  const scored = FEEDBACK_DIMENSIONS.filter((d) => typeof review?.scores[d.id] === 'number');
  return (
    <details
      className="rounded-[var(--radius-control)] border border-border bg-surface-2"
      data-testid="clip-review"
      data-state={job ? 'running' : state}
    >
      <summary className="flex cursor-pointer flex-wrap items-center gap-2 px-3 py-2 text-[13px]">
        <span className="font-medium">Scene review</span>
        {done ? (
          <Badge tone={scoreTone(review.overall)} testid="clip-review-score">
            {fmt(review.overall)}/10
          </Badge>
        ) : null}
        {done && review.before ? (
          <span className="text-[12px] text-muted" data-testid="clip-review-before">
            {fmt(review.before.overall)} before {fixed} fix{fixed === 1 ? '' : 'es'}
          </span>
        ) : null}
        {badge ? <Badge tone={badge.tone}>{badge.label}</Badge> : null}
        {!review && !job ? <span className="text-[12px] text-muted">Not watched yet</span> : null}
        <span className="ml-auto">
          <Button
            size="sm"
            variant="ghost"
            icon={<Eye className="size-3.5" />}
            loading={busy}
            disabled={!!job || !ready || !access.can('project.edit')}
            title="Watch the scene's takes as the export's feedback will, and generate again the shots that break it"
            onClick={(e) => {
              e.preventDefault();
              void run();
            }}
            data-testid="clip-review-run"
          >
            {review ? 'Review again' : 'Review the scene'}
          </Button>
        </span>
      </summary>
      <div className="space-y-3 border-t border-border px-3 py-2">
        {job ? <JobRow job={job} projectId={projectId} compact /> : null}
        {review?.status === 'failed' && review.error ? (
          <p className="text-[12px] break-words text-danger">{review.error}</p>
        ) : null}
        {review?.summary ? <p className="text-[12px] break-words text-muted">{review.summary}</p> : null}
        {done && scored.length ? (
          <ul className="grid grid-cols-1 gap-x-4 gap-y-1 sm:grid-cols-2" aria-label="Scores">
            {scored.map((d) => {
              const v = review.scores[d.id];
              const tone = scoreTone(v);
              return (
                <li key={d.id} className="flex items-center gap-2 text-[12px]">
                  <span className="w-28 shrink-0 truncate text-muted">{d.label}</span>
                  <span className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-surface">
                    <span
                      className={cx(
                        'block h-full rounded-full',
                        tone === 'success' ? 'bg-success' : tone === 'warning' ? 'bg-warning' : 'bg-danger',
                      )}
                      style={{ width: `${typeof v === 'number' ? v * 10 : 0}%` }}
                    />
                  </span>
                  <span className="w-8 text-right font-mono tabular-nums">{fmt(v)}</span>
                </li>
              );
            })}
          </ul>
        ) : null}
        {review?.fixes.length ? (
          <div>
            <p className="mb-1 text-[12px] font-medium">Shots generated again</p>
            <ul className="space-y-1.5">
              {review.fixes.map((f) => (
                <Fix key={f.id} fix={f} clip={clip} projectId={projectId} />
              ))}
            </ul>
          </div>
        ) : null}
        {review?.issues.length ? (
          <div>
            <p className="mb-1 text-[12px] font-medium">
              {review.before ? 'What it still sees' : 'What it sees'}
            </p>
            <ul className="space-y-1">
              {review.issues.slice(0, 6).map((i) => (
                <li
                  key={i.id}
                  className="flex flex-wrap items-baseline gap-1.5 text-[12px]"
                  data-testid="clip-review-issue"
                >
                  <Badge tone={SEVERITY_TONE[i.severity] ?? 'neutral'}>{i.severity}</Badge>
                  {i.shot ? <span className="font-mono tabular-nums text-muted">{i.shot}</span> : null}
                  <span className="min-w-0 break-words">{i.title}</span>
                </li>
              ))}
            </ul>
            {review.issues.length > 6 ? (
              <p className="mt-1 text-[12px] text-muted">and {review.issues.length - 6} more</p>
            ) : null}
          </div>
        ) : null}
      </div>
    </details>
  );
}
