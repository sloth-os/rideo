import {
  REVIEW_DIMENSIONS,
  type ReviewStage,
  type ReviewState,
  reviewState,
  type StageAction,
  type StageIssue,
  type StageRecommendation,
  type StageReview,
} from '@rideo/shared';
import { Bot, Check, RefreshCw, X } from 'lucide-react';
import { useState } from 'react';
import { Badge, Button, Card, cx, type Tone } from '../../components/ui';
import { api } from '../../lib/api';
import { useProject } from '../../store/project';
import { reportError, useUi } from '../../store/ui';

/**
 * The AI review of the screenplay or the storyboard (docs/design/ai-review.md#surfaces): the verdict against the
 * threshold, a bar per dimension, the issues and the recommendations to apply, review again or continue anyway.
 */

const STATE_LABEL: Record<ReviewState, { label: string; tone: Tone }> = {
  off: { label: 'Off', tone: 'neutral' },
  missing: { label: 'Not reviewed yet', tone: 'neutral' },
  running: { label: 'Reviewing…', tone: 'info' },
  error: { label: 'Could not run', tone: 'danger' },
  outdated: { label: 'Changed since the review', tone: 'warning' },
  failed: { label: 'Did not pass', tone: 'danger' },
  passed: { label: 'Passed', tone: 'success' },
  overridden: { label: 'Continued anyway', tone: 'warning' },
};

const SEVERITY_TONE: Record<StageIssue['severity'], Tone> = {
  critical: 'danger',
  major: 'warning',
  minor: 'neutral',
};

const DIMENSION_LABEL: Record<string, string> = {
  story: 'Story',
  character: 'Characters',
  dialogue: 'Dialogue',
  pacing: 'Pacing',
  visual: 'Visual storytelling',
  continuity: 'Continuity',
  feasibility: 'Feasibility',
  brief: 'Follows the brief',
  composition: 'Composition',
  coverage: 'Coverage',
  storytelling: 'Storytelling',
};

const scoreTone = (v: number | null | undefined): Tone =>
  typeof v !== 'number' ? 'neutral' : v >= 7.5 ? 'success' : v >= 5 ? 'warning' : 'danger';

/** What applying a recommendation does, in words. */
function actionText(a: StageAction | null, review: StageReview): string | null {
  if (!a || a.kind === 'note') return null;
  if (a.kind === 'revise_scene') {
    const scene = review.issues.find((i) => i.sceneId === a.sceneId)?.scene;
    return `Rewrite ${scene ? `scene ${scene}` : 'the scene'}: ${a.instruction}`;
  }
  if (a.kind === 'revise_outline') return `Rewrite the outline: ${a.instruction}`;
  if (a.kind === 'replan_scene') return `Plan the scene again: ${a.direction}`;
  const shot = review.issues.find((i) => i.shotId === a.shotId)?.shot;
  return `Draw ${shot ?? 'the frame'} again${a.description ? `: ${a.description}` : ''}`;
}

