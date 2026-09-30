import { mkdirSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { v2 as webdav } from 'webdav-server';

export const DAV_PREFIX = '/dav';

/**
 * The embedded WebDAV server (webdav-server v2) backed by a local directory. Mounted before Fastify
 * routing (HTTP server factory) so WebDAV verbs and bodies never reach Fastify's parsers.
 */
export function createEmbeddedDav(opts: { root: string; username?: string; password?: string }) {
  mkdirSync(opts.root, { recursive: true });
  let options: webdav.WebDAVServerOptions = { rootFileSystem: new webdav.PhysicalFileSystem(opts.root) };
  if (opts.username && opts.password) {
    const users = new webdav.SimpleUserManager();
    const user = users.addUser(opts.username, opts.password, true);
    const privileges = new webdav.SimplePathPrivilegeManager();
    privileges.setRights(user, '/', ['all']);
    options = {
      ...options,
      httpAuthentication: new webdav.HTTPBasicAuthentication(users, 'Rideo'),
      privilegeManager: privileges,
    };
  }
  const server = new webdav.WebDAVServer(options);
  return {
    matches(url: string | undefined): boolean {
      return (
        !!url && (url === DAV_PREFIX || url.startsWith(`${DAV_PREFIX}/`) || url.startsWith(`${DAV_PREFIX}?`))
      );
    },
    handle(req: IncomingMessage, res: ServerResponse): void {
      req.url = (req.url ?? '').slice(DAV_PREFIX.length) || '/';
      server.executeRequest(req, res, `${DAV_PREFIX}/`);
    },
  };
}
