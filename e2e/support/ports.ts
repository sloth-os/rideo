/** The studios of the e2e stack (e2e/support/stack.ts), by role. */
export const E2E_PORT = Number(process.env.RIDEO_E2E_PORT ?? 8797);

export const PORTS = {
  /** Built-in WebDAV storage, the mock gateway: most specs. */
  main: E2E_PORT,
  /** Accounts: OIDC sign-in through the mock provider (docs/design/accounts.md). */
  accounts: E2E_PORT + 1,
  /** Projects in the browser and no mm-gateway (docs/design/browser-storage.md, docs/design/settings.md). */
  browser: E2E_PORT + 2,
  /** Served under /studio (docs/design/subpath.md), reached with the prefix kept. */
  subpath: E2E_PORT + 3,
  /** A reverse proxy that serves the subpath studio under /rideo and strips the prefix, like nginx. */
  proxy: E2E_PORT + 4,
  /** Studios whose settings a spec changes (docs/design/settings.md): one per viewport, as they run at once. */
  settings: E2E_PORT + 5,
  settingsMobile: E2E_PORT + 7,
  /** The studio library embedded in a page on another origin (docs/design/embedding.md). */
  host: E2E_PORT + 6,
  /** The mock mm-gateway. */
  gateway: E2E_PORT + 10,
} as const;

export const at = (port: number, path = '') => `http://127.0.0.1:${port}${path}`;
