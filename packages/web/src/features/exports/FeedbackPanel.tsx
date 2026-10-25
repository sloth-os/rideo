import {
  type Export,
  FEEDBACK_DIMENSIONS,
  type Feedback,
  type FeedbackIssue,
  type FeedbackRecommendation,
  feedbackTime,
  isTerminalJob,
} from '@rideo/shared';
import { Download, Eye, Lightbulb, ListChecks, Play, RefreshCw, Sparkles, X } from 'lucide-react';
import { useRef, useState } from 'react';
import { Badge, Button, buttonClass, cx, Dialog, Progress, type Tone } from '../../components/ui';
import { api, mediaUrl } from '../../lib/api';
import { useProject } from '../../store/project';
import { reportError, useUi } from '../../store/ui';

const toast = (message: string) => useUi.getState().toast(message, 'success');

/**
 * Feedback on an export (docs/design/feedback.md#surfaces): the score, a bar per dimension and the summary on the
 * export card; the full feedback in a dialog (a sheet on phones).
 */
const SEVERITY_TONE: Record<FeedbackIssue['severity'], Tone> = {
  critical: 'danger',
  major: 'warning',
  minor: 'neutral',
};

function scoreTone(v: number | null | undefined): Tone {
  if (typeof v !== 'number') return 'neutral';
  return v >= 7.5 ? 'success' : v >= 5 ? 'warning' : 'danger';
}

function dimensionLabel(id: string): string {
  return FEEDBACK_DIMENSIONS.find((d) => d.id === id)?.label ?? id;
}

