import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';

/**
 * The fake 3D desk of e2e/fixtures/desk (docs/design/director-desk.md#tests) on an origin of its own (`localhost`,
 * against the studios' `127.0.0.1`), served with the headers a desk page needs inside a cross-origin-isolated studio:
 * `Cross-Origin-Embedder-Policy: require-corp`, `Cross-Origin-Resource-Policy: cross-origin` and
 * `Content-Security-Policy: frame-ancestors` naming the studio.
 */
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.mp4': 'video/mp4',
  '.png': 'image/png',
};

export function startDeskPage(opts: { port: number; frameAncestors: string[] }): Promise<Server> {
  const root = resolve(import.meta.dirname, '../fixtures/desk');
  const server = createServer(async (req, res) => {
    const path = decodeURIComponent((req.url ?? '/').split('?')[0]!);
    const full = normalize(join(root, path === '/' ? 'desk.html' : path.slice(1)));
    if (!full.startsWith(root + sep)) return void res.writeHead(403).end();
    try {
      const body = await readFile(full);
      res
        .writeHead(200, {
          'content-type': TYPES[extname(full)] ?? 'application/octet-stream',
          'cross-origin-embedder-policy': 'require-corp',
          'cross-origin-resource-policy': 'cross-origin',
          'content-security-policy': `frame-ancestors ${opts.frameAncestors.join(' ')}`,
          'cache-control': 'no-store',
        })
        .end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  return new Promise((r) => server.listen(opts.port, '127.0.0.1', () => r(server)));
}
