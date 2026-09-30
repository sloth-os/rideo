import {
  type Actor,
  type AutoActionId,
  docsFromEntries,
  evaluateWorkflow,
  type Project,
  type ProjectDocs,
  type StageId,
  SYSTEM_ACTOR,
  sortedClips,
  stageOfGate,
  type WorkflowEvaluation,
  workflowFor,
} from '@rideo/shared';
import { AppError, conflict, invalid } from '../errors';
import { Service } from './base';

export interface AutoActionRunner {
  run(action: AutoActionId, projectId: string, docs: ProjectDocs, actor: Actor): Promise<void>;
}

/** Declarative workflow gates (docs/design/workflows.md). */
export class WorkflowService extends Service {
  autoActions?: AutoActionRunner;

  async evaluate(projectId: string): Promise<WorkflowEvaluation> {
    return evaluateWorkflow(await this.deps.projects.docs(projectId));
  }

  /** Approves the current stage's gate when every requirement holds, tags the commit and enters the next stage. */
  async approve(actor: Actor, projectId: string, gate: string): Promise<WorkflowEvaluation> {
    const h = await this.deps.projects.existing(projectId);
    const tags = new Set((await h.repo.listTags()).map((t) => t.name));
    const { result } = await this.mutate(
      actor,
      projectId,
      (tx) => {
        const docs = docsFromEntries(tx.entries());
        const project = docs.project;
        this.assertAgentMay(project, actor, 'approve');
        const found = stageOfGate(project.kind, gate);
        if (!found) throw invalid(`unknown gate ${gate} for ${project.kind} projects`);
        const ev = evaluateWorkflow(docs);
        if (found.index !== ev.stageIndex) {
          throw conflict(`gate ${gate} belongs to stage ${found.stage.id}; the project is at ${ev.stage}`);
        }
        const stageEval = ev.stages[found.index]!;
        const unmet = stageEval.gate!.requirements.filter((r) => !r.ok);
        if (unmet.length) {
          throw new AppError(
            'gate_unmet',
            `Cannot approve ${gate}: ${unmet.map((r) => r.message).join('; ')}`,
            unmet.map((r) => ({ requirement: r.id, message: r.message, details: r.details ?? [] })),
          );
        }
        const base = found.stage.gate!.tag;
        let tag = base;
        for (let n = 2; tags.has(tag); n++) tag = `${base}-${n}`;
        const def = workflowFor(project.kind);
        const next = def.stages[found.index + 1]?.id ?? found.stage.id;
        const updated: Project = {
          ...project,
          workflow: {
            stage: next,
            approvals: {
              ...project.workflow.approvals,
              [gate]: { at: new Date().toISOString(), actor, tag },
            },
          },
        };
        if (gate === 'pilot_approved')
          updated.settings = { ...updated.settings, models: this.pinnedModels(docs) };
        tx.set('project.json', updated);
        return { tag, next };
      },
      { message: (r) => `Approve ${gate} → ${r.next}`, meta: { gate } },
    );
    await h.repo.createTag({ name: result.tag, message: `Approved ${gate}`, actor, unique: true });
    await this.enterStage(projectId, result.next as StageId, actor);
    return this.evaluate(projectId);
  }

  /** Model pinning (docs/design/generation-pipeline.md#batch-generation): auto → models the pilot actually used. */
  private pinnedModels(docs: ProjectDocs): Project['settings']['models'] {
    const models = { ...docs.project.settings.models };
    const pilot = sortedClips(docs)[0];
    const takes = (pilot?.shots ?? [])
      .map((s) => s.takes.find((t) => t.id === s.selectedTakeId))
      .filter((t) => !!t);
    const image = takes.find((t) => t!.request.imageModel)?.request.imageModel;
    const video = takes.find((t) => t!.request.videoModel)?.request.videoModel;
    if (models.image === 'auto' && image) models.image = image;
    if (models.video === 'auto' && video) models.video = video;
    return models;
  }

  /** Moves back to an earlier stage; later approvals are cleared (the history keeps them). */
  async reopen(actor: Actor, projectId: string, stage: string): Promise<WorkflowEvaluation> {
    await this.mutate(
      actor,
      projectId,
      (tx) => {
        const project = tx.require<Project>('project.json', 'project');
        const def = workflowFor(project.kind);
        const target = def.stages.findIndex((s) => s.id === stage);
        const current = def.stages.findIndex((s) => s.id === project.workflow.stage);
        if (target < 0) throw invalid(`unknown stage ${stage}`);
        if (target > current)
          throw conflict(`cannot reopen ${stage}: it is ahead of ${project.workflow.stage}`);
        const cleared = def.stages
          .slice(target)
          .map((s) => s.gate?.id)
          .filter((g): g is NonNullable<typeof g> => !!g);
        const approvals = Object.fromEntries(
          Object.entries(project.workflow.approvals).filter(([g]) => !cleared.includes(g as never)),
        );
        tx.set('project.json', { ...project, workflow: { stage, approvals } });
      },
      { message: `Reopen stage ${stage}` },
    );
    return this.evaluate(projectId);
  }

  /** Runs the stage's auto actions when the project is on autopilot. */
  async enterStage(projectId: string, stage: StageId, actor: Actor): Promise<void> {
    const docs = await this.deps.projects.docs(projectId);
    if (!docs.project.settings.autopilot || !this.autoActions) return;
    const def = workflowFor(docs.project.kind).stages.find((s) => s.id === stage);
    for (const action of def?.autoOnEnter ?? []) {
      try {
        await this.autoActions.run(action, projectId, docs, {
          ...SYSTEM_ACTOR,
          onBehalfOf: { kind: actor.kind, id: actor.id, name: actor.name },
        });
      } catch (err) {
        this.deps.log.warn({ err, projectId, action }, 'auto action failed');
      }
    }
  }
}
