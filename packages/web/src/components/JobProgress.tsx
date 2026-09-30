import { isTerminalJob, type Job } from '@rideo/shared';
import { Ban, CheckCircle2, Loader2, XCircle } from 'lucide-react';
import { api } from '../lib/api';
import { reportError } from '../store/ui';
import { Button, cx, Progress } from './ui';

const LABEL: Record<string, string> = {
  'screenplay.generate': 'Writing screenplay',
  'screenplay.extend': 'Writing more scenes',
  'character.refs': 'Generating references',
  'character.describe': 'Describing photo',
  'clip.plan': 'Planning shots',
  'clip.generate': 'Generating clip',
  'shot.generate': 'Generating shot',
  'batch.generate': 'Generating the film',
  'music.generate': 'Composing music',
  'resource.process': 'Processing media',
  'analysis.run': 'Analyzing footage',
  'edit.auto': 'Auto editing',
  'timeline.assemble': 'Assembling timeline',
  'export.render': 'Rendering export',
  'export.finish': 'Finishing export',
};

export function jobLabel(job: Job): string {
  return LABEL[job.kind] ?? job.kind;
}

export function JobRow({ job, projectId, compact }: { job: Job; projectId: string; compact?: boolean }) {
  const done = isTerminalJob(job);
  const ratio = job.progress.total > 0 ? job.progress.done / job.progress.total : 0;
  return (
    <div
      data-entity={`job:${job.id}`}
      className={cx(
        'rounded-[var(--radius-control)] border border-border bg-surface-2 px-3 py-2',
        compact && 'py-1.5',
      )}
    >
      <div className="flex items-center gap-2 text-[13px]">
        {job.status === 'succeeded' ? (
          <CheckCircle2 className="size-4 shrink-0 text-success" />
        ) : job.status === 'failed' ? (
          <XCircle className="size-4 shrink-0 text-danger" />
        ) : job.status === 'cancelled' ? (
          <Ban className="size-4 shrink-0 text-muted" />
        ) : (
          <Loader2
            className={cx('size-4 shrink-0 text-accent', job.status === 'running' && 'animate-spin')}
          />
        )}
        <span className="min-w-0 flex-1 truncate font-medium">{jobLabel(job)}</span>
        <span className="text-[11px] text-muted">
          {job.status === 'queued' && job.attempts > 0 ? `retry ${job.attempts + 1}` : job.status}
        </span>
        {!done ? (
          <Button
            size="sm"
            variant="ghost"
            className="h-6 px-1.5"
            onClick={() => api.cancelJob(projectId, job.id).catch(reportError)}
            aria-label="Cancel job"
          >
            <Ban className="size-3.5" />
          </Button>
        ) : null}
      </div>
      {!done ? (
        <div className="mt-1.5">
          <Progress value={ratio} label={jobLabel(job)} />
          {job.progress.message && !compact ? (
            <div className="mt-1 truncate text-[11px] text-muted">{job.progress.message}</div>
          ) : null}
        </div>
      ) : job.error && job.status === 'failed' ? (
        <div className="mt-1 text-[12px] break-words text-danger">{job.error.message}</div>
      ) : null}
    </div>
  );
}
