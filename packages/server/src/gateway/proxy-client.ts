import { withPrefix } from '@rideo/shared';
import { Agent, fetch as undiciFetch } from 'undici';
import { AppError } from '../errors';

/**
 * Connections without a header or body timeout of their own: undici's defaults (300 s, the global fetch's) end a slow
 * answer before the call's own timeout (`RIDEO_LLM_TIMEOUT_SEC`) does (docs/design/ai-gateway.md#proxy-usage-llm-vision-stt-embeddings).
 */
const LONG_CALLS = new Agent({ headersTimeout: 0, bodyTimeout: 0, connectTimeout: 30_000 });

/** The error of every AI call while the studio has no gateway (docs/design/settings.md#without-mm-gateway). */
export function gatewayNotConfigured(): AppError {
  return new AppError(
    'gateway_not_configured',
    'This needs mm-gateway: connect one in Settings (AI features are off until then)',
  );
}

/** An API behind the proxy: its domain, or its domain and the path standing for the API version. */
export type ProxyTarget = string | { domain: string; prefix?: string | null };

/** Which gateway key a domain is called with, and the registration a call waits for (GatewayProxies). */
export interface ProxyRoutes {
  keyFor(domain: string): string | undefined;
  ready(domain: string): Promise<void>;
}

/**
 * All non-generation AI traffic (LLM, vision, STT) goes through the mm-gateway reverse proxy:
 * `${MM_GATEWAY_URL}/proxy/{domain}/{path}` with a gateway bearer key (docs/design/ai-gateway.md). A target's prefix
 * replaces the API version segment of the path (docs/design/settings.md#api-base-url).
 */
export class ProxyClient {
  constructor(
    private readonly cfg: { baseUrl?: string; apiKey?: string; timeoutMs?: number; routes?: ProxyRoutes },
  ) {}

  get configured(): boolean {
    return !!this.cfg.baseUrl;
  }

  url(target: ProxyTarget, path: string): string {
    if (!this.cfg.baseUrl) throw gatewayNotConfigured();
    const domain = typeof target === 'string' ? target : target.domain;
    if (!/^[a-z0-9.-]+(:\d+)?$/i.test(domain)) throw new Error(`invalid proxy domain ${domain}`);
    const prefix = typeof target === 'string' ? null : target.prefix;
    return `${this.cfg.baseUrl}/proxy/${domain}/${withPrefix(path, prefix)}`;
  }

  async fetch(
    target: ProxyTarget,
    path: string,
    init: RequestInit & { timeoutMs?: number } = {},
  ): Promise<Response> {
    if (!this.cfg.baseUrl) throw gatewayNotConfigured();
    const url = this.url(target, path);
    const domain = typeof target === 'string' ? target : target.domain;
    await this.cfg.routes?.ready(domain);
    const headers = new Headers(init.headers);
    const key = this.cfg.routes?.keyFor(domain) ?? this.cfg.apiKey;
    if (key) headers.set('authorization', `Bearer ${key}`);
    const timeout = AbortSignal.timeout(init.timeoutMs ?? this.cfg.timeoutMs ?? 180_000);
    const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    // Multipart uploads (speech-to-text) keep the global fetch: undici's own does not encode the global FormData.
    if (typeof FormData !== 'undefined' && init.body instanceof FormData)
      return fetch(url, { ...init, headers, signal });
    return undiciFetch(url, {
      ...(init as Parameters<typeof undiciFetch>[1]),
      headers: Object.fromEntries(headers),
      signal,
      dispatcher: LONG_CALLS,
    }) as unknown as Promise<Response>;
  }
}
