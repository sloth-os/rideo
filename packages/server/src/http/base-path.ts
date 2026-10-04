import type { IncomingMessage } from 'node:http';
import type { FastifyRequest } from 'fastify';
import { normalizeBasePath } from '../config';

/**
 * Serving under a subpath (docs/design/subpath.md): the base of a request is the proxy's `X-Forwarded-Prefix` when it
 * is a valid path, else the configured one. Requests that still carry the base (proxies that keep the prefix) have it
 * removed before anything routes them, so both proxy styles reach the same routes.
 */
const BASE = Symbol('rideo.basePath');

type WithBase = IncomingMessage & { [BASE]?: string };

export function forwardedPrefix(req: IncomingMessage): string | null {
  const raw = req.headers['x-forwarded-prefix'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) return null;
  return normalizeBasePath(value.split(',')[0]!.trim());
}

/** Strips the base path from the request URL and remembers the request's base. Runs in the HTTP server factory. */
export function applyBasePath(req: IncomingMessage, configured: string): void {
  const base = forwardedPrefix(req) ?? configured;
  (req as WithBase)[BASE] = base;
  const url = req.url ?? '/';
  for (const prefix of new Set([base, configured])) {
    if (!prefix) continue;
    if (url === prefix) {
      req.url = '/';
      return;
    }
    if (url.startsWith(`${prefix}/`) || url.startsWith(`${prefix}?`)) {
      req.url = url.slice(prefix.length) || '/';
      if (req.url.startsWith('?')) req.url = `/${req.url}`;
      return;
    }
  }
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
