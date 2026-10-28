import { type Actor, actorLabel, type CommitSummary, type Project } from '@rideo/shared';
import { AppError } from '../errors';
import type { Tx } from '../vcs/repo';
import type { Deps } from './deps';

export interface MutateOptions<R> {
  message: string | ((result: R) => string);
  meta?: Record<string, unknown>;
  branch?: string;
  coalesce?: { key: string };
  /** Activity summary published for non-user actors (agent/system/webdav). */
  activity?: string | ((result: R) => string);
}

/** Shared plumbing for application services: transactions, attribution, activity and permissions. */
export abstract class Service {
  constructor(protected readonly deps: Deps) {}

  protected async mutate<R>(
    actor: Actor,
    projectId: string,
    fn: (tx: Tx) => R | Promise<R>,
    opts: MutateOptions<R>,
  ): Promise<{ result: R; commit: CommitSummary | null }> {
    const h = await this.deps.projects.existing(projectId);
    const out = await h.repo.transact(fn, {
      actor,
      message: opts.message,
      meta: opts.meta,
      branch: opts.branch,
      coalesce: opts.coalesce,
    });
    if (actor.kind !== 'user' && out.commit) {
      const summary = opts.activity
        ? typeof opts.activity === 'function'
          ? opts.activity(out.result)
          : opts.activity
        : out.commit.message;
      this.deps.hub.activity(projectId, actor, 'commit', summary);
    }
    return out;
  }

  /**
   * Several changes, each its own commit, written as one group (docs/design/version-control.md#commit-protocol): each
   * step's result or error, in order.
   */
  protected async mutateMany<R>(
    actor: Actor,
    projectId: string,
    steps: {
      fn: (tx: Tx) => R | Promise<R>;
      message: string | ((result: R) => string);
      meta?: Record<string, unknown>;
    }[],
  ): Promise<({ result: R; commit: CommitSummary | null } | { error: unknown })[]> {
    const h = await this.deps.projects.existing(projectId);
    const out = await h.repo.transactMany(steps, { actor });
    if (actor.kind !== 'user')
      for (const o of out)
        if ('commit' in o && o.commit) this.deps.hub.activity(projectId, actor, 'commit', o.commit.message);
    return out;
  }

  protected activity(projectId: string, actor: Actor, action: string, summary: string): void {
    if (actor.kind !== 'user') this.deps.hub.activity(projectId, actor, action, summary);
  }

  protected assertAgentMay(project: Project, actor: Actor, what: 'approve' | 'override'): void {
    if (actor.kind !== 'agent') return;
    const ok =
      what === 'approve'
        ? project.settings.approvals.allowAgents
        : project.settings.approvals.allowAgentOverrides;
    if (!ok) {
      throw new AppError(
        'forbidden',
        `${actorLabel(actor)} is not allowed to ${what === 'approve' ? 'approve gates or clips' : 'override consistency checks'} in this project (settings.approvals)`,
      );
    }
  }

  protected async branchOf(projectId: string): Promise<string> {
    return (await this.deps.projects.existing(projectId)).repo.currentBranch();
  }
}
