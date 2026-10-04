import { WorkspaceIdSchema } from '@rideo/shared';
import type { FastifyRequest } from 'fastify';

/**
 * The browser workspace a request names (docs/design/browser-storage.md#routing-on-the-server): the
 * `x-rideo-workspace` header of the app's API calls, `?ws=` on media URLs (elements send no headers) or
 * `?workspace=` on the MCP URL. Anything that is not a workspace id is ignored.
 */
export function requestWorkspace(req: FastifyRequest): string | null {
  const header = req.headers['x-rideo-workspace'];
  const q = (req.query ?? {}) as { ws?: unknown; workspace?: unknown };
  for (const candidate of [Array.isArray(header) ? header[0] : header, q.ws, q.workspace]) {
    if (typeof candidate === 'string' && WorkspaceIdSchema.safeParse(candidate).success) return candidate;
  }
  return null;
}
