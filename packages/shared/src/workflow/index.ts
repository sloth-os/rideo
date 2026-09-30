import { clipBlockers, isAcceptable, takeState } from '../consistency';
import { approvedReferences } from '../schemas/character';
import { clipPlannedDuration } from '../schemas/clip';
import { type ProjectDocs, sortedClips } from '../schemas/documents';
import type { ProjectKind } from '../schemas/project';
import { outlineDuration } from '../schemas/screenplay';
import type { VideoItem } from '../schemas/timeline';

export type StageId =
  | 'brief'
  | 'screenplay'
  | 'cast'
  | 'resources'
  | 'pilot'
  | 'production'
  | 'edit'
  | 'export'
  | 'ingest'
  | 'analysis';

export type GateId =
  | 'brief_submitted'
  | 'screenplay_approved'
  | 'cast_locked'
  | 'resources_ready'
  | 'pilot_approved'
  | 'production_approved'
  | 'cut_approved'
  | 'source_ready'
  | 'suggestions_reviewed';

export type RequirementId =
  | 'brief.hasPrompt'
  | 'screenplay.hasScenes'
  | 'screenplay.outlineCoversTarget'
  | 'characters.nonEmpty'
  | 'characters.allLocked'
  | 'characters.allHaveApprovedRefs'
  | 'clips.pilotApproved'
  | 'clips.allApproved'
  | 'duration.targetReached'
  | 'timeline.nonEmpty'
  | 'timeline.consistencyVerified'
  | 'resources.hasSourceVideo'
  | 'analysis.completed'
  | 'exports.anySucceeded';

export type AutoActionId =
  | 'screenplay.generate'
  | 'characters.generateRefs'
  | 'clip.pilot'
  | 'batch.generate'
  | 'timeline.assemble'
  | 'analysis.run'
  | 'edit.auto';

export interface StageDef {
  id: StageId;
  title: string;
  description: string;
  gate?: { id: GateId; title: string; requirements: RequirementId[]; tag: string };
  autoOnEnter?: AutoActionId[];
}

export interface WorkflowDefinition {
  kind: ProjectKind;
  stages: StageDef[];
}

export const STORY_WORKFLOW: WorkflowDefinition = {
  kind: 'story',
  stages: [
    {
      id: 'brief',
      title: 'Brief',
      description: 'Describe the movie; attach reference images or videos.',
      gate: { id: 'brief_submitted', title: 'Submit brief', requirements: ['brief.hasPrompt'], tag: 'brief' },
    },
    {
      id: 'screenplay',
      title: 'Screenplay',
      description: 'Generate and fine-tune the screenplay, outline and cast.',
      gate: {
        id: 'screenplay_approved',
        title: 'Approve screenplay',
        requirements: ['screenplay.hasScenes', 'characters.nonEmpty', 'screenplay.outlineCoversTarget'],
        tag: 'screenplay-approved',
      },
      autoOnEnter: ['screenplay.generate'],
    },
    {
      id: 'cast',
      title: 'Cast',
      description: 'Generate or upload references and lock every character.',
      gate: {
        id: 'cast_locked',
        title: 'Lock cast',
        requirements: ['characters.allLocked', 'characters.allHaveApprovedRefs'],
        tag: 'cast-locked',
      },
      autoOnEnter: ['characters.generateRefs'],
    },
    {
      id: 'resources',
      title: 'Resources',
      description: 'Add audio, music, images or footage (optional).',
      gate: { id: 'resources_ready', title: 'Continue', requirements: [], tag: 'resources-ready' },
    },
    {
      id: 'pilot',
      title: 'Pilot clip',
      description: 'Generate the first clip, fine-tune it and approve the look.',
      gate: {
        id: 'pilot_approved',
        title: 'Approve pilot',
        requirements: ['clips.pilotApproved'],
        tag: 'pilot-approved',
      },
      autoOnEnter: ['clip.pilot'],
    },
    {
      id: 'production',
      title: 'Production',
      description: 'Generate the remaining clips up to the target length and review them.',
      gate: {
        id: 'production_approved',
        title: 'Approve production',
        requirements: ['clips.allApproved', 'duration.targetReached'],
        tag: 'production-approved',
      },
      autoOnEnter: ['batch.generate'],
    },
    {
      id: 'edit',
      title: 'Edit',
      description: 'Edit the assembled timeline.',
      gate: {
        id: 'cut_approved',
        title: 'Approve cut',
        requirements: ['timeline.nonEmpty', 'timeline.consistencyVerified'],
        tag: 'cut-approved',
      },
      autoOnEnter: ['timeline.assemble'],
    },
    { id: 'export', title: 'Export', description: 'Render and download the movie.' },
  ],
};

