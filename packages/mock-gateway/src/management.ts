import { randomBytes } from 'node:crypto';

/**
 * The subset of mm-gateway's management API Rideo uses (docs/design/ai-gateway.md#mock-gateway): the redacted
 * configuration with its revision, proxies and keys created, replaced and deleted with `If-Match`, `[redacted]` values
 * restored from the stored ones by identity like the real gateway does. Registered proxies are served to the keys
 * their tags allow, with the first account's credential.
 */

export const REDACTED = '[redacted]';

export interface MockKey {
  id: string;
  key: string;
  enabled: boolean;
  allow_tags: string[];
  allow_backends: string[];
  deny_tags: string[];
  [field: string]: unknown;
}

export interface MockProxy {
  domain?: string | null;
  base_url: string;
  tags: string[];
  headers: Record<string, string>;
  accounts: { id: string; headers: Record<string, string> }[];
  timeout: number;
  enabled: boolean;
  outbound_proxy: string | null;
}

export class ManagementError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
};

/** Resolves `[redacted]` against the stored value, by identity in lists (accounts by id), like mm-gateway's `_restore`. */
function restore(value: unknown, previous: unknown): unknown {
  if (value === REDACTED) {
    if (previous === undefined || previous === null)
      throw new ManagementError(
        422,
        'invalid_config',
        'A redacted value has no existing secret to preserve.',
      );
    return previous;
  }
  if (Array.isArray(value)) {
    const old = Array.isArray(previous) ? previous : [];
    const byId = new Map(
      old.filter((v) => v && typeof v === 'object' && 'id' in v).map((v) => [(v as { id: string }).id, v]),
    );
    return value.map((v) =>
      v && typeof v === 'object' && 'id' in v
        ? restore(v, byId.get((v as { id: string }).id))
        : restore(v, undefined),
    );
  }
  if (value && typeof value === 'object') {
    const old = previous && typeof previous === 'object' ? (previous as Record<string, unknown>) : {};
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, restore(v, old[k])]));
  }
  return value;
}

const redactMap = (m: Record<string, string>) =>
  Object.fromEntries(Object.entries(m).map(([k, v]) => [k, v ? REDACTED : v]));

export class MockManagement {
  revision = randomBytes(16).toString('hex');
  keys: MockKey[];
  proxies: MockProxy[] = [];

  constructor(
    readonly opts: {
      /** The gateway's generation key ('' or unset: an open key that admits any caller). */
      apiKey?: string;
      /** The management token (unset: management is disabled). */
      managementKey?: string;
    },
  ) {
    this.keys = [
      {
        id: 'default',
        key: opts.apiKey ?? '',
        enabled: true,
        allow_tags: [],
        allow_backends: [],
        deny_tags: [],
      },
    ];
  }

  authorize(header: string | undefined): void {
    if (!this.opts.managementKey)
      throw new ManagementError(
        401,
        'unauthorized',
        'Management is disabled. Configure MANAGEMENT_API_KEY to enable it.',
      );
    if (header !== `Bearer ${this.opts.managementKey}`)
      throw new ManagementError(401, 'unauthorized', 'A valid management bearer token is required.');
  }

