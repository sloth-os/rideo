import type { WorkflowEvaluation } from '@rideo/shared';
import { Check } from 'lucide-react';
import { cx } from './ui';

export function WorkflowStepper({ workflow, compact }: { workflow: WorkflowEvaluation; compact?: boolean }) {
  return (
    <ol
      className={cx('flex gap-1 overflow-x-auto', compact ? 'text-[11px]' : 'text-[12px]')}
      aria-label="Workflow"
    >
      {workflow.stages.map((s, i) => (
        <li
          key={s.id}
          data-stage={s.id}
          aria-current={s.status === 'current' ? 'step' : undefined}
          className={cx(
            'flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1',
            s.status === 'done' && 'border-success/40 text-success',
            s.status === 'current' && 'border-accent bg-accent/10 text-accent',
            s.status === 'upcoming' && 'border-border text-muted',
          )}
        >
          {s.status === 'done' ? <Check className="size-3" /> : <span className="tabular">{i + 1}</span>}
          {s.title}
        </li>
      ))}
    </ol>
  );
}
