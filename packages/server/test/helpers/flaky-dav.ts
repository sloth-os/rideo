import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEmbeddedDav } from '../../src/storage/embedded-dav';

/** What a scripted rule answers instead of the server: a status (and headers), or a dropped connection. */
export type Fault = { status: number; headers?: Record<string, string> } | 'drop';

interface Rule {
  method: string;
  path: RegExp;
  times: number;
  fault: Fault;
}

/**
 * A WebDAV server that misbehaves on cue (docs/design/storage-webdav.md#slow-and-flaky-servers): the embedded
 * server behind a proxy that answers scripted requests with a status (`503`, `423`, a false `404`) or drops their
 * connection, and counts the requests it sees by method.
 */
export interface FlakyDav {
  url: string;
  /** Answers the next `times` requests of `method` whose path matches with `fault`. */
  fail(method: string, path: RegExp, fault: Fault, times?: number): void;
  /** Forgets the rules not used up. */
  reset(): void;
  /** Requests seen (including faulted ones), by method. */
  seen: Record<string, number>;
  close(): Promise<void>;
}

export async function startFlakyDav(): Promise<FlakyDav> {
  const dir = await mkdtemp(join(tmpdir(), 'rideo-flaky-dav-'));
  const dav = createEmbeddedDav({ root: dir });
  const rules: Rule[] = [];
  const seen: Record<string, number> = {};
  const server: Server = createServer((req, res) => {
    const method = req.method ?? 'GET';
    seen[method] = (seen[method] ?? 0) + 1;
    const path = decodeURIComponent((req.url ?? '/').split('?')[0]!);
    const rule = rules.find((r) => r.times > 0 && r.method === method && r.path.test(path));
    if (rule) {
      rule.times--;
      // The body is read first, as a server that failed after receiving the request would
      req.resume();
      req.on('end', () => {
        if (rule.fault === 'drop') res.socket?.destroy();
        else res.writeHead(rule.fault.status, rule.fault.headers ?? {}).end();
      });
      return;
    }
    if (dav.matches(req.url)) dav.handle(req, res);
    else res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/dav`,
    seen,
    fail(method, path, fault, times = 1) {
      rules.push({ method, path, fault, times });
    },
    reset() {
      rules.length = 0;
    },
    async close() {
      server.closeAllConnections();
      await new Promise((r) => server.close(() => r(null)));
      await rm(dir, { recursive: true, force: true });
    },
  };
}
