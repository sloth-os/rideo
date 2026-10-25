import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * What one REST request made the storage do (docs/design/observability.md#logs): counted while the request runs, so
 * slow requests log their storage round trips and `rideo_storage_ops_per_request` shows per-request lookups.
 */
export interface RequestCounters {
  storageOps: number;
  storageMs: number;
}

export const requestCounters = new AsyncLocalStorage<RequestCounters>();

export function countStorageOp(ms: number): void {
  const c = requestCounters.getStore();
  if (!c) return;
  c.storageOps++;
  c.storageMs += ms;
}
