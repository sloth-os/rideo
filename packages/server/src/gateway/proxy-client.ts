import { withPrefix } from '@rideo/shared';
import { AppError } from '../errors';

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
    return fetch(url, { ...init, headers, signal });
  }
}
