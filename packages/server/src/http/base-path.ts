import type { IncomingMessage } from 'node:http';
import { withoutTrailingSlashes } from '@rideo/shared';
import type { FastifyRequest } from 'fastify';
import { basePathProblem, MAX_BASE_PATH_LENGTH, startsWithOwnPath } from '../config';

/**
 * Serving under a subpath (docs/design/subpath.md#both-proxy-styles). A request's pages and links are written with its
 * base: the proxy's `X-Forwarded-Prefix` when it is a valid path, else the configured one. Routing never follows the
 * header's value: a request that carries the header comes from a proxy that removed its own prefix and is routed as it
 * came; one without it (a proxy that keeps the prefix, or none) has the configured base path removed from the front of
 * its path, once.
 */
const BASE = Symbol('rideo.basePath');

type WithBase = IncomingMessage & { [BASE]?: string };

/** The request's X-Forwarded-Prefix as sent, or null without one. */
function prefixHeader(req: IncomingMessage): string | null {
  const raw = req.headers['x-forwarded-prefix'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value ? value : null;
}

/**
 * The proxy's base path: X-Forwarded-Prefix when it is a base path (docs/design/subpath.md#the-base-path), whose first
 * segment may be one of the studio's own (a stripping proxy at /mcp/): a request that carries the header is routed as it
 * came and the header's value is never removed from a path, so no path is read two ways. A value over 256 characters is
 * ignored unread.
 */
export function forwardedPrefix(req: IncomingMessage): string | null {
  const value = prefixHeader(req);
  if (value === null || value.length > MAX_BASE_PATH_LENGTH) return null;
  const first = value.split(',')[0]!;
  const problem = basePathProblem(first);
  return problem === null || problem === 'reserved' ? withoutTrailingSlashes(first.trim()) : null;
}

/** Whether `url` (a request target) is `base` itself or under it. */
function underBase(url: string, base: string): boolean {
  return url === base || url.startsWith(`${base}/`) || url.startsWith(`${base}?`);
}

/**
 * Remembers the request's base and, unless a proxy already stripped its prefix (the request carries
 * X-Forwarded-Prefix), removes the configured base path from the front of its path. Runs in the HTTP server factory and
 * on WebSocket upgrades, before the embedded /dav and Fastify see the request.
 */
export function applyBasePath(req: IncomingMessage, configured: string): void {
  (req as WithBase)[BASE] = forwardedPrefix(req) ?? configured;
  if (!configured || prefixHeader(req) !== null) return;
  const url = req.url ?? '/';
  if (!underBase(url, configured)) return;
  const rest = url.slice(configured.length);
  req.url = rest.startsWith('/') ? rest : `/${rest}`;
}

/** The kept-prefix warning is logged at most once in this time (ms) per server. */
export const KEPT_PREFIX_WARNING_EVERY_MS = 10 * 60_000;

/** Which base path a request's path is under, for the kept-prefix warning: the configured one or the header's own. */
export type KeptPrefixSignal = 'configured' | 'header';

/**
 * A check, run on every request (and WebSocket upgrade) before applyBasePath, that logs at warn, at most once per
 * KEPT_PREFIX_WARNING_EVERY_MS on `now`'s clock, when a request carries X-Forwarded-Prefix and its path starts with the
 * configured base path or with the header's own base path (docs/design/subpath.md#upgrading-from-an-earlier-version).
 * Such a request is routed as it came, the base path kept on its path: a proxy that keeps the prefix and sends the
 * header, or passes a client's on, makes it (and its API answers with the app's page), but so does a client that asks a
 * stripping proxy for a doubled prefix. A header base that starts with one of the studio's own paths is no sign: behind
 * a stripping proxy at /api/, the app's own requests have paths under it. Clients can send the header too, so the line
 * is worded as a condition on the proxy and kept rare; it names a valid base path only, never the header's text, which
 * base it is and the method, never the rest of the path or the query (a share link's secret, a token).
 */
export function keptPrefixWarning(
  log: { warn(obj: object, msg: string): void },
  configured: string,
  now: () => number = Date.now,
): (req: IncomingMessage) => void {
  let last = Number.NEGATIVE_INFINITY;
  return (req) => {
    if (prefixHeader(req) === null) return;
    const url = req.url ?? '/';
    const header = forwardedPrefix(req);
    const signs: [string, KeptPrefixSignal][] = [[configured, 'configured']];
    if (header && !startsWithOwnPath(header)) signs.push([header, 'header']);
    const sign = signs.find(([b]) => b !== '' && underBase(url, b));
    if (sign === undefined) return;
    const [base, signal] = sign;
    const at = now();
    if (at - last < KEPT_PREFIX_WARNING_EVERY_MS) return;
    last = at;
    log.warn(
      { base, signal, method: req.method },
      `a request that carries X-Forwarded-Prefix has a path under ${base}; such a request is routed as it came, ` +
        `${base} kept on its path: if the proxy in front keeps the prefix in paths, it must not send ` +
        'X-Forwarded-Prefix and must drop a client\'s (nginx: proxy_set_header X-Forwarded-Prefix "" in the location; Caddy: ' +
        'header_up -X-Forwarded-Prefix; Apache httpd: RequestHeader unset X-Forwarded-Prefix), see ' +
        'docs/design/subpath.md#upgrading-from-an-earlier-version (logged at most once every 10 minutes)',
    );
  };
}

/** The base path the browser sees this request under ('' or `/a/b`). */
export function requestBase(req: FastifyRequest | IncomingMessage): string {
  const raw = 'raw' in req ? req.raw : req;
  return (raw as WithBase)[BASE] ?? '';
}

/** `<base href>` of the app for a request: the base with a trailing slash. */
export function baseHref(base: string): string {
  return `${base}/`;
}

/** index.html with the request's base: replaces the build's `<base href>` (or adds one at the top of `<head>`). */
export function injectBase(html: string, base: string): string {
  const tag = `<base href="${baseHref(base)}" />`;
  if (/<base\s[^>]*href=/i.test(html)) return html.replace(/<base\s[^>]*href=("[^"]*"|'[^']*')[^>]*>/i, tag);
  return html.replace(/<head(\s[^>]*)?>/i, (m) => `${m}\n    ${tag}`);
}
