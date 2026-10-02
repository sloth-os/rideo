import { z } from 'zod';
import { ActorSchema, IdSchema, IsoDateSchema } from './common';
import { JobKindSchema, JobStatusSchema } from './job';

/** What waits for a person across their projects (docs/design/pwa.md#the-inbox). */
const ProjectRefSchema = z.object({ id: IdSchema, title: z.string() });

export const InboxSchema = z.object({
  /** Gates whose checks pass, for people who may approve them. */
  approvals: z.array(
    z.object({
      project: ProjectRefSchema,
      stage: z.string(),
      gate: z.object({ id: z.string(), title: z.string() }),
    }),
  ),
  /** Open reviews the person has not decided (and did not ask for). */
  reviews: z.array(
    z.object({
      project: ProjectRefSchema,
      review: z.object({
        id: IdSchema,
        title: z.string(),
        createdBy: z.string(),
        createdAt: IsoDateSchema,
        gate: z.string().nullable(),
      }),
    }),
  ),
  /** Jobs running now, and jobs that failed in the last 24 hours. */
  jobs: z.array(
    z.object({
      project: ProjectRefSchema,
      job: z.object({
        id: IdSchema,
        kind: JobKindSchema,
        status: JobStatusSchema,
        progress: z.object({ done: z.number(), total: z.number(), message: z.string().optional() }),
        actor: ActorSchema,
        createdAt: IsoDateSchema,
        error: z.string().nullable(),
      }),
      canCancel: z.boolean(),
    }),
  ),
  /** Agents' commits of the last 24 hours, newest first. */
  agents: z.array(
    z.object({
      project: ProjectRefSchema,
      commit: z.object({ id: z.string(), message: z.string(), at: IsoDateSchema, agent: z.string() }),
    }),
  ),
  /** Approvals and reviews waiting: the badge's number. */
  waiting: z.number().int().nonnegative(),
});
export type Inbox = z.infer<typeof InboxSchema>;
