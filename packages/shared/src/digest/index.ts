import { z } from 'zod';
import { ProjectAccessSchema } from '../schemas/accounts';
import { IsoDateSchema } from '../schemas/common';
import type { ProjectDocs } from '../schemas/documents';
import { ProjectSummarySchema } from '../schemas/project';
import type { CommitSummary } from '../schemas/vcs';
import { evaluateWorkflow } from '../workflow';

/**
 * What the project list and the Inbox show of a project, without reading its documents
 * (docs/design/storage-webdav.md#slow-and-flaky-servers): kept in memory and in `.rideo/summary.json`.
 */
export const ProjectDigestSchema = z.object({
  version: z.literal(1),
  /** The branch and the tip it was made from: a digest behind the tip is made again. */
  branch: z.string().min(1).max(200),
  commit: z.string().max(64).nullable(),
  summary: ProjectSummarySchema.omit({ role: true }),
  /** Who may see the project (`roleInProject`). */
  access: ProjectAccessSchema.nullable(),
  /** The current stage's gate. */
  gate: z
    .object({ id: z.string(), title: z.string(), satisfied: z.boolean(), approved: z.boolean() })
    .nullable(),
  /** The open reviews, with who decided each. */
  reviews: z
    .array(
      z.object({
        id: z.string(),
        title: z.string(),
        createdById: z.string(),
        createdBy: z.string(),
        createdAt: IsoDateSchema,
        gate: z.string().nullable(),
        deciders: z.array(z.string()),
      }),
    )
    .max(500),
  /** Agents' commits, newest first (the Inbox shows the last day's). */
  agents: z
    .array(z.object({ id: z.string(), message: z.string(), at: IsoDateSchema, agent: z.string() }))
    .max(50),
});
export type ProjectDigest = z.infer<typeof ProjectDigestSchema>;

/** Agents' commits a digest keeps. */
export const DIGEST_AGENT_COMMITS = 50;

/** The agents' commits among `commits` (newest first), as a digest keeps them. */
export function agentCommits(commits: readonly CommitSummary[]): ProjectDigest['agents'] {
  return commits
    .filter((c) => c.author.kind === 'agent')
    .slice(0, DIGEST_AGENT_COMMITS)
    .map((c) => ({ id: c.id, message: c.message, at: c.timestamp, agent: c.author.name ?? c.author.id }));
}

/** A project's digest from its documents, its tip and its agents' recent commits. */
export function projectDigest(input: {
  projectId: string;
  docs: ProjectDocs;
  branch: string;
  commit: string | null;
  /** When the branch last changed: its tip's time. */
  updatedAt?: string;
  agents: ProjectDigest['agents'];
}): ProjectDigest {
  const { docs } = input;
  const ev = evaluateWorkflow(docs);
  const gate = ev.stages.find((s) => s.id === ev.stage)?.gate;
  const poster = Object.values(docs.clips)
    .flatMap((c) => c.shots)
    .flatMap((s) => s.takes)
    .find((t) => t.video?.poster)?.video?.poster?.path;
  return {
    version: 1,
    branch: input.branch,
    commit: input.commit,
    summary: {
      id: input.projectId,
      kind: docs.project.kind,
      title: docs.project.title,
      stage: ev.stage,
      createdAt: docs.project.createdAt,
      ...(input.updatedAt ? { updatedAt: input.updatedAt } : {}),
      targetDurationSec: docs.project.settings.targetDurationSec,
      plannedDurationSec: ev.plannedDurationSec,
      approvedDurationSec: ev.approvedDurationSec,
      ...(poster ? { posterPath: poster } : {}),
    },
    access: docs.project.access,
    gate: gate
      ? { id: gate.id, title: gate.title, satisfied: gate.satisfied, approved: gate.approved }
      : null,
    reviews: Object.values(docs.reviews)
      .filter((r) => r.status === 'open')
      .slice(0, 500)
      .map((r) => ({
        id: r.id,
        title: r.title,
        createdById: r.createdBy.id,
        createdBy: r.createdBy.name,
        createdAt: r.createdAt,
        gate: r.gate,
        deciders: r.decisions.map((d) => d.author.id),
      })),
    agents: input.agents.slice(0, DIGEST_AGENT_COMMITS),
  };
}
