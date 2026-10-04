/**
 * Where the studio is (docs/design/subpath.md#the-web-app, docs/design/embedding.md#options): the base of the API,
 * of the app's static files and of the router. The standalone app reads them from the `<base href>` the server writes
 * into every page; the library sets them from its options.
 */

export interface Runtime {
  /** Where `/api`, `/mcp` and the live channel are, with a trailing slash: `/`, `/rideo/` or `https://x/rideo/`. */
  apiBase: string;
  /** Where the app's own files (`logo.svg`, `fonts/`, `sw.js`) are, with a trailing slash. */
  assetBase: string;
  /** The router's basename: '' (the root) or `/rideo`. */
  routerBase: string;
  /** Embedded in another page as a library: no service worker, no document-level changes. */
  embedded: boolean;
  /** A bearer token from the host page (library), instead of the studio's own sign-in. */
  token?: string | (() => string | null);
}

/** The path of the document's base (`<base href="/rideo/">` → `/rideo/`), '/' without one. */
export function documentBase(): string {
  try {
    const base = new URL(document.baseURI);
    return base.pathname.endsWith('/') ? base.pathname : base.pathname.replace(/[^/]*$/, '');
  } catch {
    return '/';
  }
}

const withSlash = (s: string) => (s.endsWith('/') ? s : `${s}/`);

function initial(): Runtime {
  const base = typeof document === 'undefined' ? '/' : documentBase();
  return { apiBase: base, assetBase: base, routerBase: base.replace(/\/+$/, ''), embedded: false };
}

let runtime: Runtime = initial();

export function getRuntime(): Readonly<Runtime> {
  return runtime;
}

/** Sets where the studio is (the library's options; tests). */
export function configureRuntime(next: Partial<Runtime>): void {
  runtime = {
    ...runtime,
    ...next,
    ...(next.apiBase !== undefined ? { apiBase: withSlash(next.apiBase) } : {}),
    ...(next.assetBase !== undefined ? { assetBase: withSlash(next.assetBase) } : {}),
    ...(next.routerBase !== undefined ? { routerBase: next.routerBase.replace(/\/+$/, '') } : {}),
  };
}

/** Back to the document's base (tests). */
export function resetRuntime(): void {
  runtime = initial();
}

/** An API URL: `apiUrl('/projects')` → `/rideo/api/projects`. */
export function apiUrl(path: string): string {
  return `${runtime.apiBase}api${path.startsWith('/') ? path : `/${path}`}`;
}

/** A URL of the server outside the API (`/mcp`, `/dav/`), absolute. */
export function serverUrl(path: string): string {
  return new URL(path.replace(/^\/+/, ''), new URL(runtime.apiBase, location.href)).href;
}

/** The live channel's URL (ws: or wss:, after the API base). */
export function liveUrl(path: string): string {
  const url = new URL(apiUrl(path), location.href);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.href;
}

/** A file the app ships (`assetUrl('logo.svg')`). */
export function assetUrl(rel: string): string {
  return `${runtime.assetBase}${rel.replace(/^\/+/, '')}`;
}

/** A path inside the app, for full-page navigation (`appUrl('/login')` → `/rideo/login`). */
export function appUrl(path: string): string {
  return `${runtime.routerBase}${path.startsWith('/') ? path : `/${path}`}`;
}

/** The app path of a location path (`/rideo/p/x` → `/p/x`). */
export function routePath(pathname: string): string {
  const base = runtime.routerBase;
  if (base && (pathname === base || pathname.startsWith(`${base}/`)))
    return pathname.slice(base.length) || '/';
  return pathname;
}
