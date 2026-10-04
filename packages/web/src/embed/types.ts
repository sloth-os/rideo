/**
 * The public types of the studio library (docs/design/embedding.md). Self-contained on purpose: they are the
 * package's declarations, published without the studio's internal modules. `test/embed.test.ts` checks that they
 * stay the same shape as the shared theme schema.
 */

/** A theme color token (docs/brand.md#tokens). */
export type RideoThemeColor =
  | 'bg'
  | 'surface'
  | 'surface-2'
  | 'border'
  | 'text'
  | 'muted'
  | 'accent'
  | 'accent-contrast'
  | 'success'
  | 'warning'
  | 'danger'
  | 'info';

export type RideoThemeColors = Partial<Record<RideoThemeColor, string>>;

/** Overrides of the studio's look (docs/design/embedding.md#themes). */
export interface RideoTheme {
  /** The mode people start in (they can still switch); `system` follows the device. */
  mode?: 'dark' | 'light' | 'system';
  /** Colors of both modes (CSS colors). */
  colors?: RideoThemeColors;
  /** Colors of dark mode only. */
  dark?: RideoThemeColors;
  /** Colors of light mode only. */
  light?: RideoThemeColors;
  fonts?: { sans?: string; mono?: string };
  radius?: { control?: string; card?: string; dialog?: string };
  /** The name and mark in the studio's header. */
  brand?: { name?: string; logoUrl?: string };
}

export interface RideoRouting {
  /** `browser`: the URL under `basename`; `hash`: `#/p/…`; `memory`: the URL never changes. Default `browser`. */
  mode?: 'browser' | 'hash' | 'memory';
  /** Where the studio is mounted in `browser` mode, e.g. `/video`. */
  basename?: string;
  /** The first route in `memory` mode. */
  initialPath?: string;
}

export interface RideoOptions {
  /** The Rideo server (where `/api` and `/mcp` are), absolute or relative to the page. Default: the page's base. */
  server?: string;
  /** A bearer token (an agent token or the studio token), or a function returning the current one. */
  token?: string | (() => string | null);
  routing?: RideoRouting;
  /** Called after every route change with the studio path (`/p/prj_…/editor`). */
  onNavigate?: (path: string) => void;
  /** The host's theme, over the studio's (Settings → Appearance) over Rideo's. */
  theme?: RideoTheme;
  /** Where the library's `assets/` folder is served, when not next to `rideo.js`. */
  assetsBase?: string;
  /** Register the studio's service worker (only when the studio owns its path on the origin). Default `false`. */
  pwa?: boolean;
  /** `header: false` hides the studio's header, for hosts that bring their own navigation. */
  chrome?: { header?: boolean };
}

/** What `mountRideo` returns. */
export interface RideoHandle {
  /** Goes to a studio path, e.g. `/p/prj_…/editor`. */
  navigate(path: string): void;
  /** Replaces the host's theme. */
  setTheme(theme: RideoTheme | undefined): void;
  /** Removes the studio from the page. */
  unmount(): void;
}
