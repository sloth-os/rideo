/**
 * All non-generation AI traffic (LLM, vision, STT) goes through the mm-gateway reverse proxy:
 * `${MM_GATEWAY_URL}/proxy/{domain}/{path}` with the gateway bearer key (docs/design/ai-gateway.md).
 */
export class ProxyClient {
  constructor(private readonly cfg: { baseUrl: string; apiKey?: string; timeoutMs?: number }) {}

  url(domain: string, path: string): string {
    if (!/^[a-z0-9.-]+(:\d+)?$/i.test(domain)) throw new Error(`invalid proxy domain ${domain}`);
    return `${this.cfg.baseUrl}/proxy/${domain}/${path.replace(/^\/+/, '')}`;
  }

  async fetch(
    domain: string,
    path: string,
    init: RequestInit & { timeoutMs?: number } = {},
  ): Promise<Response> {
    const headers = new Headers(init.headers);
    if (this.cfg.apiKey) headers.set('authorization', `Bearer ${this.cfg.apiKey}`);
    const timeout = AbortSignal.timeout(init.timeoutMs ?? this.cfg.timeoutMs ?? 180_000);
    const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    return fetch(this.url(domain, path), { ...init, headers, signal });
  }
}
