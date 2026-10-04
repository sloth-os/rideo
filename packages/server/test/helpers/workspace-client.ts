import { randomBytes } from 'node:crypto';
import type { Readable } from 'node:stream';
import { STORAGE_INLINE_MAX, type StorageRequest } from '@rideo/shared';
import { PreconditionFailedError } from '../../src/storage/backend';
import { MemoryBackend } from '../../src/storage/memory';
import type { Stack } from './stack';

/**
 * The reference workspace: a Node stand-in for a studio tab that keeps projects in its browser
 * (docs/design/browser-storage.md#the-protocol). It answers the server's storage operations from a MemoryBackend,
 * moving large payloads over the HTTP transfers, and reconnects after a server restart like the app does.
 */
export interface WorkspaceClient {
  id: string;
  backend: MemoryBackend;
  /** Operations served, by op. */
  ops: Record<string, number>;
  /** Resolves with the project count of the server's next `workspace-ready`. */
  ready(): Promise<number>;
  /** Fetch with this workspace's header (the app sends it on every API call). */
  api<T = any>(method: string, path: string, body?: unknown): Promise<T>;
  close(): Promise<void>;
}

export function newWorkspaceId(): string {
  const alphabet = '0123456789abcdefghijklmnopqrstuvwxyz';
  return `ws_${[...randomBytes(26)].map((b) => alphabet[b % 36]).join('')}`;
}

async function collect(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  return Buffer.concat(chunks);
}

export class WorkspaceApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: any,
  ) {
    super(`${status} ${body?.code ?? ''}: ${body?.detail ?? ''}`);
  }
}

export async function attachWorkspace(
  stack: Stack,
  opts: { id?: string; backend?: MemoryBackend } = {},
): Promise<WorkspaceClient> {
  const id = opts.id ?? newWorkspaceId();
  const backend = opts.backend ?? new MemoryBackend();
  const ops: Record<string, number> = {};
  let socket: WebSocket | null = null;
  let closed = false;
  let waiting: ((n: number) => void)[] = [];
  let ping: NodeJS.Timeout | null = null;

  const serve = async (ws: WebSocket, msg: StorageRequest) => {
    ops[msg.op] = (ops[msg.op] ?? 0) + 1;
    const reply = (body: Record<string, unknown>) =>
      ws.readyState === WebSocket.OPEN &&
      ws.send(JSON.stringify({ type: 'storage-result', id: msg.id, ...body }));
    try {
      switch (msg.op) {
        case 'stat':
          return reply({ ok: true, result: await backend.stat(msg.path) });
        case 'list':
          return reply({ ok: true, result: await backend.list(msg.path) });
        case 'delete':
          await backend.delete(msg.path);
          return reply({ ok: true, result: {} });
        case 'move':
          await backend.move(msg.path, msg.to!);
          return reply({ ok: true, result: {} });
        case 'write': {
          let data: Buffer;
          if (msg.transfer) {
            const res = await fetch(`${stack.url}/api/workspace/transfers/${msg.transfer}`, {
              headers: { 'x-rideo-workspace': id },
            });
            if (!res.ok) throw new Error(`transfer ${res.status}`);
            data = Buffer.from(await res.arrayBuffer());
          } else data = Buffer.from(msg.data ?? '', 'base64');
          const r = await backend.write(msg.path, data, {
            ...(msg.ifMatch ? { ifMatch: msg.ifMatch } : {}),
            ...(msg.ifNoneMatch ? { ifNoneMatch: msg.ifNoneMatch } : {}),
          });
          return reply({ ok: true, result: r });
        }
        case 'read': {
          const r = await backend.readStream(msg.path, msg.range);
          if (!r) return reply({ ok: true, result: null });
          const bytes = await collect(r.stream);
          const end = r.size === 0 ? 0 : r.end;
          if (bytes.length <= STORAGE_INLINE_MAX)
            return reply({
              ok: true,
              result: { size: r.size, start: r.start, end },
              data: bytes.toString('base64'),
            });
          const res = await fetch(`${stack.url}/api/workspace/transfers/${msg.id}`, {
            method: 'PUT',
            headers: {
              'content-type': 'application/octet-stream',
              'x-rideo-workspace': id,
              'x-rideo-size': String(r.size),
              'x-rideo-range': `${r.start}-${end}`,
            },
            body: bytes,
          });
          if (res.status !== 204) throw new Error(`transfer ${res.status}`);
          return;
        }
      }
    } catch (err) {
      if (err instanceof PreconditionFailedError)
        return reply({ ok: false, error: { code: 'conflict', message: err.message } });
      return reply({ ok: false, error: { code: 'error', message: String(err) } });
    }
  };

  const connect = () => {
    const ws = new WebSocket(`${stack.url.replace(/^http/, 'ws')}/api/live`);
    socket = ws;
    ws.onmessage = (e) => {
      const msg = JSON.parse(String(e.data));
      if (msg.type === 'hello') ws.send(JSON.stringify({ type: 'workspace', workspaceId: id }));
      else if (msg.type === 'workspace-ready') {
        for (const w of waiting) w(msg.projects);
        waiting = [];
      } else if (msg.type === 'storage') void serve(ws, msg);
    };
    ws.onclose = () => {
      if (!closed) setTimeout(connect, 200);
    };
  };
  const readyOnce = () => new Promise<number>((resolve) => waiting.push(resolve));
  const first = readyOnce();
  connect();
  ping = setInterval(() => socket?.readyState === WebSocket.OPEN && socket.send('{"type":"ping"}'), 15_000);
  await first;

  return {
    id,
    backend,
    ops,
    ready: readyOnce,
    async api<T>(method: string, path: string, body?: unknown): Promise<T> {
      const raw = body instanceof Uint8Array || body instanceof FormData;
      const res = await fetch(`${stack.url}/api${path}`, {
        method,
        headers: {
          'x-rideo-workspace': id,
          ...(body === undefined || body instanceof FormData
            ? {}
            : { 'content-type': raw ? 'application/octet-stream' : 'application/json' }),
        },
        body: body === undefined ? undefined : raw ? (body as never) : JSON.stringify(body),
      });
      const type = res.headers.get('content-type') ?? '';
      if (!res.ok) throw new WorkspaceApiError(res.status, await res.json().catch(() => null));
      if (res.status === 204) return undefined as T;
      return (type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer())) as T;
    },
    async close() {
      closed = true;
      if (ping) clearInterval(ping);
      socket?.close();
      await new Promise((r) => setTimeout(r, 50));
    },
  };
}
