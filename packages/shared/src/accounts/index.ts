import type { Permission, ProjectAccess, ProjectRole } from '../schemas/accounts';

/** Roles from weakest to strongest (docs/design/accounts.md#users-roles-and-projects). */
export const PROJECT_ROLES: readonly ProjectRole[] = ['reviewer', 'editor', 'director'];
const RANK: Record<ProjectRole, number> = { reviewer: 1, editor: 2, director: 3 };

/** The minimal role of every permission: one table for REST, MCP, the live WebSocket and editor jobs. */
export const PERMISSIONS: Record<Permission, ProjectRole> = {
  'project.read': 'reviewer',
  'project.comment': 'reviewer',
  'project.edit': 'editor',
  'project.approve': 'director',
  'project.manage': 'director',
};

export function can(role: ProjectRole | null | undefined, permission: Permission): boolean {
  return !!role && RANK[role] >= RANK[PERMISSIONS[permission]];
}

export const minRole = (a: ProjectRole, b: ProjectRole): ProjectRole => (RANK[a] <= RANK[b] ? a : b);

/** Who is asking, as far as permissions go. */
export interface AccessSubject {
  userId: string;
  admin: boolean;
  /** An agent token's cap and projects (null: no cap, every project). */
  token?: { role: ProjectRole; projectIds: string[] | null } | null;
}

/**
 * A subject's role in a project: admins direct everything; projects without access settings are open (their
 * creator predates accounts); members have their role; studio-visible projects let everyone review. An agent token
 * lowers it to its cap and to its projects.
 */
export function projectRole(
  subject: AccessSubject,
  project: { id: string; access?: ProjectAccess | null },
): ProjectRole | null {
  let role: ProjectRole | null;
  if (subject.admin || !project.access) role = 'director';
  else
    role =
      project.access.members.find((m) => m.userId === subject.userId)?.role ??
      (project.access.visibility === 'studio' ? 'reviewer' : null);
  if (role && subject.token) {
    if (subject.token.projectIds && !subject.token.projectIds.includes(project.id)) return null;
    role = minRole(role, subject.token.role);
  }
  return role;
}

/** A route's permission (docs/design/accounts.md): explicit rules first, then reads and writes by method. */
export interface RoutePermission {
  method: string;
  /** Path after `/api/projects/:id`, as a regular expression. */
  path: RegExp;
  permission: Permission;
}

export const ROUTE_PERMISSIONS: RoutePermission[] = [
  // Approvals (gates, clips, takes, boards)
  { method: 'POST', path: /^\/workflow\/approve$/, permission: 'project.approve' },
  { method: 'POST', path: /^\/workflow\/reopen$/, permission: 'project.approve' },
  { method: 'POST', path: /^\/clips\/[^/]+\/(approve|unapprove)$/, permission: 'project.approve' },
  {
    method: 'POST',
    path: /^\/clips\/[^/]+\/shots\/[^/]+\/takes\/[^/]+\/override$/,
    permission: 'project.approve',
  },
  { method: 'POST', path: /^\/clips\/[^/]+\/shots\/[^/]+\/board\/approve$/, permission: 'project.approve' },
  { method: 'POST', path: /^\/storyboard\/approve-all$/, permission: 'project.approve' },
  // Settings, access, branches, deletion
  { method: 'PATCH', path: /^$/, permission: 'project.manage' },
  { method: 'DELETE', path: /^$/, permission: 'project.manage' },
  { method: 'PUT', path: /^\/access$/, permission: 'project.manage' },
  { method: 'POST', path: /^\/branches(\/.*)?$/, permission: 'project.manage' },
  { method: 'DELETE', path: /^\/branches\/.+$/, permission: 'project.manage' },
  // Review comments and decisions (docs/design/review.md); reviews are asked for by directors
  { method: 'POST', path: /^\/comments(\/.*)?$/, permission: 'project.comment' },
  { method: 'PATCH', path: /^\/comments(\/.*)?$/, permission: 'project.comment' },
  { method: 'POST', path: /^\/reviews\/[^/]+\/decisions$/, permission: 'project.comment' },
  { method: 'POST', path: /^\/reviews$/, permission: 'project.approve' },
  { method: 'DELETE', path: /^\/reviews\/[^/]+\/link$/, permission: 'project.approve' },
];

export function routePermission(method: string, rest: string): Permission {
  const m = method.toUpperCase();
  const rule = ROUTE_PERMISSIONS.find((r) => r.method === m && r.path.test(rest));
  if (rule) return rule.permission;
  return m === 'GET' || m === 'HEAD' || m === 'OPTIONS' ? 'project.read' : 'project.edit';
}
