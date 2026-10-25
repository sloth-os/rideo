import { type Insights, type Job, takeState } from '@rideo/shared';
import { Service } from './base';

function quantile(values: number[], q: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]! * 10) / 10;
}

function runSeconds(j: Job): number | null {
  if (!j.startedAt || !j.finishedAt) return null;
  return Math.max(0, (Date.parse(j.finishedAt) - Date.parse(j.startedAt)) / 1000);
}

/**
 * A project's run at a glance (docs/design/observability.md#insights): the usage ledger, the job records of the last
 * seven days and the documents. A projection, nothing stored.
 */
export class InsightsService extends Service {
  async insights(projectId: string): Promise<Insights> {
    const docs = await this.deps.projects.docs(projectId);
    const usage = await this.deps.usage.ledger.get(projectId);
    const all = this.deps.jobs.list(projectId);
    const byKind = new Map<string, Job[]>();
    for (const j of all) byKind.set(j.kind, [...(byKind.get(j.kind) ?? []), j]);
    const jobs = [...byKind.entries()]
      .map(([kind, list]) => {
        const errors: Record<string, number> = {};
        for (const j of list)
          if (j.status === 'failed')
            errors[j.error?.code ?? 'unknown'] = (errors[j.error?.code ?? 'unknown'] ?? 0) + 1;
        const done = list.map(runSeconds).filter((x): x is number => x !== null);
        const waits = list
          .filter((j) => j.startedAt)
          .map((j) => Math.max(0, (Date.parse(j.startedAt!) - Date.parse(j.createdAt)) / 1000));
        return {
          kind,
          count: list.length,
          succeeded: list.filter((j) => j.status === 'succeeded').length,
          failed: list.filter((j) => j.status === 'failed').length,
          cancelled: list.filter((j) => j.status === 'cancelled').length,
          p50Sec: quantile(done, 0.5),
          p90Sec: quantile(done, 0.9),
          waitP50Sec: quantile(waits, 0.5),
          errors,
        };
      })
      .sort((a, b) => b.count - a.count);

    const takes = {
      total: 0,
      passed: 0,
      failed: 0,
      unverified: 0,
      overridden: 0,
      firstTry: 0,
      qualityFailed: 0,
    };
    let attemptSum = 0;
    let attemptCount = 0;
    const characters = new Map<string, { checks: number; failures: number }>();
    for (const clip of Object.values(docs.clips))
      for (const shot of clip.shots) {
        for (const take of shot.takes) {
          if (!take.video) continue;
          takes.total++;
          const state = takeState(take, shot, docs.characters, docs.elements);
          if (state === 'passed') takes.passed++;
          else if (state === 'failed') takes.failed++;
          else if (state === 'unverified') takes.unverified++;
          else if (state === 'overridden') takes.overridden++;
          if (take.consistency.quality?.passed === false) takes.qualityFailed++;
          attemptSum += take.consistency.attempts;
          attemptCount++;
          for (const c of take.consistency.characters) {
            const row = characters.get(c.characterId) ?? { checks: 0, failures: 0 };
            row.checks++;
            if (!c.present || c.score < take.consistency.threshold) row.failures++;
            characters.set(c.characterId, row);
          }
        }
        const selected = shot.takes.find((t) => t.id === shot.selectedTakeId);
        if (selected?.consistency.status === 'passed' && selected.consistency.attempts <= 1) takes.firstTry++;
      }
    const feedback = Object.values(docs.feedback).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return {
      usage,
      jobs,
      takes: {
        ...takes,
        meanAttempts: attemptCount ? Math.round((attemptSum / attemptCount) * 100) / 100 : null,
      },
      characters: [...characters.entries()]
        .map(([characterId, row]) => ({
          characterId,
          name: docs.characters[characterId]?.name ?? characterId,
          ...row,
        }))
        .sort((a, b) => b.failures - a.failures),
      stages: Object.entries(docs.project.workflow.approvals)
        .map(([gate, a]) => ({ stage: gate, at: a.at }))
        .sort((a, b) => a.at.localeCompare(b.at)),
      feedback: feedback.map((f) => ({
        exportId: f.exportId,
        createdAt: f.createdAt,
        overall: f.overall,
        scores: f.scores,
      })),
      retrospective: feedback.find((f) => f.status === 'succeeded')?.retrospective ?? [],
    };
  }
}
