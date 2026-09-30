import type { Actor, BranchInfo, CommitSummary, Diff, TagInfo } from '@rideo/shared';
import { Service } from './base';

export class HistoryService extends Service {
  async log(
    projectId: string,
    opts: { path?: string; limit?: number; before?: string; branch?: string } = {},
  ): Promise<CommitSummary[]> {
    return (await this.deps.projects.existing(projectId)).repo.log(opts);
  }

  async show(projectId: string, commit: string): Promise<CommitSummary> {
    return (await this.deps.projects.existing(projectId)).repo.show(commit);
  }

  async diff(projectId: string, from: string | null, to: string): Promise<Diff> {
    return (await this.deps.projects.existing(projectId)).repo.diff(from, to);
  }

  async restore(
    actor: Actor,
    projectId: string,
    commit: string,
    paths?: string[],
  ): Promise<CommitSummary | null> {
    const h = await this.deps.projects.existing(projectId);
    const summary = await h.repo.restore({ commit, paths, actor });
    if (summary) this.activity(projectId, actor, 'history.restore', summary.message);
    return summary;
  }

  async branches(projectId: string): Promise<BranchInfo[]> {
    return (await this.deps.projects.existing(projectId)).repo.listBranches();
  }

  async createBranch(actor: Actor, projectId: string, name: string, from?: string): Promise<BranchInfo> {
    const b = await (await this.deps.projects.existing(projectId)).repo.createBranch(name, from);
    this.activity(projectId, actor, 'branch.create', `Created branch ${name}`);
    return b;
  }

  async switchBranch(
    actor: Actor,
    projectId: string,
    name: string,
  ): Promise<{ branch: string; commit: string | null }> {
    const r = await (await this.deps.projects.existing(projectId)).repo.switchBranch(name);
    this.activity(projectId, actor, 'branch.switch', `Switched to branch ${name}`);
    return r;
  }

  async deleteBranch(_actor: Actor, projectId: string, name: string): Promise<void> {
    await (await this.deps.projects.existing(projectId)).repo.deleteBranch(name);
  }

  async tags(projectId: string): Promise<TagInfo[]> {
    return (await this.deps.projects.existing(projectId)).repo.listTags();
  }

  async createTag(
    actor: Actor,
    projectId: string,
    name: string,
    commit?: string,
    message?: string,
  ): Promise<TagInfo> {
    const t = await (await this.deps.projects.existing(projectId)).repo.createTag({
      name,
      commit,
      message,
      actor,
    });
    this.activity(projectId, actor, 'tag.create', `Tagged ${t.commit.slice(0, 8)} as ${t.name}`);
    return t;
  }
}
