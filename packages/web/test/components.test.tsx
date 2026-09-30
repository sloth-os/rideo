import { evaluateWorkflow, type Job } from '@rideo/shared';
import * as f from '@rideo/shared/testing';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ConsistencyBadge } from '../src/components/ConsistencyBadge';
import { JobRow } from '../src/components/JobProgress';
import { WorkflowStepper } from '../src/components/WorkflowStepper';

afterEach(cleanup);

describe('ConsistencyBadge', () => {
  it('shows passed, stale and override states', () => {
    const mira = f.character();
    const shot = f.readyShot([mira]);
    const take = shot.takes[0]!;
    const { rerender } = render(
      <ConsistencyBadge
        take={{
          ...take,
          consistency: f.report({
            characters: [{ characterId: mira.id, present: true, score: 0.91, issues: [] }],
            score: 0.91,
          }),
        }}
        shot={shot}
        characters={{ [mira.id]: mira }}
      />,
    );
    expect(screen.getByText(/passed 0\.91/)).toBeTruthy();
    rerender(
      <ConsistencyBadge
        take={take}
        shot={shot}
        characters={{ [mira.id]: { ...mira, lock: { ...mira.lock, version: 2 } } }}
      />,
    );
    expect(screen.getByText('stale')).toBeTruthy();
    rerender(
      <ConsistencyBadge
        take={{
          ...take,
          override: { actor: { kind: 'user', id: 'u', name: 'Ana' }, reason: 'checked', at: 'x' },
        }}
        shot={shot}
        characters={{ [mira.id]: mira }}
      />,
    );
    expect(screen.getByText('override').closest('[title]')?.getAttribute('title')).toContain('Ana: checked');
  });
});

describe('WorkflowStepper', () => {
  it('marks done, current and upcoming stages', () => {
    const docs = f.docs();
    docs.project.workflow.stage = 'cast';
    render(<WorkflowStepper workflow={evaluateWorkflow(docs)} />);
    expect(screen.getByText('Cast').closest('li')?.getAttribute('aria-current')).toBe('step');
    expect(document.querySelectorAll('li[data-stage]').length).toBe(8);
  });
});

describe('JobRow', () => {
  it('renders progress and failures', () => {
    const job = {
      id: 'job_1',
      kind: 'shot.generate',
      status: 'running',
      progress: { done: 1, total: 4, message: 'keyframe attempt 1/3' },
      attempts: 1,
    } as unknown as Job;
    const { rerender } = render(<JobRow job={job} projectId="prj_x" />);
    expect(screen.getByText('Generating shot')).toBeTruthy();
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('25');
    expect(screen.getByText('keyframe attempt 1/3')).toBeTruthy();
    rerender(
      <JobRow
        job={{
          ...job,
          status: 'failed',
          error: { code: 'character_not_locked', message: 'Mira is not locked', retryable: false },
        }}
        projectId="prj_x"
      />,
    );
    expect(screen.getByText('Mira is not locked')).toBeTruthy();
  });
});