function Bars({ review, stage }: { review: StageReview; stage: ReviewStage }) {
  return (
    <ul className="grid grid-cols-1 gap-x-4 gap-y-1 sm:grid-cols-2" aria-label="Scores">
      {REVIEW_DIMENSIONS[stage].map((d) => {
        const v = review.scores[d];
        const tone = scoreTone(v);
        return (
          <li key={d} className="flex items-center gap-2 text-[12px]" data-testid={`ai-review-score-${d}`}>
            <span className="w-32 shrink-0 truncate text-muted">{DIMENSION_LABEL[d] ?? d}</span>
            <span className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-surface-2">
              <span
                className={cx(
                  'block h-full rounded-full',
                  tone === 'success' ? 'bg-success' : tone === 'warning' ? 'bg-warning' : 'bg-danger',
                )}
                style={{ width: `${typeof v === 'number' ? v * 10 : 0}%` }}
              />
            </span>
            <span className="w-8 text-right font-mono tabular-nums">
              {typeof v === 'number' ? v.toFixed(1) : '–'}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function Recommendation({
  rec,
  review,
  stage,
  projectId,
}: {
  rec: StageRecommendation;
  review: StageReview;
  stage: ReviewStage;
  projectId: string;
}) {
  const [busy, setBusy] = useState<'apply' | 'dismiss' | null>(null);
  const run = async (what: 'apply' | 'dismiss') => {
    setBusy(what);
    try {
      if (what === 'apply') {
        await api.applyAiReview(projectId, stage, rec.id);
        useUi.getState().toast('Applied: review again when it is done', 'success');
      } else await api.dismissAiReview(projectId, stage, rec.id);
    } catch (err) {
      reportError(err);
    } finally {
      setBusy(null);
    }
  };
  const doing = actionText(rec.action, review);
  return (
    <li
      className="space-y-1.5 rounded-[var(--radius-control)] border border-border p-3"
      data-testid="ai-review-recommendation"
      data-kind={rec.action?.kind ?? 'note'}
      data-status={rec.status}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge tone={rec.priority === 1 ? 'accent' : 'neutral'}>P{rec.priority}</Badge>
        <Badge>{DIMENSION_LABEL[rec.dimension] ?? rec.dimension}</Badge>
        {rec.status !== 'open' ? (
          <Badge tone={rec.status === 'applied' ? 'success' : 'neutral'}>
            {rec.status === 'applied' && rec.appliedBy?.kind === 'system'
              ? 'applied by the review'
              : rec.status}
          </Badge>
        ) : null}
      </div>
      <p className="text-[13px] font-medium break-words">{rec.title}</p>
      {rec.detail ? <p className="text-[12px] break-words text-muted">{rec.detail}</p> : null}
      {doing ? <p className="text-[12px] break-words">{doing}</p> : null}
      {rec.status === 'open' ? (
        <div className="flex flex-wrap gap-2">
          {rec.action && rec.action.kind !== 'note' ? (
            <Button
              size="sm"
              variant="primary"
              loading={busy === 'apply'}
              disabled={!!busy}
              onClick={() => run('apply')}
              data-testid="apply-ai-review"
            >
              Apply
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="ghost"
            icon={<X className="size-3.5" />}
            loading={busy === 'dismiss'}
            disabled={!!busy}
            onClick={() => run('dismiss')}
            data-testid="dismiss-ai-review"
          >
            Dismiss
          </Button>
        </div>
      ) : null}
    </li>
  );
}

export function AiReviewPanel({ stage }: { stage: ReviewStage }) {
  const { docs, projectId } = useProject();
  const [busy, setBusy] = useState<'run' | 'override' | null>(null);
  const [open, setOpen] = useState(false);
  if (!docs || !projectId) return null;
  const state = reviewState(docs, stage);
  if (state === 'off') return null;
  const review = docs.aiReviews[stage];
  const badge = STATE_LABEL[state];
  const what = stage === 'screenplay' ? 'screenplay' : 'storyboard';
  const run = async () => {
    setBusy('run');
    try {
      await api.runAiReview(projectId, stage);
    } catch (err) {
      reportError(err);
    } finally {
      setBusy(null);
    }
  };
  const override = async () => {
    const note = prompt(`Continue without passing the ${what} review? Say why (optional).`, '');
    if (note === null) return;
    setBusy('override');
    try {
      await api.overrideAiReview(projectId, stage, note);
    } catch (err) {
      reportError(err);
    } finally {
      setBusy(null);
    }
  };
  const openRecs = review?.recommendations.filter((r) => r.status === 'open').length ?? 0;
  const done = review && review.status === 'succeeded';
  return (
    <Card className="space-y-3 p-4" data-testid={`ai-review-${stage}`} data-state={state}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <Bot className="size-4 text-muted" aria-hidden />
          <h3 className="text-[14px] font-semibold">AI review of the {what}</h3>
          <Badge tone={badge.tone} testid="ai-review-state">
            {badge.label}
          </Badge>
          {done && review.verdict ? (
            <span className="font-mono text-[13px] tabular-nums" data-testid="ai-review-score">
              {review.verdict.score.toFixed(1)} / 10
              <span className="text-muted"> · passes at {review.threshold}</span>
            </span>
          ) : null}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            icon={<RefreshCw className="size-3.5" />}
            loading={busy === 'run' || state === 'running'}
            disabled={!!busy || state === 'running'}
            onClick={run}
            data-testid="run-ai-review"
          >
            {review ? 'Review again' : 'Review'}
          </Button>
          {state === 'failed' ? (
            <Button
              size="sm"
              variant="ghost"
              icon={<Check className="size-3.5" />}
              loading={busy === 'override'}
              disabled={!!busy}
              onClick={override}
              data-testid="override-ai-review"
            >
              Continue anyway
            </Button>
          ) : null}
        </div>
      </div>
      {state === 'error' && review?.error ? (
        <p className="text-[12px] text-danger" data-testid="ai-review-error">
          {review.error}
        </p>
      ) : null}
      {done ? (
        <>
          {review.summary ? <p className="text-[13px] break-words">{review.summary}</p> : null}
          {state === 'failed' && review.verdict?.blocking.length ? (
            <ul
              className="list-disc space-y-0.5 pl-5 text-[12px] text-danger"
              data-testid="ai-review-blocking"
            >
              {review.verdict.blocking.slice(0, 5).map((b) => (
                <li key={b} className="break-words">
                  {b}
                </li>
              ))}
            </ul>
          ) : null}
          <Bars review={review} stage={stage} />
          <p className="text-[12px] text-muted" data-testid="ai-review-round">
            Round {review.round}
            {review.history.length
              ? ` · earlier: ${review.history.map((h) => h.score.toFixed(1)).join(', ')}`
              : ''}
            {review.model ? ` · ${review.model}` : ''}
            {` · ${review.issues.length} issue(s), ${openRecs} open recommendation(s)`}
          </p>
          {review.issues.length || review.recommendations.length ? (
            <div>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setOpen((v) => !v)}
                aria-expanded={open}
                data-testid="ai-review-details"
              >
                {open ? 'Hide the issues and recommendations' : 'Show the issues and recommendations'}
              </Button>
              {open ? (
                <div className="mt-2 grid grid-cols-1 gap-4 lg:grid-cols-2">
                  <section className="min-w-0 space-y-2">
                    <h4 className="text-[13px] font-medium">Recommendations</h4>
                    <ul className="space-y-2">
                      {review.recommendations.map((r) => (
                        <Recommendation
                          key={r.id}
                          rec={r}
                          review={review}
                          stage={stage}
                          projectId={projectId}
                        />
                      ))}
                    </ul>
                  </section>
                  <section className="min-w-0 space-y-2">
                    <h4 className="text-[13px] font-medium">Issues</h4>
                    <ul className="space-y-2">
                      {review.issues.map((i) => (
                        <li
                          key={i.id}
                          className="space-y-1 rounded-[var(--radius-control)] border border-border p-3"
                          data-testid="ai-review-issue"
                        >
                          <div className="flex flex-wrap items-center gap-1.5">
                            <Badge tone={SEVERITY_TONE[i.severity]}>{i.severity}</Badge>
                            <Badge>{DIMENSION_LABEL[i.dimension] ?? i.dimension}</Badge>
                            {i.shot ? (
                              <Badge tone="info">{i.shot}</Badge>
                            ) : i.scene ? (
                              <Badge tone="info">Scene {i.scene}</Badge>
                            ) : null}
                          </div>
                          <p className="text-[13px] font-medium break-words">{i.title}</p>
                          {i.detail ? <p className="text-[12px] break-words text-muted">{i.detail}</p> : null}
                        </li>
                      ))}
                    </ul>
                  </section>
                </div>
              ) : null}
            </div>
          ) : null}
        </>
      ) : null}
    </Card>
  );
}
