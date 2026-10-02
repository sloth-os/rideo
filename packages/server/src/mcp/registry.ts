import type { Actor, Permission } from '@rideo/shared';
import type { z } from 'zod';

/**
 * The MCP tools as one registry (docs/design/agents.md#recipes): the MCP server registers them for clients, and
 * recipes run their steps through the same handlers, schemas and permissions.
 */
export interface ToolDef {
  name: string;
  description: string;
  shape: z.ZodRawShape;
  run: (args: never, actor: Actor) => Promise<unknown>;
  readOnly: boolean;
  /** What a caller needs in the project (docs/design/accounts.md#users-roles-and-projects). */
  permission: Permission;
}

export type ToolRegistry = ReadonlyMap<string, ToolDef>;

const ORDER: Permission[] = [
  'project.read',
  'project.comment',
  'project.edit',
  'project.approve',
  'project.manage',
];

/** The strongest of some permissions. */
export function strongest(permissions: readonly Permission[]): Permission {
  return permissions.reduce<Permission>(
    (a, b) => (ORDER.indexOf(b) > ORDER.indexOf(a) ? b : a),
    'project.read',
  );
}
