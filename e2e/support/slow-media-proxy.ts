import { createServer, request, type Server } from 'node:http';
import { connect } from 'node:net';

/**
 * The main studio behind slow media storage (docs/design/engine-performance.md#media-requests): a plain HTTP/1.1
 * proxy that holds every ranged media read (`Range:` on `/api/projects/:id/media/…`, what the editor's media pools
 * send) for `delayMs` before forwarding it, so each one keeps one of the browser's six connections busy. Whole-file
 * reads (an export's inputs), the API and the live WebSocket pass at once.
 */
export function startSlowMediaProxy(opts: {
  port: number;
  upstream: number;
  delayMs: number;
}): Promise<Server> {
  const server = createServer((req, res) => {
    const slow = /^\/api\/projects\/[^/]+\/media\//.test(req.url ?? '') && !!req.headers.range;
    const forward = () => {
      if (res.destroyed) return;
      const up = request(
        { host: '127.0.0.1', port: opts.upstream, method: req.method, path: req.url, headers: req.headers },
        (r) => {
          res.writeHead(r.statusCode ?? 502, r.headers);
          r.pipe(res);
        },
      );
      up.on('error', () => {
        if (!res.headersSent) res.writeHead(502);
        res.end();
      });
      res.on('close', () => up.destroy());
      req.pipe(up);
    };
    if (slow) setTimeout(forward, opts.delayMs);
    else forward();
  });
  server.on('upgrade', (req, socket, head) => {
    const target = connect(opts.upstream, '127.0.0.1', () => {
      const lines = [`${req.method} ${req.url} HTTP/1.1`];
      for (const [k, v] of Object.entries(req.headers))
        for (const value of Array.isArray(v) ? v : [v]) if (value !== undefined) lines.push(`${k}: ${value}`);
      target.write(`${lines.join('\r\n')}\r\n\r\n`);
      if (head.length) target.write(head);
      target.pipe(socket);
      socket.pipe(target);
    });
    const close = () => {
      target.destroy();
      socket.destroy();
    };
    target.on('error', close);
    socket.on('error', close);
  });
  return new Promise((resolve) => server.listen(opts.port, '127.0.0.1', () => resolve(server)));
}
