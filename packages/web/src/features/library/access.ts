import { type AuthMe, libraryAllows } from '@rideo/shared';

/**
 * What the signed-in person may do with the studio library (`libraryAllows`, docs/design/library.md#permissions), to
 * hide or disable controls. Without accounts (or before `me` arrives) the configured user may do everything; the
 * server decides anyway.
 */
function subject(me: AuthMe) {
  return {
    userId: me.user!.id,
    admin: me.admin && !me.token,
    // the studio does not tell a token's projects: the server refuses a token limited to projects (403)
    token: me.token ? { role: me.token.role, projectIds: null } : null,
  };
}

/** Publish: Save to library (new items and versions). */
export function mayPublish(me: AuthMe | null): boolean {
  if (me?.mode !== 'oidc' || !me.user) return true;
  return libraryAllows(subject(me), 'publish');
}

/** Manage an item: rename, describe, tag, make a version current, archive (its owner or an admin). */
export function mayManage(me: AuthMe | null, ownerId: string): boolean {
  if (me?.mode !== 'oidc' || !me.user) return true;
  return libraryAllows(subject(me), 'manage', ownerId);
}