export const EDIT_WORKFLOW: WorkflowDefinition = {
  kind: 'edit',
  stages: [
    {
      id: 'ingest',
      title: 'Ingest',
      description: 'Upload the footage to edit.',
      gate: {
        id: 'source_ready',
        title: 'Analyze footage',
        requirements: ['resources.hasSourceVideo'],
        tag: 'source-ready',
      },
    },
    {
      id: 'analysis',
      title: 'Analysis',
      description: 'Review the AI edit suggestions.',
      gate: {
        id: 'suggestions_reviewed',
        title: 'Apply suggestions',
        requirements: ['analysis.completed'],
        tag: 'suggestions-reviewed',
      },
      autoOnEnter: ['analysis.run'],
    },
    {
      id: 'edit',
      title: 'Edit',
      description: 'Fine-tune the automatic edit.',
      gate: {
        id: 'cut_approved',
        title: 'Approve cut',
        requirements: ['timeline.nonEmpty'],
        tag: 'cut-approved',
      },
      autoOnEnter: ['edit.auto'],
    },
    { id: 'export', title: 'Export', description: 'Render and download the edit.' },
  ],
};

export function workflowFor(kind: ProjectKind): WorkflowDefinition {
  return kind === 'story' ? STORY_WORKFLOW : EDIT_WORKFLOW;
}

export function initialStage(kind: ProjectKind): StageId {
  return workflowFor(kind).stages[0]!.id;
}

export interface RequirementResult {
  id: RequirementId;
  ok: boolean;
  message: string;
  details?: string[];
}

export const TARGET_REACHED_RATIO = 0.97;

export function plannedDuration(docs: Pick<ProjectDocs, 'clips'>): number {
  return Object.values(docs.clips).reduce((s, c) => s + clipPlannedDuration(c), 0);
}

export function approvedDuration(docs: Pick<ProjectDocs, 'clips'>): number {
  return Object.values(docs.clips)
    .filter((c) => c.status === 'approved')
    .reduce((s, c) => s + clipPlannedDuration(c), 0);
}

type Check = (docs: ProjectDocs) => Omit<RequirementResult, 'id'>;

const CHECKS: Record<RequirementId, Check> = {
  'brief.hasPrompt': (d) => ({
    ok: d.project.brief.prompt.trim().length >= 3,
    message: 'Write a short prompt describing the movie',
  }),
  'screenplay.hasScenes': (d) => ({
    ok: (d.screenplay?.scenes.length ?? 0) > 0,
    message: 'The screenplay needs at least one written scene',
  }),
  'screenplay.outlineCoversTarget': (d) => {
    const covered = d.screenplay ? outlineDuration(d.screenplay) : 0;
    const target = d.project.settings.targetDurationSec;
    return {
      ok: covered >= target * 0.9,
      message: `The outline covers ${Math.round(covered)}s of the ${Math.round(target)}s target`,
    };
  },
  'characters.nonEmpty': (d) => ({
    ok: Object.keys(d.characters).length > 0,
    message: 'Add at least one character',
  }),
  'characters.allLocked': (d) => {
    const unlocked = Object.values(d.characters).filter((c) => !c.lock.locked);
    return {
      ok: Object.keys(d.characters).length > 0 && unlocked.length === 0,
      message: unlocked.length ? `${unlocked.length} character(s) not locked` : 'Add and lock the cast',
      details: unlocked.map((c) => c.name),
    };
  },
  'characters.allHaveApprovedRefs': (d) => {
    const missing = Object.values(d.characters).filter((c) => approvedReferences(c).length === 0);
    return {
      ok: Object.keys(d.characters).length > 0 && missing.length === 0,
      message: missing.length
        ? `${missing.length} character(s) without an approved reference`
        : 'Add references',
      details: missing.map((c) => c.name),
    };
  },
  'clips.pilotApproved': (d) => {
    const pilot = sortedClips(d)[0];
    return {
      ok: pilot?.status === 'approved',
      message: pilot ? 'Approve the pilot clip' : 'Plan and generate the pilot clip',
    };
  },
  'clips.allApproved': (d) => {
    const clips = sortedClips(d);
    const pending = clips.filter((c) => c.status !== 'approved');
    return {
      ok: clips.length > 0 && pending.length === 0,
      message: pending.length ? `${pending.length} clip(s) awaiting approval` : 'No clips yet',
      details: pending.map((c) => c.title),
    };
  },
  'duration.targetReached': (d) => {
    const target = d.project.settings.targetDurationSec;
    const approved = approvedDuration(d);
    const sp = d.screenplay;
    const storyComplete =
      !!sp &&
      sp.ended &&
      sp.outline.length > 0 &&
      sp.outline.every((b) => !!b.sceneId) &&
      sortedClips(d).length > 0;
    return {
      ok: approved >= target * TARGET_REACHED_RATIO || storyComplete,
      message: `${Math.round(approved)}s of ${Math.round(target)}s approved`,
    };
  },
  'timeline.nonEmpty': (d) => {
    const video = d.timeline?.tracks.find((t) => t.kind === 'video');
    return { ok: (video?.items.length ?? 0) > 0, message: 'The timeline is empty' };
  },
  'timeline.consistencyVerified': (d) => {
    const video = d.timeline?.tracks.find((t) => t.kind === 'video');
    const problems: string[] = [];
    for (const item of (video?.items ?? []) as VideoItem[]) {
      if (item.source.type !== 'take') continue;
      const clip = d.clips[item.source.clipId];
      const shot = clip?.shots.find((s) => s.id === (item.source as { shotId: string }).shotId);
      const take = shot?.takes.find((t) => t.id === (item.source as { takeId: string }).takeId);
      if (!clip || !shot || !take) {
        problems.push(`${item.label ?? item.id}: referenced take no longer exists`);
        continue;
      }
      const state = takeState(take, shot, d.characters);
      if (!isAcceptable(state)) problems.push(`${item.label ?? item.id}: take is ${state}`);
    }
    return {
      ok: problems.length === 0,
      message: problems.length
        ? `${problems.length} timeline item(s) fail the consistency gate`
        : 'All takes verified',
      details: problems,
    };
  },
  'resources.hasSourceVideo': (d) => ({
    ok: Object.values(d.resources).some(
      (r) => r.kind === 'video' && r.role === 'source' && r.status === 'ready',
    ),
    message: 'Upload a source video',
  }),
  'analysis.completed': (d) => ({
    ok: Object.values(d.analyses).some((a) => a.status === 'completed'),
    message: 'Run the footage analysis',
  }),
  'exports.anySucceeded': (d) => ({
    ok: Object.values(d.exports).some((e) => e.status === 'succeeded'),
    message: 'Render an export',
  }),
};

