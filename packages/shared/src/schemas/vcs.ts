import { z } from 'zod';
import { ActorSchema, IsoDateSchema } from './common';

export const ChangeOpSchema = z.enum(['add', 'modify', 'delete']);
export type ChangeOp = z.infer<typeof ChangeOpSchema>;

export const CommitChangeSchema = z.object({ path: z.string(), op: ChangeOpSchema });
export type CommitChange = z.infer<typeof CommitChangeSchema>;

export const CommitSummarySchema = z.object({
  id: z.string(),
  parents: z.array(z.string()),
  author: ActorSchema,
  message: z.string(),
  timestamp: IsoDateSchema,
  changes: z.array(CommitChangeSchema),
  branch: z.string().optional(),
  tags: z.array(z.string()).optional(),
  meta: z.record(z.string(), z.unknown()).optional(),
});
export type CommitSummary = z.infer<typeof CommitSummarySchema>;

export const JsonDiffOpSchema = z.object({
  op: z.enum(['add', 'remove', 'replace']),
  pointer: z.string(),
  before: z.unknown().optional(),
  after: z.unknown().optional(),
});
export type JsonDiffOp = z.infer<typeof JsonDiffOpSchema>;

export const DiffEntrySchema = z.object({
  path: z.string(),
  op: ChangeOpSchema,
  ops: z.array(JsonDiffOpSchema).optional(),
});
export type DiffEntry = z.infer<typeof DiffEntrySchema>;

export const DiffSchema = z.object({
  from: z.string().nullable(),
  to: z.string(),
  entries: z.array(DiffEntrySchema),
});
export type Diff = z.infer<typeof DiffSchema>;

export const BranchInfoSchema = z.object({
  name: z.string(),
  commit: z.string().nullable(),
  current: z.boolean(),
});
export type BranchInfo = z.infer<typeof BranchInfoSchema>;

export const TagInfoSchema = z.object({
  name: z.string(),
  commit: z.string(),
  message: z.string().optional(),
  actor: ActorSchema.optional(),
  createdAt: IsoDateSchema.optional(),
});
export type TagInfo = z.infer<typeof TagInfoSchema>;

export const REF_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
