/**
 * This browser's workspace id (docs/design/browser-storage.md#workspaces): made on first use and kept in
 * localStorage. Every API call names it (`x-rideo-workspace`), so a studio that keeps projects in browsers lists this
 * browser's; studios that do not ignore it.
 */
const KEY = 'rideo.workspace';
const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';
let cached: string | null = null;
let enabled = false;

function make(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(26));
  return `ws_${[...bytes].map((b) => ALPHABET[b % 36]).join('')}`;
}

export function workspaceId(): string {
  if (cached) return cached;
  try {
    const saved = localStorage.getItem(KEY);
    if (saved && /^ws_[0-9a-z]{26}$/.test(saved)) cached = saved;
    else {
      cached = make();
      localStorage.setItem(KEY, cached);
    }
  } catch {
    cached ??= make(); // storage unavailable: this page only
  }
  return cached;
}

/** Whether the studio keeps projects in this browser (`features.storage === 'browser'`). */
export function workspaceEnabled(): boolean {
  return enabled;
}

export function setWorkspaceEnabled(on: boolean): void {
  enabled = on;
}

/** Tests: forget the id. */
export function resetWorkspaceId(): void {
  cached = null;
  enabled = false;
}
