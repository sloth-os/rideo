import { describe, expect, it } from 'vitest';
import {
  can,
  libraryAllows,
  minRole,
  PERMISSIONS,
  type ProjectAccess,
  ProjectAccessSchema,
  ProjectSchema,
  projectRole,
  routePermission,
} from '../src';
import * as f from '../src/testing/fixtures';

const access = (overrides: Partial<ProjectAccess> = {}): ProjectAccess =>
  ProjectAccessSchema.parse({
    members: [
      { userId: 'usr_0000000000dir1', role: 'director' },
      { userId: 'usr_0000000000edi1', role: 'editor' },
      { userId: 'usr_0000000000rev1', role: 'reviewer' },
    ],
    ...overrides,
  });

describe('permissions (docs/design/accounts.md#users-roles-and-projects)', () => {
  it('orders roles and maps every permission to its minimal role', () => {
    expect(can('reviewer', 'project.read')).toBe(true);
    expect(can('reviewer', 'project.comment')).toBe(true);
    expect(can('reviewer', 'project.edit')).toBe(false);
    expect(can('editor', 'project.edit')).toBe(true);
    expect(can('editor', 'project.approve')).toBe(false);
    expect(can('director', 'project.manage')).toBe(true);
    expect(can(null, 'project.read')).toBe(false);
    expect(minRole('director', 'reviewer')).toBe('reviewer');
    expect(Object.keys(PERMISSIONS)).toHaveLength(5);
  });

  it('gives members their role, studio visibility a reviewer, admins and open projects a director', () => {
    const project = { id: 'prj_0000000000aaaa', access: access() };
    const as = (userId: string, extra: object = {}) =>
      projectRole({ userId, admin: false, ...extra }, project);
    expect(as('usr_0000000000edi1')).toBe('editor');
    expect(as('usr_0000000000none')).toBeNull();
    expect(
      projectRole(
        { userId: 'usr_0000000000none', admin: false },
        { ...project, access: access({ visibility: 'studio' }) },
      ),
    ).toBe('reviewer');
    expect(projectRole({ userId: 'usr_0000000000none', admin: true }, project)).toBe('director');
    expect(
      projectRole({ userId: 'usr_0000000000none', admin: false }, { id: project.id, access: null }),
    ).toBe('director');
    // older projects parse without access: open
    expect(ProjectSchema.parse({ ...f.project(), access: undefined }).access).toBeNull();
  });

  it('caps an agent token by its role and its projects', () => {
    const project = { id: 'prj_0000000000aaaa', access: access() };
    const token = (role: 'reviewer' | 'editor' | 'director', projectIds: string[] | null = null) => ({
      userId: 'usr_0000000000edi1',
      admin: false,
      token: { role, projectIds },
    });
    expect(projectRole(token('director'), project)).toBe('editor');
    expect(projectRole(token('reviewer'), project)).toBe('reviewer');
    expect(projectRole(token('editor', ['prj_0000000000bbbb']), project)).toBeNull();
    expect(projectRole(token('editor', [project.id]), project)).toBe('editor');
  });

  it('maps routes to permissions: reads, writes and the explicit rules', () => {
    expect(routePermission('GET', '/state')).toBe('project.read');
    expect(routePermission('POST', '/characters')).toBe('project.edit');
    expect(routePermission('POST', '/workflow/approve')).toBe('project.approve');
    expect(routePermission('POST', '/clips/clp_1/approve')).toBe('project.approve');
    expect(routePermission('POST', '/clips/clp_1/shots/sht_1/takes/tak_1/override')).toBe('project.approve');
    expect(routePermission('PATCH', '')).toBe('project.manage');
    expect(routePermission('PUT', '/access')).toBe('project.manage');
    expect(routePermission('DELETE', '/branches/main')).toBe('project.manage');
    expect(routePermission('POST', '/comments')).toBe('project.comment');
    expect(routePermission('DELETE', '/characters/chr_1')).toBe('project.edit');
  });
});

describe('the studio library (docs/design/library.md#permissions)', () => {
  const ana = { userId: 'usr_0000000000ana1', admin: false, token: null };
  const admin = { userId: 'usr_0000000000adm1', admin: true, token: null };
  const token = (role: 'reviewer' | 'editor' | 'director', projectIds: string[] | null, of = ana) => ({
    ...of,
    token: { role, projectIds },
  });

  it('lets every caller read, people and unscoped editor tokens publish, owners and admins manage', () => {
    for (const s of [ana, admin, token('reviewer', ['prj_0000000000aaaa']), token('editor', null)])
      expect(libraryAllows(s, 'read')).toBe(true);
    expect(libraryAllows(ana, 'publish')).toBe(true);
    expect(libraryAllows(admin, 'publish')).toBe(true);
    expect(libraryAllows(token('editor', null), 'publish')).toBe(true);
    expect(libraryAllows(token('director', null), 'publish')).toBe(true);
    // a token limited to some projects, or below editor, never publishes studio-wide
    expect(libraryAllows(token('director', ['prj_0000000000aaaa']), 'publish')).toBe(false);
    expect(libraryAllows(token('reviewer', null), 'publish')).toBe(false);
    // managing: the owner, her unscoped editor tokens, an admin in person
    expect(libraryAllows(ana, 'manage', ana.userId)).toBe(true);
    expect(libraryAllows(ana, 'manage', 'usr_0000000000bob1')).toBe(false);
    expect(libraryAllows(ana, 'manage')).toBe(false);
    expect(libraryAllows(token('editor', null), 'manage', ana.userId)).toBe(true);
    expect(libraryAllows(token('reviewer', null), 'manage', ana.userId)).toBe(false);
    expect(libraryAllows(token('editor', ['prj_0000000000aaaa']), 'manage', ana.userId)).toBe(false);
    expect(libraryAllows(admin, 'manage', ana.userId)).toBe(true);
    expect(libraryAllows(token('director', null, admin), 'manage', ana.userId)).toBe(false);
  });
});
