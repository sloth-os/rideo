import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';

/**
 * Another site that embeds the studio library (docs/design/embedding.md): the host app of e2e/fixtures/embed, built
 * with Vite against the package (`npm run build:e2e-host`), on an origin of its own, talking to a studio on another
 * origin. Its own routes (`/video/…`, the studio in browser routing) all serve its page.
 */
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.wasm': 'application/wasm',
  '.ttf': 'font/ttf',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.map': 'application/json',
};

export function startHostPage(opts: { port: number }): Promise<Server> {
  const root = resolve(import.meta.dirname, '../fixtures/embed/dist');
  const server = createServer(async (req, res) => {
    const path = decodeURIComponent((req.url ?? '/').split('?')[0]!);
    const rel = path.slice(1);
    const file = rel && !path.startsWith('/video') && extname(rel) ? rel : 'index.html';
    const full = normalize(join(root, file));
    if (!full.startsWith(root)) return void res.writeHead(403).end();
    try {
      const body = await readFile(full);
      res.writeHead(200, { 'content-type': TYPES[extname(full)] ?? 'application/octet-stream' }).end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  return new Promise((r) => server.listen(opts.port, '127.0.0.1', () => r(server)));
}