function ScoreBars({ fb }: { fb: Feedback }) {
  return (
    <ul className="grid grid-cols-1 gap-x-4 gap-y-1 sm:grid-cols-2" aria-label="Scores">
      {FEEDBACK_DIMENSIONS.map((d) => {
        const v = fb.scores[d.id];
        return (
          <li
            key={d.id}
            className="flex items-center gap-2 text-[12px]"
            data-testid={`feedback-score-${d.id}`}
          >
            <span className="w-32 shrink-0 truncate text-muted" title={d.help}>
              {d.label}
            </span>
            <span className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-surface-2">
              <span
                className={cx(
                  'block h-full rounded-full',
                  scoreTone(v) === 'success'
                    ? 'bg-success'
                    : scoreTone(v) === 'warning'
                      ? 'bg-warning'
                      : 'bg-danger',
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

/** The feedback part of an export card. */
export function FeedbackSummary({ e, projectId }: { e: Export; projectId: string }) {
  const fb = useProject(
    (s) => Object.values(s.docs?.feedback ?? {}).find((f) => f.exportId === e.id) ?? null,
  );
  const job = useProject((s) =>
    Object.values(s.jobs).find(
      (j) =>
        j.kind === 'export.feedback' &&
        (j.params as { exportId?: string }).exportId === e.id &&
        !isTerminalJob(j),
    ),
  );
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  if (e.status !== 'succeeded' || !e.media) return null;
  const watch = async () => {
    setBusy(true);
    try {
      await api.requestFeedback(projectId, e.id);
      toast('Watching the film for feedback');
    } catch (err) {
      reportError(err);
    } finally {
      setBusy(false);
    }
  };
  if (!fb)
    return (
      <Button
        size="sm"
        icon={<Sparkles className="size-3.5" />}
        loading={busy}
        onClick={watch}
        data-testid="get-feedback"
      >
        Get feedback
      </Button>
    );
  return (
    <section
      className="space-y-2 rounded-[var(--radius-control)] border border-border bg-surface-2/50 p-2.5"
      data-testid="export-feedback"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[13px] font-medium">Feedback</span>
        {fb.status === 'running' ? (
          <Badge tone="info">watching…</Badge>
        ) : fb.status === 'failed' ? (
          <Badge tone="danger" title={fb.error}>
            failed
          </Badge>
        ) : (
          <Badge tone={scoreTone(fb.overall)} testid="feedback-overall">
            {typeof fb.overall === 'number' ? `${fb.overall.toFixed(1)}/10` : 'measured'}
          </Badge>
        )}
        {fb.status === 'succeeded' ? (
          <span className="text-[12px] text-muted">
            {fb.issues.length} issues · {fb.recommendations.filter((r) => r.status === 'open').length} open
            recommendations
          </span>
        ) : null}
      </div>
      {job && fb.status === 'running' ? (
        <Progress
          value={job.progress.total ? job.progress.done / job.progress.total : 0}
          label={job.progress.message}
        />
      ) : null}
      {fb.status === 'succeeded' ? (
        <>
          <ScoreBars fb={fb} />
          {fb.summary ? <p className="line-clamp-3 text-[12px] text-muted">{fb.summary}</p> : null}
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="primary"
              icon={<Eye className="size-3.5" />}
              onClick={() => setOpen(true)}
              data-testid="show-feedback"
            >
              Show feedback
            </Button>
            <Button
              size="sm"
              icon={<RefreshCw className="size-3.5" />}
              loading={busy}
              onClick={watch}
              data-testid="rerun-feedback"
            >
              Watch again
            </Button>
          </div>
        </>
      ) : null}
      {fb.status === 'failed' ? (
        <Button size="sm" icon={<RefreshCw className="size-3.5" />} loading={busy} onClick={watch}>
          Try again
        </Button>
      ) : null}
      {open ? <FeedbackDialog fb={fb} e={e} projectId={projectId} onClose={() => setOpen(false)} /> : null}
    </section>
  );
}

type Tab = 'recommendations' | 'issues' | 'scenes' | 'retrospective';

function Recommendation({
  r,
  fb,
  projectId,
}: {
  r: FeedbackRecommendation;
  fb: Feedback;
  projectId: string;
}) {
  const [busy, setBusy] = useState<'apply' | 'dismiss' | null>(null);
  const act = async (what: 'apply' | 'dismiss') => {
    setBusy(what);
    try {
      if (what === 'apply') {
        const out = await api.applyRecommendation(projectId, fb.id, r.id);
        toast(out.job ? 'Applied: the work is queued' : 'Applied');
      } else await api.dismissRecommendation(projectId, fb.id, r.id);
    } catch (err) {
      reportError(err);
    } finally {
      setBusy(null);
    }
  };
  const kind = r.action?.kind ?? 'note';
  return (
    <li
      className="space-y-1.5 rounded-[var(--radius-control)] border border-border p-2.5"
      data-testid="feedback-recommendation"
      data-kind={kind}
      data-status={r.status}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge tone={r.priority === 1 ? 'accent' : 'neutral'}>P{r.priority}</Badge>
        <Badge>{dimensionLabel(r.dimension)}</Badge>
        {kind !== 'note' ? <Badge tone="info">{kind.replace('_', ' ')}</Badge> : null}
        {r.status !== 'open' ? (
          <Badge tone={r.status === 'applied' ? 'success' : 'neutral'}>{r.status}</Badge>
        ) : null}
      </div>
      <p className="text-[13px] font-medium break-words">{r.title}</p>
      {r.detail ? <p className="text-[12px] break-words text-muted">{r.detail}</p> : null}
      {r.action?.kind === 'regenerate_shot' && (r.action.description || r.action.action) ? (
        <p className="text-[12px] break-words">
          <span className="text-muted">Revised: </span>
          {[r.action.description, r.action.action].filter(Boolean).join(' — ')}
        </p>
      ) : null}
      {r.status === 'open' ? (
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="primary"
            loading={busy === 'apply'}
            disabled={!!busy}
            onClick={() => act('apply')}
            data-testid="apply-recommendation"
          >
            {kind === 'note' ? 'Mark done' : 'Apply'}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            icon={<X className="size-3.5" />}
            loading={busy === 'dismiss'}
            disabled={!!busy}
            onClick={() => act('dismiss')}
            data-testid="dismiss-recommendation"
          >
            Dismiss
          </Button>
        </div>
      ) : null}
    </li>
  );
}

export function FeedbackDialog({
  fb,
  e,
  projectId,
  onClose,
}: {
  fb: Feedback;
  e: Export;
  projectId: string;
  onClose: () => void;
}) {
  // The live document: applying and dismissing update it.
  const live = useProject((s) => s.docs?.feedback[fb.id]) ?? fb;
  const [tab, setTab] = useState<Tab>('recommendations');
  const video = useRef<HTMLVideoElement>(null);
  const playFrom = (t: number) => {
    const v = video.current;
    if (!v) return;
    v.currentTime = t;
    void v.play().catch(() => undefined);
    v.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
  };
  const tabs: { id: Tab; label: string; icon: typeof Lightbulb; count: number }[] = [
    { id: 'recommendations', label: 'Recommendations', icon: Lightbulb, count: live.recommendations.length },
    { id: 'issues', label: 'Issues', icon: ListChecks, count: live.issues.length },
    { id: 'scenes', label: 'Scenes', icon: Play, count: live.scenes.length },
    { id: 'retrospective', label: 'Improvements', icon: Sparkles, count: live.retrospective.length },
  ];
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Feedback · ${typeof live.overall === 'number' ? `${live.overall.toFixed(1)}/10` : 'measured'}`}
      wide
      footer={
        live.report ? (
          <a
            href={mediaUrl(projectId, live.report.path)}
            download
            className={buttonClass('secondary', 'sm')}
            data-testid="download-feedback-report"
          >
            <Download className="size-3.5" /> Download report
          </a>
        ) : null
      }
    >
      <div className="space-y-3" data-testid="feedback-dialog">
        {e.media ? (
          // biome-ignore lint/a11y/useMediaCaption: the export's own captions are burned in or in its sidecars
          <video
            ref={video}
            src={mediaUrl(projectId, e.media.path)}
            controls
            playsInline
            preload="metadata"
            className="aspect-video w-full rounded-[var(--radius-control)] bg-black"
            data-testid="feedback-video"
          />
        ) : null}
        {live.summary ? <p className="text-[13px] break-words">{live.summary}</p> : null}
        {live.strengths.length ? (
          <ul className="list-inside list-disc text-[12px] text-muted">
            {live.strengths.map((s) => (
              <li key={s} className="break-words">
                {s}
              </li>
            ))}
          </ul>
        ) : null}
        <div className="flex flex-wrap gap-1.5" role="tablist">
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              onClick={() => setTab(t.id)}
              data-testid={`feedback-tab-${t.id}`}
              className={cx(
                'inline-flex h-8 items-center gap-1.5 rounded-[var(--radius-control)] border px-2.5 text-[13px]',
                tab === t.id
                  ? 'border-accent/50 bg-accent/15 text-accent'
                  : 'border-border text-muted hover:text-text',
              )}
            >
              <t.icon className="size-3.5" /> {t.label}
              <span className="font-mono text-[11px] tabular-nums">{t.count}</span>
            </button>
          ))}
        </div>
        {tab === 'recommendations' ? (
          <ul className="space-y-2">
            {live.recommendations.map((r) => (
              <Recommendation key={r.id} r={r} fb={live} projectId={projectId} />
            ))}
            {!live.recommendations.length ? (
              <p className="text-[13px] text-muted">No recommendations.</p>
            ) : null}
          </ul>
        ) : null}
        {tab === 'issues' ? (
          <ul className="space-y-1.5">
            {live.issues.map((i) => (
              <li
                key={i.id}
                className="flex flex-wrap items-start gap-2 rounded-[var(--radius-control)] border border-border p-2"
                data-testid="feedback-issue"
              >
                <span className="font-mono text-[12px] tabular-nums text-muted">{feedbackTime(i.start)}</span>
                {i.shot ? <Badge>{i.shot}</Badge> : null}
                <Badge tone={SEVERITY_TONE[i.severity]}>{i.severity}</Badge>
                <span className="min-w-0 flex-1 basis-48 text-[13px] break-words">
                  <span className="text-muted">{dimensionLabel(i.dimension)}: </span>
                  {i.title}
                  {i.detail ? <span className="block text-[12px] text-muted">{i.detail}</span> : null}
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  icon={<Play className="size-3.5" />}
                  onClick={() => playFrom(i.start)}
                  data-testid="play-from-here"
                >
                  Play from here
                </Button>
              </li>
            ))}
            {!live.issues.length ? <p className="text-[13px] text-muted">No issues found.</p> : null}
          </ul>
        ) : null}
        {tab === 'scenes' ? (
          <ul className="space-y-2">
            {live.scenes.map((s) => (
              <li
                key={s.clipId}
                className="space-y-1 rounded-[var(--radius-control)] border border-border p-2.5"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[13px] font-medium break-words">
                    {s.index + 1}. {s.title}
                  </span>
                  <span className="font-mono text-[12px] text-muted tabular-nums">
                    {feedbackTime(s.start)}–{feedbackTime(s.end)}
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={<Play className="size-3.5" />}
                    onClick={() => playFrom(s.start)}
                  >
                    Play
                  </Button>
                </div>
                {s.error ? (
                  <p className="text-[12px] text-danger break-words">Not reviewed: {s.error}</p>
                ) : null}
                {s.summary ? <p className="text-[12px] text-muted break-words">{s.summary}</p> : null}
                <div className="flex flex-wrap gap-1">
                  {Object.entries(s.scores).map(([d, v]) => (
                    <Badge key={d} tone={scoreTone(v as number)}>
                      {dimensionLabel(d)} {(v as number).toFixed(1)}
                    </Badge>
                  ))}
                </div>
              </li>
            ))}
          </ul>
        ) : null}
        {tab === 'retrospective' ? (
          <ul className="space-y-1.5" data-testid="feedback-retrospective">
            {live.retrospective.map((r) => (
              <li
                key={`${r.area}-${r.title}`}
                className="rounded-[var(--radius-control)] border border-border p-2"
              >
                <div className="flex flex-wrap items-center gap-1.5">
                  <Badge tone="info">{r.area}</Badge>
                  {r.source === 'vision' ? <Badge>from the review</Badge> : null}
                  <span className="text-[13px] font-medium break-words">{r.title}</span>
                </div>
                {r.detail ? <p className="mt-1 text-[12px] text-muted break-words">{r.detail}</p> : null}
              </li>
            ))}
            {!live.retrospective.length ? (
              <p className="text-[13px] text-muted">Nothing to improve was found.</p>
            ) : null}
          </ul>
        ) : null}
      </div>
    </Dialog>
  );
}
