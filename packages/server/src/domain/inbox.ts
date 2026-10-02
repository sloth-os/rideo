import { can, evaluateWorkflow, type Inbox, isTerminalJob, type ProjectDocs } from '@rideo/shared';
import { currentPrincipal } from '../auth/context';
import { Service } from './base';

const DAY_MS = 24 * 3600 * 1000;
/** Agents' commits listed at most. */
const AGENT_COMMITS = 50;
/** How long a person's Inbox is reused (every open tab's header asks for it). */
export const INBOX_CACHE_MS = 10_000;

/**
 * The Inbox (docs/design/pwa.md#the-inbox): across the projects the caller may read, the gates they may approve,
 * the open reviews they have not decided, the jobs running or failed today, and agents' work of the last day.
 */
export class InboxService extends Service {
  private readonly recent = new Map<string, { at: number; inbox: Promise<Inbox> }>();

  /** The caller's Inbox, reused for a few seconds unless `fresh` (after an action) asks for it again. */
  inbox(opts: { fresh?: boolean } = {}): Promise<Inbox> {
    const principal = currentPrincipal() ?? this.deps.accounts.studioPrincipal();
    const key = `${principal.kind}:${principal.user.id}:${principal.token?.id ?? ''}`;
    const hit = this.recent.get(key);
    if (!opts.fresh && hit && Date.now() - hit.at < INBOX_CACHE_MS) return hit.inbox;
    const inbox = this.gather(principal);
    this.recent.delete(key);
    this.recent.set(key, { at: Date.now(), inbox });
    if (this.recent.size > 500) this.recent.delete(this.recent.keys().next().value!);
    inbox.catch(() => this.recent.delete(key));
    return inbox;
  }

  private async gather(principal: NonNullable<ReturnType<typeof currentPrincipal>>): Promise<Inbox> {
    const me = principal.user.id;
    const since = Date.now() - DAY_MS;
    const out: Inbox = { approvals: [], reviews: [], jobs: [], agents: [], waiting: 0 };
    for (const projectId of await this.deps.projects.listIds()) {
      let docs: ProjectDocs;
      try {
        docs = await this.deps.projects.docs(projectId);
      } catch {
        continue;
      }
      const role = this.deps.accounts.roleInProject(principal, docs.project);
      if (!role) continue;
      const project = { id: projectId, title: docs.project.title };
      const wf = evaluateWorkflow(docs);
      const gate = wf.stages.find((s) => s.id === wf.stage)?.gate;
      if (gate?.satisfied && !gate.approved && can(role, 'project.approve'))
        out.approvals.push({ project, stage: wf.stage, gate: { id: gate.id, title: gate.title } });
      for (const r of Object.values(docs.reviews)) {
        if (r.status !== 'open' || r.createdBy.id === me || r.decisions.some((d) => d.author.id === me))
          continue;
        out.reviews.push({
          project,
          review: {
            id: r.id,
            title: r.title,
            createdBy: r.createdBy.name,
            createdAt: r.createdAt,
            gate: r.gate,
          },
        });
      }
      for (const j of this.deps.jobs.list(projectId)) {
        if (j.parentId) continue;
        const running = !isTerminalJob(j);
        if (!running && !(j.status === 'failed' && Date.parse(j.finishedAt ?? j.createdAt) >= since))
          continue;
        out.jobs.push({
          project,
          job: {
            id: j.id,
            kind: j.kind,
            status: j.status,
            progress: j.progress,
            actor: j.actor,
            createdAt: j.createdAt,
            error: j.error?.message ?? null,
          },
          canCancel: running && can(role, 'project.edit'),
        });
      }
      const log = await this.deps.projects.handle(projectId).repo.log({ limit: 100 });
      for (const c of log) {
        if (Date.parse(c.timestamp) < since) break;
        if (c.author.kind === 'agent')
          out.agents.push({
            project,
            commit: { id: c.id, message: c.message, at: c.timestamp, agent: c.author.name ?? c.author.id },
          });
      }
    }
    out.approvals.sort((a, b) => a.project.title.localeCompare(b.project.title));
    out.reviews.sort((a, b) => b.review.createdAt.localeCompare(a.review.createdAt));
    // running first, then the failures; newest first in each
    out.jobs.sort(
      (a, b) =>
        Number(isTerminalJob(a.job)) - Number(isTerminalJob(b.job)) ||
        b.job.createdAt.localeCompare(a.job.createdAt),
    );
    out.agents.sort((a, b) => b.commit.at.localeCompare(a.commit.at));
    out.agents = out.agents.slice(0, AGENT_COMMITS);
    out.waiting = out.approvals.length + out.reviews.length;
    return out;
  }
}
