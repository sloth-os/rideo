import { AsyncLocalStorage } from 'node:async_hooks';
import type { Actor, AgentToken, PublicUser } from '@rideo/shared';

/** Who is calling (docs/design/accounts.md): a person, an agent token on their behalf, or the studio itself. */
export interface Principal {
  kind: 'studio' | 'user' | 'token';
  user: PublicUser;
  admin: boolean;
  token: AgentToken | null;
  /** How commits and activity name the caller. */
  actor: Actor;
}

/** The principal of the request being handled: REST handlers, MCP tools and their services read it. */
export const principalContext = new AsyncLocalStorage<Principal | null>();

export function currentPrincipal(): Principal | null {
  return principalContext.getStore() ?? null;
}
