import { STORAGE_INLINE_MAX, type StorageRequest, type StorageResult } from '@rideo/shared';
import { PreconditionError, type WorkspaceStore } from './store';

/**
 * Answers the server's storage operations from this browser's store (docs/design/browser-storage.md#the-protocol):
 * small payloads inline as base64, large ones over the HTTP transfers.
 */
export interface WorkspaceIo {
  send(msg: StorageResult): void;
  /** The bytes the server writes (`GET /api/workspace/transfers/:id`). */
  fetchTransfer(id: string): Promise<Blob>;
  /** The bytes the server reads (`PUT /api/workspace/transfers/:id`, id = the operation's). */
  putTransfer(id: string, data: Blob, meta: { size: number; start: number; end: number }): Promise<void>;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, Math.min(bytes.length, i + 0x8000)));
  return btoa(binary);
}

export function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export class WorkspaceProvider {
  /** Operations served, by op (shown in development and tests). */
  readonly served: Record<string, number> = {};

  constructor(
    private readonly store: WorkspaceStore,
    private readonly io: WorkspaceIo,
  ) {}

  async handle(msg: StorageRequest): Promise<void> {
    this.served[msg.op] = (this.served[msg.op] ?? 0) + 1;
    const reply = (body: Omit<StorageResult, 'type' | 'id'>) =>
      this.io.send({ type: 'storage-result', id: msg.id, ...body });
    try {
      switch (msg.op) {
        case 'stat':
          return reply({ ok: true, result: await this.store.stat(msg.path) });
        case 'list':
          return reply({ ok: true, result: await this.store.list(msg.path) });
        case 'delete':
          await this.store.delete(msg.path);
          return reply({ ok: true, result: {} });
        case 'move':
          await this.store.move(msg.path, msg.to ?? msg.path);
          return reply({ ok: true, result: {} });
        case 'write': {
          const data = msg.transfer
            ? await this.io.fetchTransfer(msg.transfer)
            : new Blob([base64ToBytes(msg.data ?? '')], msg.contentType ? { type: msg.contentType } : {});
          const r = await this.store.write(msg.path, data, {
            ...(msg.ifMatch ? { ifMatch: msg.ifMatch } : {}),
            ...(msg.ifNoneMatch ? { ifNoneMatch: msg.ifNoneMatch } : {}),
            ...(msg.contentType ? { contentType: msg.contentType } : {}),
          });
          return reply({ ok: true, result: r });
        }
        case 'read': {
          const r = await this.store.read(msg.path, msg.range);
          if (!r) return reply({ ok: true, result: null });
          const meta = { size: r.size, start: r.start, end: r.end };
          if (r.blob.size <= STORAGE_INLINE_MAX)
            return reply({
              ok: true,
              result: meta,
              data: bytesToBase64(new Uint8Array(await r.blob.arrayBuffer())),
            });
          await this.io.putTransfer(msg.id, r.blob, meta);
          return;
        }
      }
    } catch (err) {
      const code =
        err instanceof PreconditionError
          ? 'conflict'
          : (err as { code?: string }).code === 'quota'
            ? 'quota'
            : 'error';
      reply({
        ok: false,
        error: { code, message: (err instanceof Error ? err.message : String(err)).slice(0, 2000) },
      });
    }
  }
}
