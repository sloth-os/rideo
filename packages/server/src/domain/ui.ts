import type { Actor, FocusKind, SessionInfo, UiCommand, View } from '@rideo/shared';
import type { LiveHub } from '../live/hub';

/** Agent-driven UI commands relayed to open browsers (docs/design/realtime-sync.md#ui-commands). */
export class UiService {
  constructor(private readonly hub: LiveHub) {}

  sessions(projectId?: string): SessionInfo[] {
    return this.hub.sessionsFor(projectId);
  }

  private send(actor: Actor, command: Omit<UiCommand, 'id' | 'issuedBy'>) {
    return this.hub.sendUi({ ...command, issuedBy: actor });
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
