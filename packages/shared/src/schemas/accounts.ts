import { z } from 'zod';
import { IdSchema, IsoDateSchema } from './common';

/** Project roles, weakest first (docs/design/accounts.md#users-roles-and-projects). */
export const ProjectRoleSchema = z.enum(['reviewer', 'editor', 'director']);
export type ProjectRole = z.infer<typeof ProjectRoleSchema>;

export const PermissionSchema = z.enum([
  'project.read',
  'project.comment',
  'project.edit',
  'project.approve',
  'project.manage',
]);
export type Permission = z.infer<typeof PermissionSchema>;

export const ProjectMemberSchema = z.object({ userId: IdSchema, role: ProjectRoleSchema });
export type ProjectMember = z.infer<typeof ProjectMemberSchema>;

export const ProjectInviteSchema = z.object({
  email: z.string().email().max(320),
  role: ProjectRoleSchema,
  invitedBy: z.string().max(128),
  at: IsoDateSchema,
});
export type ProjectInvite = z.infer<typeof ProjectInviteSchema>;

/** Who may do what in a project; absent on projects from before accounts (open to everyone). */
export const ProjectAccessSchema = z.object({
  /** `studio`: every member of the studio reads and comments (reviewer). */
  visibility: z.enum(['private', 'studio']).default('private'),
  members: z.array(ProjectMemberSchema).max(500).default([]),
  invites: z.array(ProjectInviteSchema).max(500).default([]),
});
export type ProjectAccess = z.infer<typeof ProjectAccessSchema>;

export const StudioRoleSchema = z.enum(['admin', 'member']);
export type StudioRole = z.infer<typeof StudioRoleSchema>;

/** A person of the studio (`/rideo/accounts/users/<id>.json`). */
export const UserSchema = z.object({
  id: IdSchema,
  issuer: z.string().max(500),
  sub: z.string().max(500),
  email: z.string().max(320),
  name: z.string().max(200),
  studioRole: StudioRoleSchema.default('member'),
  disabled: z.boolean().default(false),
  createdAt: IsoDateSchema,
  lastLoginAt: IsoDateSchema.nullable().default(null),
});
export type User = z.infer<typeof UserSchema>;
export type PublicUser = Pick<User, 'id' | 'email' | 'name' | 'studioRole' | 'disabled'>;

/** A scoped agent token (`/rideo/accounts/tokens/<id>.json`); the secret is stored as its SHA-256 only. */
export const AgentTokenSchema = z.object({
  id: IdSchema,
  userId: IdSchema,
  name: z.string().min(1).max(100),
  hash: z.string().length(64),
  /** The most it may do: its role on a project is the lower of this and its owner's. */
  role: ProjectRoleSchema,
  /** Only these projects (null: every project of the owner). */
  projectIds: z.array(IdSchema).max(200).nullable().default(null),
  createdAt: IsoDateSchema,
  expiresAt: IsoDateSchema.nullable().default(null),
  lastUsedAt: IsoDateSchema.nullable().default(null),
  revokedAt: IsoDateSchema.nullable().default(null),
});
export type AgentToken = z.infer<typeof AgentTokenSchema>;
export type TokenInfo = Omit<AgentToken, 'hash'>;

export const AuditEventTypeSchema = z.enum([
  'auth.login',
  'auth.logout',
  'auth.failed',
  'auth.denied',
  'token.created',
  'token.revoked',
  'user.updated',
  'project.access',
  'project.approval',
]);
export type AuditEventType = z.infer<typeof AuditEventTypeSchema>;

export const AuditEventSchema = z.object({
  at: IsoDateSchema,
  type: AuditEventTypeSchema,
  actor: z.object({
    kind: z.string(),
    id: z.string(),
    name: z.string().optional(),
    userId: z.string().optional(),
  }),
  projectId: z.string().nullable().default(null),
  outcome: z.enum(['ok', 'denied', 'failed']).default('ok'),
  detail: z.record(z.string(), z.unknown()).default({}),
});
export type AuditEvent = z.infer<typeof AuditEventSchema>;

/** What `GET /api/auth/me` answers. */
export interface AuthMe {
  mode: 'none' | 'token' | 'oidc';
  /** The provider's label for the sign-in button (oidc). */
  provider: string | null;
  user: PublicUser | null;
  /** Calling through an agent token. */
  token: { id: string; name: string; role: ProjectRole } | null;
  admin: boolean;
}
