import type { StorageRequest, StorageResult } from '@rideo/shared';
import { getToken } from '../lib/api';
import { apiUrl } from '../lib/runtime';
import { workspaceId } from './id';
import { WorkspaceProvider } from './provider';
import { WorkspaceStore } from './store';

export { setWorkspaceEnabled, workspaceEnabled, workspaceId } from './id';

/**
 * This browser's workspace at run time (docs/design/browser-storage.md): the store opens on first use, asks the
 * browser to keep its data, empties the trash of old deletions, and serves the server's storage operations.
 */

/** Deleted projects stay this long in the browser's trash. */
export const TRASH_DAYS = 7;

let store: Promise<WorkspaceStore> | null = null;
let provider: WorkspaceProvider | null = null;

function headers(): Record<string, string> {
  const token = getToken();
  return { ...(token ? { authorization: `Bearer ${token}` } : {}), 'x-rideo-workspace': workspaceId() };
}

export function workspaceStore(): Promise<WorkspaceStore> {
  store ??= WorkspaceStore.open().then(async (s) => {
    if (!(await s.meta('workspace')))
      await s.setMeta('workspace', { id: workspaceId(), createdAt: new Date().toISOString() });
    void requestPersistence();
    void purgeTrash(s).catch(() => undefined);
    return s;
  });
  store.catch(() => {
    store = null;
  });
  return store;
}

/** Asks the browser not to evict the projects (once; the answer is the browser's). */
export async function requestPersistence(): Promise<boolean> {
  try {
    if (!navigator.storage?.persist) return false;
    if (await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}

/** Space the studio uses in this browser, and how much the browser allows. */
export async function storageEstimate(): Promise<{
  usage: number;
  quota: number;
  persisted: boolean;
} | null> {
  try {
    if (!navigator.storage?.estimate) return null;
    const e = await navigator.storage.estimate();
    return {
      usage: e.usage ?? 0,
      quota: e.quota ?? 0,
      persisted: (await navigator.storage.persisted?.()) ?? false,
    };
  } catch {
    return null;
  }
}

async function purgeTrash(s: WorkspaceStore): Promise<void> {
  const cutoff = Date.now() - TRASH_DAYS * 86_400_000;
  for (const e of await s.list('/trash')) {
    const at = Number(/-(\d+)$/.exec(e.name)?.[1]);
    if (Number.isFinite(at) && at < cutoff) await s.delete(e.path);
  }
}

/** Answers one storage operation of the server (the live client calls it). */
export async function serveStorage(
  request: StorageRequest,
  send: (msg: StorageResult) => void,
): Promise<void> {
  if (!provider) {
    const s = await workspaceStore();
    provider ??= new WorkspaceProvider(s, {
      send: (msg) => sendRef.current?.(msg),
      async fetchTransfer(id) {
        const res = await fetch(apiUrl(`/workspace/transfers/${id}`), { headers: headers() });
        if (!res.ok) throw new Error(`the server's file did not arrive (${res.status})`);
        return res.blob();
      },
      async putTransfer(id, data, meta) {
        const res = await fetch(apiUrl(`/workspace/transfers/${id}`), {
          method: 'PUT',
          headers: {
            ...headers(),
            'content-type': 'application/octet-stream',
            'x-rideo-size': String(meta.size),
            'x-rideo-range': `${meta.start}-${meta.end}`,
          },
          body: data,
        });
        if (res.status !== 204) throw new Error(`the server did not take the file (${res.status})`);
      },
    });
  }
  sendRef.current = send;
  await provider.handle(request);
}

const sendRef: { current: ((msg: StorageResult) => void) | null } = { current: null };

/** Tests: drop the open store. */
export function resetWorkspace(): void {
  store = null;
  provider = null;
}