export function checkRequirement(id: RequirementId, docs: ProjectDocs): RequirementResult {
  return { id, ...CHECKS[id](docs) };
}

export interface StageEvaluation {
  id: StageId;
  title: string;
  description: string;
  status: 'done' | 'current' | 'upcoming';
  gate?: {
    id: GateId;
    title: string;
    approved: boolean;
    satisfied: boolean;
    requirements: RequirementResult[];
  };
}

export interface WorkflowEvaluation {
  kind: ProjectKind;
  stage: StageId;
  stageIndex: number;
  stages: StageEvaluation[];
  done: boolean;
  plannedDurationSec: number;
  approvedDurationSec: number;
  targetDurationSec: number;
}

export function evaluateWorkflow(docs: ProjectDocs): WorkflowEvaluation {
  const def = workflowFor(docs.project.kind);
  const current = docs.project.workflow.stage as StageId;
  const stageIndex = Math.max(
    0,
    def.stages.findIndex((s) => s.id === current),
  );
  const stages: StageEvaluation[] = def.stages.map((s, i) => {
    const gate = s.gate
      ? (() => {
          const requirements = s.gate.requirements.map((r) => checkRequirement(r, docs));
          return {
            id: s.gate.id,
            title: s.gate.title,
            approved: !!docs.project.workflow.approvals[s.gate.id],
            satisfied: requirements.every((r) => r.ok),
            requirements,
          };
        })()
      : undefined;
    return {
      id: s.id,
      title: s.title,
      description: s.description,
      status: i < stageIndex ? 'done' : i === stageIndex ? 'current' : 'upcoming',
      gate,
    };
  });
  const last = def.stages[def.stages.length - 1]!;
  return {
    kind: def.kind,
    stage: def.stages[stageIndex]!.id,
    stageIndex,
    stages,
    done: current === last.id && CHECKS['exports.anySucceeded'](docs).ok,
    plannedDurationSec: plannedDuration(docs),
    approvedDurationSec: approvedDuration(docs),
    targetDurationSec: docs.project.settings.targetDurationSec,
  };
}

export function stageOfGate(kind: ProjectKind, gate: string): { stage: StageDef; index: number } | null {
  const def = workflowFor(kind);
  const index = def.stages.findIndex((s) => s.gate?.id === gate);
  return index >= 0 ? { stage: def.stages[index]!, index } : null;
}

export function blockersForClip(docs: ProjectDocs, clipId: string) {
  const clip = docs.clips[clipId];
  return clip ? clipBlockers(clip, docs.characters) : [];
}