  private checkRevision(ifMatch: string | undefined): void {
    if (!ifMatch)
      throw new ManagementError(
        428,
        'precondition_required',
        'Send the current configuration revision in If-Match.',
      );
    if (ifMatch.replace(/"/g, '') !== this.revision)
      throw new ManagementError(
        412,
        'precondition_failed',
        'Configuration changed. Reload it before saving.',
      );
  }

  view() {
    return {
      revision: this.revision,
      persistent: false,
      config: {
        backends: [],
        keys: this.keys.map((k) => ({ ...k, key: k.key ? REDACTED : '' })),
        proxies: this.proxies.map((p) => ({
          ...p,
          domain: hostOf(p.base_url),
          headers: redactMap(p.headers),
          accounts: p.accounts.map((a) => ({ id: a.id, headers: redactMap(a.headers) })),
        })),
        routing_default_optimize: 'balanced',
        routing_profiles: {},
        catalog_models: {},
        budget_allow_unpriced: false,
        outbound_proxy: null,
      },
    };
  }

  private changed() {
    this.revision = randomBytes(16).toString('hex');
    return this.view();
  }

  putProxy(domain: string, body: unknown, ifMatch: string | undefined) {
    this.checkRevision(ifMatch);
    const b = (body ?? {}) as Partial<MockProxy>;
    if (typeof b.base_url !== 'string' || hostOf(b.base_url) !== domain.toLowerCase())
      throw new ManagementError(422, 'invalid_config', 'Resource identity must match the URL.');
    const existing = this.proxies.find((p) => hostOf(p.base_url) === domain.toLowerCase());
    const next = restore(
      {
        base_url: b.base_url,
        tags: b.tags ?? [],
        headers: b.headers ?? {},
        accounts: (b.accounts ?? []).map((a) => ({ id: a.id, headers: a.headers ?? {} })),
        timeout: b.timeout ?? 120,
        enabled: b.enabled ?? true,
        outbound_proxy: b.outbound_proxy ?? null,
      },
      existing,
    ) as MockProxy;
    this.proxies = existing ? this.proxies.map((p) => (p === existing ? next : p)) : [...this.proxies, next];
    return this.changed();
  }

  deleteProxy(domain: string, ifMatch: string | undefined) {
    this.checkRevision(ifMatch);
    const before = this.proxies.length;
    this.proxies = this.proxies.filter((p) => hostOf(p.base_url) !== domain.toLowerCase());
    if (this.proxies.length === before)
      throw new ManagementError(404, 'not_found', 'Configuration resource not found.');
    return this.changed();
  }

  putKey(id: string, body: unknown, ifMatch: string | undefined) {
    this.checkRevision(ifMatch);
    const b = (body ?? {}) as Partial<MockKey>;
    if (b.id !== id)
      throw new ManagementError(422, 'invalid_config', 'Resource identity must match the URL.');
    const existing = this.keys.find((k) => k.id === id);
    const next = restore(
      {
        ...b,
        id,
        key: b.key ?? '',
        enabled: b.enabled ?? true,
        allow_tags: b.allow_tags ?? [],
        allow_backends: b.allow_backends ?? [],
        deny_tags: b.deny_tags ?? [],
      },
      existing,
    ) as MockKey;
    this.keys = existing ? this.keys.map((k) => (k === existing ? next : k)) : [...this.keys, next];
    return this.changed();
  }

  deleteKey(id: string, ifMatch: string | undefined) {
    this.checkRevision(ifMatch);
    if (!this.keys.some((k) => k.id === id))
      throw new ManagementError(404, 'not_found', 'Configuration resource not found.');
    this.keys = this.keys.filter((k) => k.id !== id);
    return this.changed();
  }

  /** The key a bearer token stands for: a matching key, else an open key (empty token), else none. */
  keyFor(token: string | undefined): MockKey | null {
    const enabled = this.keys.filter((k) => k.enabled);
    return (token && enabled.find((k) => k.key && k.key === token)) || enabled.find((k) => !k.key) || null;
  }

  proxy(domain: string): MockProxy | undefined {
    return this.proxies.find((p) => hostOf(p.base_url) === domain.toLowerCase() && p.enabled);
  }

  /** mm-gateway's rule: the domain in `allow_backends`, a tag in common, or an open key. */
  allowed(key: MockKey, proxy: MockProxy): boolean {
    const domain = hostOf(proxy.base_url);
    if (key.deny_tags.includes(domain)) return false;
    const open = !key.allow_tags.length && !key.allow_backends.length;
    return open || key.allow_backends.includes(domain) || proxy.tags.some((t) => key.allow_tags.includes(t));
  }
}
