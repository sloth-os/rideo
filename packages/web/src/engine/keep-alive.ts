/**
 * Keeps a tab working while it runs an editor job (docs/design/engine-performance.md#rendering-in-a-background-tab):
 * a Web Lock named after the job, which browsers take as a reason not to freeze or discard the tab, and a screen wake
 * lock while the tab is visible (phones sleep otherwise), taken again when the tab comes back.
 */

type WakeLock = { release(): Promise<void>; released?: boolean };

export async function keepAlive<T>(jobId: string, run: () => Promise<T>): Promise<T> {
  const nav = globalThis.navigator as
    | (Navigator & { wakeLock?: { request(type: 'screen'): Promise<WakeLock> } })
    | undefined;
  const body = async (): Promise<T> => {
    let wake: WakeLock | null = null;
    const acquire = async () => {
      if (!nav?.wakeLock || document.visibilityState !== 'visible' || (wake && !wake.released)) return;
      wake = await nav.wakeLock.request('screen').catch(() => null);
    };
    const onVisibility = () => void acquire();
    const doc = globalThis.document;
    doc?.addEventListener('visibilitychange', onVisibility);
    await acquire();
    try {
      return await run();
    } finally {
      doc?.removeEventListener('visibilitychange', onVisibility);
      await (wake as WakeLock | null)?.release().catch(() => undefined);
    }
  };
  if (!nav?.locks) return body();
  return nav.locks.request(`rideo-editor-job:${jobId}`, body) as Promise<T>;
}
