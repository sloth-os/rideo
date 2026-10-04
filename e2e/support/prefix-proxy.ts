import { createServer, request, type Server } from 'node:http';
import { connect } from 'node:net';

/**
 * A reverse proxy like `location /rideo/ { proxy_pass http://upstream/; }` in nginx (docs/design/subpath.md#proxy-configurations):
 * it serves the upstream under a prefix, strips the prefix, says it with X-Forwarded-Prefix, redirects the bare prefix
 * to its slash, and forwards WebSocket upgrades.
 */
export function startPrefixProxy(opts: { port: number; prefix: string; upstream: number }): Promise<Server> {
  const { prefix, upstream } = opts;
  const strip = (url: string) => url.slice(prefix.length) || '/';
  const server = createServer((req, res) => {
    const url = req.url ?? '/';
    if (url === prefix) {
      res.writeHead(308, { location: `${prefix}/` }).end();
      return;
    }
    if (!url.startsWith(`${prefix}/`)) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not under the prefix');
      return;
    }
    const up = request(
      {
        host: '127.0.0.1',
        port: upstream,
        method: req.method,
        path: strip(url),
        headers: { ...req.headers, 'x-forwarded-prefix': prefix, 'x-forwarded-proto': 'http' },
      },
      (r) => {
        res.writeHead(r.statusCode ?? 502, r.headers);
        r.pipe(res);
      },
    );
    up.on('error', () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    req.pipe(up);
  });
  server.on('upgrade', (req, socket, head) => {
    const url = req.url ?? '/';
    if (!url.startsWith(`${prefix}/`)) return socket.destroy();
    const target = connect(upstream, '127.0.0.1', () => {
      const headers = { ...req.headers, 'x-forwarded-prefix': prefix };
      const lines = [`${req.method} ${strip(url)} HTTP/1.1`];
      for (const [k, v] of Object.entries(headers))
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
