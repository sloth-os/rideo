import { type Actor, can, type FocusKind, type SessionInfo, type UiCommand, type View } from '@rideo/shared';
import type { AccountsService } from '../auth/accounts';
import { currentPrincipal } from '../auth/context';
import type { LiveHub, UiReach } from '../live/hub';

/** A session showing only the projects `shown` accepts; a presence on no project only to the tab's own person. */
function only(s: SessionInfo, shown: (projectId: string) => boolean, own = false): SessionInfo {
  const where = s.presence?.projectId;
  return {
    ...s,
    projectIds: s.projectIds.filter(shown),
    presence: s.presence && (where ? shown(where) : own) ? s.presence : null,
  };
}

/**
 * Agent-driven UI commands relayed to open browsers (docs/design/realtime-sync.md#ui-commands). Outside auth mode
 * `none` they stay within the projects their caller may use (#who-sees-and-steers-which-tabs): a command reaches only
 * the tabs on its project, for which the caller was authorized (the MCP tool's permission, or the recipe run's), and the
 * listing shows a caller only the tabs and projects it may see. In auth mode `none` every tab is the one person's.
 */
export class UiService {
  constructor(
    private readonly hub: LiveHub,
    private readonly accounts: Pick<AccountsService, 'mode' | 'roleIn'>,
  ) {}

  /**
   * The open tabs the caller may see. With a project (the caller was allowed to read it): the tabs on it, showing that
   * project alone. Without: the caller's own tabs and those on projects it may read, each showing only those projects.
   */
  async sessions(projectId?: string): Promise<SessionInfo[]> {
    const open = this.hub.sessionsWithUser(projectId);
    if (this.accounts.mode === 'none') return open.map((o) => o.session);
    if (projectId) return open.map(({ session }) => only(session, (p) => p === projectId));
    const principal = currentPrincipal();
    if (!principal) return [];
    const asked = new Map<string, Promise<boolean>>();
    const mayRead = (projectId: string) => {
      let answer = asked.get(projectId);
      if (!answer) {
        answer = this.accounts.roleIn(principal, projectId).then(
          (role) => can(role, 'project.read'),
          () => false,
        );
        asked.set(projectId, answer);
      }
      return answer;
    };
    const seen: SessionInfo[] = [];
    for (const { session, userId } of open) {
      const readable = new Set<string>();
      const where = session.presence?.projectId;
      for (const p of new Set([...session.projectIds, ...(where ? [where] : [])]))
        if (await mayRead(p)) readable.add(p);
      const own = userId === principal.user.id;
      if (own || readable.size) seen.push(only(session, (p) => readable.has(p), own));
    }
    return seen;
  }

  /** Without accounts every tab is the one person's; otherwise a command without a project goes to the caller's own. */
  private reach(): UiReach {
    if (this.accounts.mode === 'none') return { everyone: true };
    return { userId: currentPrincipal()?.user.id ?? null };
  }

  private send(actor: Actor, command: Omit<UiCommand, 'id' | 'issuedBy'>) {
    return this.hub.sendUi({ ...command, issuedBy: actor }, { reach: this.reach() });
  }

  navigate(actor: Actor, projectId: string, view: View, params?: Record<string, string>, sessionId?: string) {
    return this.send(actor, {
      projectId,
      sessionId,
      action: 'navigate',
      params: { view, ...(params ? { params } : {}) },
    });
  }

  focus(actor: Actor, projectId: string, target: { kind: FocusKind; id: string }, sessionId?: string) {
    return this.send(actor, { projectId, sessionId, action: 'focus', params: { target } });
  }

  notify(
    actor: Actor,
    message: string,
    level: 'info' | 'success' | 'warning' | 'error' = 'info',
    projectId?: string,
    sessionId?: string,
  ) {
    return this.send(actor, { projectId, sessionId, action: 'notify', params: { message, level } });
  }

  player(
    actor: Actor,
    projectId: string,
    playerAction: 'play' | 'pause' | 'seek',
    time?: number,
    sessionId?: string,
  ) {
    return this.send(actor, {
      projectId,
      sessionId,
      action: 'player',
      params: { playerAction, ...(time !== undefined ? { time } : {}) },
    });
  }
}
