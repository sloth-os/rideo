import {
  type AuthMe,
  can,
  type Permission,
  type Project,
  type ProjectRole,
  projectRole,
} from '@rideo/shared';
import { create } from 'zustand';
import { api, setUnauthorizedHandler } from './api';
import { appUrl, getRuntime, routePath } from './runtime';

/**
 * Who is signed in (docs/design/accounts.md): loaded once; a 401 sends people to the sign-in page when the studio
 * has accounts.
 */
interface AuthState {
  me: AuthMe | null;
  loaded: boolean;
  load(): Promise<void>;
  signOut(): Promise<void>;
}

export const useAuth = create<AuthState>((set, get) => ({
  me: null,
  loaded: false,
  async load() {
    try {
      set({ me: await api.me(), loaded: true });
    } catch {
      set({ loaded: true });
    }
  },
  async signOut() {
    await api.logout().catch(() => undefined);
    set({ me: { ...(get().me as AuthMe), user: null, token: null, admin: false } });
    // embedded in another app, the studio's router shows the sign-in page; never the host's location
    if (!getRuntime().embedded) window.location.assign(appUrl('/login'));
  },
}));

/** The sign-in route (router path) that comes back to `returnTo` (a router path too, docs/design/subpath.md). */
export function loginUrl(returnTo = routePath(window.location.pathname) + window.location.search): string {
  return `/login?returnTo=${encodeURIComponent(returnTo)}`;
}

setUnauthorizedHandler(() => {
  const me = useAuth.getState().me;
  if (
    me?.mode === 'oidc' &&
    !getRuntime().embedded &&
    !routePath(window.location.pathname).startsWith('/login')
  )
    window.location.assign(appUrl(loginUrl()));
  // embedded: the session is gone; `Signed` sends the studio's own router to the sign-in page
  else if (me?.mode === 'oidc' && getRuntime().embedded) useAuth.setState({ me: { ...me, user: null } });
});

/** The signed-in person's role in a project, and what it allows. */
export function useProjectRole(project: Pick<Project, 'id' | 'access'> | null | undefined): {
  role: ProjectRole | null;
  can: (permission: Permission) => boolean;
} {
  const me = useAuth((s) => s.me);
  if (!project) return { role: null, can: () => false };
  // Without accounts (or before `me` arrives) the configured user may do everything; the server decides anyway.
  const role =
    me?.mode !== 'oidc' || !me.user
      ? 'director'
      : projectRole(
          {
            userId: me.user.id,
            admin: me.admin && !me.token,
            token: me.token ? { role: me.token.role, projectIds: null } : null,
          },
          project,
        );
  return { role, can: (permission) => can(role, permission) };
}
